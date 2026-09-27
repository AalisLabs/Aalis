// ============================================================
// Cloudflare Pages 客户端：Direct Upload 部署、部署的查询与删除、项目设置、域名、token 核验。
//
// 协议对照本机 npx 缓存里 wrangler 4.141.0 的 `pages deploy` 源码核对（只读源码，不装、不跑），与 2026-09-27
// 在临时项目上用自写客户端的实测一致：
// 1. `GET /accounts/{账号}/pages/projects/{项目}/upload-token`（API token）→ result.jwt。JWT 有效 30 分钟，
//    只在内存里用。
// 2. `POST /pages/assets/check-missing`（JWT），body `{ hashes: [...] }` → result 为缺的键。
// 3. `POST /pages/assets/upload`（JWT），body 为 JSON 数组，每项 `{ key, value: <base64>, metadata: { contentType },
//    base64: true }`。wrangler 按大小降序轮流分进 3 个桶（每桶不超过 40 MiB、2000 个文件）并发上传；这里按顺序
//    装满一批再开下一批（同样的两个上限），并发 3。
// 4. `POST /pages/assets/upsert-hashes`（JWT），body `{ hashes: [...] }`。失败只影响下次的跳过，wrangler 只告警，
//    这里同样只告警。
// 5. `POST /accounts/{账号}/pages/projects/{项目}/deployments`（API token），multipart：`manifest`（JSON 字符串，
//    路径以 `/` 开头 → 键）、`branch`、`_headers`（名为 `_headers` 的文件）；带中间件时另加 `_worker.bundle`：
//    一个文件，内容本身又是一份 multipart（wrangler 用 `new Response(formData).blob()` 生成，外层不带类型，
//    服务端从内容第一行读边界），里面是 `metadata`（`{"main_module":"_worker.js"}`，不带绑定）与名为
//    `_worker.js`、类型 `application/javascript+module` 的模块。wrangler 还会发 commit_*、`_redirects`、
//    `_routes.json` 与 functions 的路由配置，这里都不用。
// 6. 轮询 `GET .../deployments/{id}` 到 latest_stage 为 deploy 阶段的 success（failure、canceled 或超时按失败）。
// wrangler 4.141 的「Pages 转交 Workers」只在代理运行 CLI、目标项目不存在时发生，与直接调 API 无关。
//
// 重试（wrangler 的做法是：check-missing 与 upload 各 5 次、指数退避，建部署只在 8000000 时重试）：
// - 429 一律按 Retry-After 退避后重试（请求没被处理）；API 每 5 分钟 1200 次（实测响应头），平时按每秒 3 次的
//   令牌桶发。
// - 5xx、408 与网络错误只重试幂等的请求（GET、DELETE、PATCH 与资产接口），短退避、共 3 次；更长的退避与让位给
//   撤下由部署编排做。建部署不重试：请求可能已经建成部署，调用方按 nonce 认领（见 deploy()）。
// - 资产接口回 401：同一次部署里重取 JWT 一次；仍被拒按鉴权失败报。
//
// 凭据：token 只进发往 API 的 Authorization 头，上传 JWT 只进发往资产接口的 Authorization 头，账号 ID 只进请求
// 路径。错误与日志里只写固定的端点称呼，不写网址、请求头、manifest 与资产键；Cloudflare 回的错误体先去掉
// token、JWT、账号 ID 的片段与 32 位以上的十六进制串，再截到 500 字（写法照 Cursor 插件的 redactFragments）。
// 部署详情里的 files（路径 → 键）只把路径交给调用方。
//
// API 基址、别名与哈希网址的主机后缀与协议写死（`https://api.cloudflare.com/client/v4`、`.<项目名>.pages.dev`、
// https），测试经构造参数注入，不做成配置项：模型能改的地址会成为外泄口。所有 fetch 都带 signal。
// ============================================================

import type { Logger } from '@aalis/core';
import { assetKey } from './hash.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';
/** Pages 的单文件上限（实测：多 1 字节时上传回 500 和一张 HTML 错误页） */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** 每次部署的文件数上限（实测：上传 JWT 的 max_file_count_allowed） */
const MAX_FILES = 20_000;
const BATCH_BYTES = 40 * 1024 * 1024;
const BATCH_FILES = 2000;
const UPLOAD_CONCURRENCY = 3;
const DEFAULT_RATE_PER_SECOND = 3;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_DEPLOY_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
/** 5xx、408 与网络错误：幂等请求共试这么多次 */
const TRANSIENT_ATTEMPTS = 3;
/** 429 最多退避这么多次 */
const MAX_RATE_LIMITED = 5;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const RETRY_AFTER_CAP_MS = 5 * 60_000;
/** 部署列表每页条数与最多页数 */
const PER_PAGE = 25;
const MAX_PAGES = 100;
const MAX_DETAIL_CHARS = 500;
/** 错误体先截到这么长再去凭据（控制去片段的开销），去完再截到 MAX_DETAIL_CHARS */
const MAX_SCRUB_CHARS = 20_000;
const MIN_SECRET_FRAGMENT = 8;
const WORKER_MODULE = '_worker.js';

const ACCOUNT_PATTERN = /^[0-9a-f]{32}$/;
/** 能原样放进请求头的可见 ASCII */
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-]{0,57}$/;
const BRANCH_PATTERN = /^[\x21-\x7e]{1,128}$/;
const LABEL_PATTERN = /^[a-z0-9-]{1,63}$/;
const DEPLOYMENT_ID_PATTERN = /^[0-9a-f][0-9a-f-]{7,63}$/;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** Pages 的特殊文件：不能作为资产出现在 manifest 里 */
const RESERVED_PATHS = new Set(['/_headers', '/_redirects', '/_worker.js', '/_routes.json']);

const JWT_LIKE = /eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}/g;
/** 资产键、账号 ID 这类长十六进制串 */
const HEX_RUN = /[0-9a-fA-F]{32,}/g;
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]*)\?[^\s"'<>]*/gi;

export type PagesErrorKind =
  /** 401、403，或凭据格式不对（没发请求） */
  | 'auth'
  /** 429 退避用完 */
  | 'rate-limited'
  /** 5xx、408、网络错误、超时 */
  | 'transient'
  | 'not-found'
  /** 其余 4xx（如删除被拒） */
  | 'rejected'
  /** 本地先挡：文件过大、过多、路径不合规，没发请求 */
  | 'invalid'
  /** 部署以 failure、canceled 结束或超时未完成 */
  | 'deploy-failed'
  /** 2xx 但返回的形状不对 */
  | 'unexpected';

export class PagesApiError extends Error {
  readonly kind: PagesErrorKind;
  readonly status: number | undefined;
  /** Cloudflare 的错误码 */
  readonly code: number | undefined;

  constructor(kind: PagesErrorKind, message: string, detail: { status?: number; code?: number } = {}) {
    super(message);
    this.name = 'PagesApiError';
    this.kind = kind;
    this.status = detail.status;
    this.code = detail.code;
  }
}

export interface PagesClientOptions {
  accountId: string;
  apiToken: string;
  projectName: string;
  logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  /** 插件这次激活的取消信号：所有请求与等待都受它约束 */
  signal: AbortSignal;
  /** 测试注入；缺省为 Cloudflare API */
  apiBase?: string;
  /** 测试注入；缺省为 `.<项目名>.pages.dev` */
  hostSuffix?: string;
  /** 测试注入；缺省为 https */
  protocol?: 'https:' | 'http:';
  /** 每秒请求数；缺省 3 */
  ratePerSecond?: number;
  /** 幂等请求重试的退避起点；缺省 1 秒 */
  retryBaseMs?: number;
  /** 轮询部署状态的间隔；缺省 2 秒 */
  pollIntervalMs?: number;
  /** 部署完成的时限；缺省 5 分钟 */
  deployTimeoutMs?: number;
}

export interface DeployFile {
  /** 以 `/` 开头；每段只含字母、数字、点、下划线与连字符 */
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

interface DeployInput {
  branch: string;
  files: readonly DeployFile[];
  /** `_headers` 的内容 */
  headers?: string;
  /** `_worker.js` 模块的源码（高级模式中间件） */
  worker?: string;
  /** 资产键的本机盐 */
  assetSalt: string;
}

export interface PagesDeployment {
  id: string;
  environment: 'production' | 'preview';
  branch?: string;
  createdOn?: number;
  /** 哈希网址（未校验；用 hashOriginOf 取校验过的源） */
  url?: string;
  stage: { name: string; status: string };
  /** 别名网址（未校验；用 aliasOf 取校验过的） */
  aliases: string[];
  /** 只在部署详情里有：这次部署的全部路径（不带资产键） */
  paths?: string[];
}

interface PagesProject {
  name: string;
  productionBranch: string;
  subdomain: string;
  /** 项目对象里的 domains（含 <项目>.pages.dev） */
  domains: string[];
  deploymentConfigs: { production: Readonly<Record<string, unknown>>; preview: Readonly<Record<string, unknown>> };
}

interface TokenStatus {
  /** 过了哪个核验端点：账号级 token 走 /accounts/{账号}/tokens/verify，用户 token 走 /user/tokens/verify */
  kind: 'account' | 'user';
  status: string;
  /** 没有即不过期 */
  expiresOn?: number;
}

type AliasCheck = { ok: true; label: string; host: string; origin: string } | { ok: false; reason: string };

interface Sent {
  status: number;
  data: unknown;
}

/** 一次部署里的上传 JWT：当前的一个，是否已重取过，发过的全部（部署结束后从去凭据名单里移走） */
interface JwtSession {
  current: Promise<string>;
  refreshed: boolean;
  issued: string[];
}

type Json = Record<string, unknown>;

const enc = encodeURIComponent;

function asRecord(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function timeOf(value: unknown): number | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** 远端给的状态词只收小写字母与下划线，其余写成「?」 */
function word(value: unknown): string {
  return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : '?';
}

function short(id: string): string {
  return id.slice(0, 8);
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message ? `${err.message}（${cause.message}）` : err.message;
}

/**
 * 去掉文本里 secret 的片段：从每个位置起取能在 secret 里找到的最长子串，长度够 {@link MIN_SECRET_FRAGMENT}
 * 就整段换掉。远端可能在错误信息里回显凭据的一段，只替换整串挡不住。
 */
function redactFragments(text: string, secret: string): string {
  if (secret.length < MIN_SECRET_FRAGMENT) return secret ? text.split(secret).join('<已去除>') : text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    let len = 0;
    while (i + len < text.length && secret.includes(text.slice(i, i + len + 1))) len++;
    if (len >= MIN_SECRET_FRAGMENT) {
      out += '<已去除>';
      i += len;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** 两种错误体都认：Cloudflare 的 `{ errors: [{ code, message }] }` 与非 JSON 的整段文字（如 HTML 错误页） */
function remoteError(data: unknown): { code?: number; message?: string } {
  if (typeof data === 'string') return { message: data.replace(/\s+/g, ' ').trim() };
  const first = asRecord(asArray(asRecord(data).errors)[0]);
  const code = typeof first.code === 'number' && Number.isFinite(first.code) ? first.code : undefined;
  return { code, message: str(first.message) };
}

/** Retry-After 可以是秒数或 HTTP 日期；没有时按 60 秒；最多等 5 分钟 */
function retryAfterMs(headers: Headers): number {
  const raw = headers.get('retry-after');
  let ms = DEFAULT_RETRY_AFTER_MS;
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
    else {
      const at = Date.parse(raw);
      if (Number.isFinite(at)) ms = Math.max(0, at - Date.now());
    }
  }
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 部署里的文件路径不合规时给原因（不回显路径） */
function pathProblem(path: string): string | undefined {
  if (!path.startsWith('/')) return '不以 / 开头';
  const segments = path.slice(1).split('/');
  if (segments.some(s => !PATH_SEGMENT.test(s))) return '含空段或不允许的字符';
  if (segments.some(s => s === '.' || s === '..')) return '含点段';
  if (RESERVED_PATHS.has(path)) return '是 Pages 的特殊文件名';
  return undefined;
}

/** 路径最后一段的扩展名（小写、不带点）；没有时为空串 */
function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function parseDeployment(raw: unknown, withPaths: boolean): PagesDeployment | undefined {
  const r = asRecord(raw);
  const id = str(r.id);
  if (!id || !DEPLOYMENT_ID_PATTERN.test(id)) return undefined;
  const stage = asRecord(r.latest_stage);
  const d: PagesDeployment = {
    id,
    environment: r.environment === 'production' ? 'production' : 'preview',
    stage: { name: word(stage.name), status: word(stage.status) },
    aliases: asArray(r.aliases).filter((a): a is string => typeof a === 'string'),
  };
  const branch = str(asRecord(asRecord(r.deployment_trigger).metadata).branch);
  if (branch !== undefined) d.branch = branch;
  const createdOn = timeOf(r.created_on);
  if (createdOn !== undefined) d.createdOn = createdOn;
  const url = str(r.url);
  if (url) d.url = url;
  if (withPaths && r.files !== null && typeof r.files === 'object') d.paths = Object.keys(r.files as Json);
  return d;
}

function parseProject(raw: unknown): PagesProject {
  const r = asRecord(raw);
  const configs = asRecord(r.deployment_configs);
  return {
    name: str(r.name) ?? '',
    productionBranch: str(r.production_branch) ?? '',
    subdomain: str(r.subdomain) ?? '',
    domains: asArray(r.domains).filter((d): d is string => typeof d === 'string'),
    deploymentConfigs: { production: asRecord(configs.production), preview: asRecord(configs.preview) },
  };
}

async function workerBundle(source: string): Promise<Blob> {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: WORKER_MODULE }));
  form.set(WORKER_MODULE, new File([source], WORKER_MODULE, { type: 'application/javascript+module' }));
  return new Response(form).blob();
}

/** 按顺序装满一批再开下一批：每批不超过 BATCH_FILES 个、BATCH_BYTES 字节 */
function batches<T extends { bytes: Uint8Array }>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && (current.length >= BATCH_FILES || size + item.bytes.byteLength > BATCH_BYTES)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.bytes.byteLength;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** 最多 limit 个并发地逐个处理；有一个失败就不再取新的，等在跑的结束后抛出 */
async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** 令牌桶：容量与每秒补充数都是 rate */
class RateGate {
  readonly #rate: number;
  #tokens: number;
  #last = Date.now();

  constructor(rate: number) {
    this.#rate = rate;
    this.#tokens = rate;
  }

  async take(signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#tokens = Math.min(this.#rate, this.#tokens + ((now - this.#last) / 1000) * this.#rate);
      this.#last = now;
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.#tokens) / this.#rate) * 1000), signal);
    }
  }
}

export class PagesClient {
  readonly #accountId: string;
  readonly #token: string;
  readonly #project: string;
  readonly #log: Pick<Logger, 'debug' | 'info' | 'warn'>;
  readonly #life: AbortSignal;
  readonly #base: string;
  readonly #suffix: string;
  readonly #protocol: 'https:' | 'http:';
  readonly #gate: RateGate;
  readonly #retryBaseMs: number;
  readonly #pollMs: number;
  readonly #deployTimeoutMs: number;
  /** 凭据格式不对时的原因：每个调用都按鉴权失败报、不发请求 */
  readonly #credentialProblem: string | undefined;
  /** 进行中的部署拿到的上传 JWT（只用来从错误信息里去掉它们） */
  readonly #jwts = new Set<string>();

  constructor(opts: PagesClientOptions) {
    if (!PROJECT_PATTERN.test(opts.projectName)) throw new Error('Pages 项目名不合规');
    const suffix = opts.hostSuffix ?? `.${opts.projectName}.pages.dev`;
    if (!suffix.startsWith('.')) throw new Error('主机后缀须以点开头');
    this.#accountId = opts.accountId;
    this.#token = opts.apiToken;
    this.#project = opts.projectName;
    this.#log = opts.logger;
    this.#life = opts.signal;
    this.#base = (opts.apiBase ?? API_BASE).replace(/\/+$/, '');
    this.#suffix = suffix;
    this.#protocol = opts.protocol ?? 'https:';
    this.#gate = new RateGate(opts.ratePerSecond ?? DEFAULT_RATE_PER_SECOND);
    this.#retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#deployTimeoutMs = opts.deployTimeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS;
    this.#credentialProblem = !ACCOUNT_PATTERN.test(opts.accountId)
      ? '账号 ID 格式不对（应为 32 位十六进制）'
      : !HEADER_SAFE.test(opts.apiToken)
        ? 'token 含有不能放进请求头的字符'
        : undefined;
  }

  /**
   * 部署的第 1 到 5 步：上传缺的资产、建部署，返回刚建好的部署（通常还在 queued）。之后用 waitForDeployment 等它完成。
   *
   * 建部署那一步失败（含网络错误与 5xx）时部署可能已经建成：调用方按这次部署独有的文件（如 `/v/<nonce>.txt`）
   * 在部署列表里认领，不要直接重发。
   */
  async deploy(input: DeployInput, signal?: AbortSignal): Promise<PagesDeployment> {
    this.#checkCredentials();
    this.#checkInput(input);
    // 逐个算：每次 HMAC 都要把内容拷进一块新缓冲，并发算会让所有拷贝同时占着内存
    const keyed: Array<DeployFile & { key: string }> = [];
    for (const f of input.files) keyed.push({ ...f, key: await assetKey(input.assetSalt, extOf(f.path), f.bytes) });
    const unique = new Map(keyed.map(f => [f.key, f]));
    const session: JwtSession = { current: Promise.resolve(''), refreshed: false, issued: [] };
    session.current = this.#fetchJwt(session, signal);
    let uploadCount = 0;
    let batchCount = 0;
    try {
      const missing = await this.#checkMissing(session, [...unique.keys()], signal);
      const toUpload = [...unique.values()].filter(f => missing.has(f.key));
      const groups = batches(toUpload);
      uploadCount = toUpload.length;
      batchCount = groups.length;
      await runPool(groups, UPLOAD_CONCURRENCY, group =>
        this.#asset(
          session,
          '上传资产',
          '/pages/assets/upload',
          group.map(f => ({
            key: f.key,
            value: Buffer.from(f.bytes).toString('base64'),
            metadata: { contentType: f.contentType },
            base64: true,
          })),
          signal,
          UPLOAD_TIMEOUT_MS,
        ).then(() => undefined),
      );
      try {
        await this.#asset(session, '登记资产', '/pages/assets/upsert-hashes', { hashes: [...unique.keys()] }, signal);
      } catch (err) {
        if (!(err instanceof PagesApiError)) throw err;
        this.#log.warn(`Cloudflare：登记资产失败，只影响下次部署跳过已有文件：${err.message}`);
      }
    } finally {
      await session.current.catch(() => undefined);
      for (const jwt of session.issued) this.#jwts.delete(jwt);
    }
    this.#log.debug(
      `Cloudflare：分支 ${input.branch} 共 ${input.files.length} 个文件，上传 ${uploadCount} 个（${batchCount} 批）`,
    );

    const form = new FormData();
    form.append('manifest', JSON.stringify(Object.fromEntries(keyed.map(f => [f.path, f.key]))));
    form.append('branch', input.branch);
    if (input.headers !== undefined) form.append('_headers', new File([input.headers], '_headers'));
    if (input.worker !== undefined) {
      form.append('_worker.bundle', new File([await workerBundle(input.worker)], '_worker.bundle'));
    }
    const label = '建部署';
    const sent = await this.#api(label, 'POST', this.#projectPath('/deployments'), {
      body: form,
      signal,
      idempotent: false,
    });
    const deployment = parseDeployment(this.#ok(label, sent).result, false);
    if (!deployment) throw new PagesApiError('unexpected', `Cloudflare：${label}的返回里没有有效的部署 id`);
    this.#log.debug(`Cloudflare：已建部署 ${short(deployment.id)}（分支 ${input.branch}）`);
    return deployment;
  }

  /** 部署的第 6 步：轮询到 deploy 阶段 success；failure、canceled 或超过时限按失败报 */
  async waitForDeployment(id: string, signal?: AbortSignal): Promise<PagesDeployment> {
    const deadline = Date.now() + this.#deployTimeoutMs;
    for (;;) {
      const d = await this.getDeployment(id, signal);
      const { name, status } = d.stage;
      if (name === 'deploy' && status === 'success') return d;
      if (status === 'failure' || status === 'canceled') {
        throw new PagesApiError('deploy-failed', `Cloudflare：部署 ${short(id)} 在 ${name} 阶段以 ${status} 结束`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new PagesApiError(
          'deploy-failed',
          `Cloudflare：部署 ${short(id)} 在 ${Math.round(this.#deployTimeoutMs / 1000)} 秒内没有完成（停在 ${name} 阶段）`,
        );
      }
      await sleep(Math.min(this.#pollMs, left), this.#signal(signal));
    }
  }

  /** 部署详情（含路径列表） */
  async getDeployment(id: string, signal?: AbortSignal): Promise<PagesDeployment> {
    this.#checkCredentials();
    if (!DEPLOYMENT_ID_PATTERN.test(id)) throw new PagesApiError('invalid', 'Cloudflare：部署 id 格式不对');
    const label = `查部署 ${short(id)}`;
    const sent = await this.#api(label, 'GET', this.#projectPath(`/deployments/${enc(id)}`), { signal });
    const d = parseDeployment(this.#ok(label, sent).result, true);
    if (!d || d.id !== id) throw new PagesApiError('unexpected', `Cloudflare：${label}的返回不对`);
    return d;
  }

  /** 全部部署（新的在前，取完所有页）；有一项认不出就整体按失败报，不把取到的一部分当完整列表 */
  async listDeployments(signal?: AbortSignal): Promise<PagesDeployment[]> {
    this.#checkCredentials();
    const label = '列部署';
    const seen = new Map<string, PagesDeployment>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const sent = await this.#api(label, 'GET', this.#projectPath(`/deployments?page=${page}&per_page=${PER_PAGE}`), {
        signal,
      });
      const envelope = this.#ok(label, sent);
      const items = asArray(envelope.result);
      for (const raw of items) {
        const d = parseDeployment(raw, false);
        if (!d) throw new PagesApiError('unexpected', `Cloudflare：${label}的第 ${page} 页有认不出的项`);
        if (!seen.has(d.id)) seen.set(d.id, d);
      }
      const totalPages = asRecord(envelope.result_info).total_pages;
      const last =
        items.length === 0 || (typeof totalPages === 'number' ? page >= totalPages : items.length < PER_PAGE);
      if (last) return [...seen.values()];
    }
    throw new PagesApiError('unexpected', `Cloudflare：${label}超过 ${MAX_PAGES} 页，取不全`);
  }

  /**
   * 删除部署。分支最新的一份要 force（不带时 Cloudflare 回 400）；当前生产部署带 force 也删不掉（400）；
   * 两者都报 rejected。已经不在的回 not-found（重试时前一次可能已删掉）。
   */
  async deleteDeployment(id: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    this.#checkCredentials();
    if (!DEPLOYMENT_ID_PATTERN.test(id)) throw new PagesApiError('invalid', 'Cloudflare：部署 id 格式不对');
    const label = `删除部署 ${short(id)}`;
    const query = opts.force ? '?force=true' : '';
    const sent = await this.#api(label, 'DELETE', this.#projectPath(`/deployments/${enc(id)}${query}`), {
      signal: opts.signal,
    });
    if (sent.status === 400) {
      const why = opts.force ? '不能删，多半是当前生产部署' : '被拒绝，分支最新的一份要带 force';
      throw this.#httpError(`${label}（${why}）`, sent);
    }
    this.#ok(label, sent);
  }

  async getProject(signal?: AbortSignal): Promise<PagesProject> {
    this.#checkCredentials();
    const label = '读项目';
    return parseProject(this.#ok(label, await this.#api(label, 'GET', this.#projectPath(''), { signal })).result);
  }

  /** production 与 preview 两套的 fail_open 一起改 */
  async setFailOpen(value: boolean, signal?: AbortSignal): Promise<PagesProject> {
    this.#checkCredentials();
    const label = '改项目设置';
    const body = JSON.stringify({
      deployment_configs: { production: { fail_open: value }, preview: { fail_open: value } },
    });
    const sent = await this.#api(label, 'PATCH', this.#projectPath(''), { body, json: true, signal });
    return parseProject(this.#ok(label, sent).result);
  }

  /** domains 端点列出的域名 */
  async listDomains(signal?: AbortSignal): Promise<string[]> {
    this.#checkCredentials();
    const label = '列域名';
    const sent = await this.#api(label, 'GET', this.#projectPath('/domains'), { signal });
    return asArray(this.#ok(label, sent).result)
      .map(d => str(asRecord(d).name))
      .filter((n): n is string => n !== undefined);
  }

  /** 先按账号级 token 核验，被拒（401、403）再按用户 token 核验；两处都被拒按鉴权失败报 */
  async verifyToken(signal?: AbortSignal): Promise<TokenStatus> {
    this.#checkCredentials();
    const label = '核验 token';
    const account = await this.#api(label, 'GET', `/accounts/${this.#accountId}/tokens/verify`, { signal });
    if (account.status !== 401 && account.status !== 403) {
      return this.#tokenStatus('account', this.#ok(label, account).result);
    }
    const user = await this.#api(label, 'GET', '/user/tokens/verify', { signal });
    return this.#tokenStatus('user', this.#ok(label, user).result);
  }

  /**
   * 分支部署的别名：恰好一个，形如 `<协议>//<一段><主机后缀>`，那一段匹配 `^[a-z0-9-]{1,63}$`，不带路径、查询串与
   * 用户信息，写法与规范形式一致。它会写进主站的 CSP、`_headers` 与包装页，只收校验过的值。
   */
  aliasOf(d: PagesDeployment): AliasCheck {
    if (d.aliases.length !== 1) {
      return { ok: false, reason: d.aliases.length === 0 ? '部署返回里没有别名' : '部署返回里有不止一个别名' };
    }
    return this.#checkOrigin(d.aliases[0]);
  }

  /** 部署的哈希网址（同一套校验）；不合格时 undefined */
  hashOriginOf(d: PagesDeployment): string | undefined {
    if (d.url === undefined) return undefined;
    const check = this.#checkOrigin(d.url);
    return check.ok ? check.origin : undefined;
  }

  #checkOrigin(raw: string): AliasCheck {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: '不是网址' };
    }
    if (url.protocol !== this.#protocol) return { ok: false, reason: '协议不对' };
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return { ok: false, reason: '带了路径、查询串或用户信息' };
    }
    if (!url.host.endsWith(this.#suffix)) return { ok: false, reason: '主机后缀不对' };
    const label = url.host.slice(0, -this.#suffix.length);
    if (!LABEL_PATTERN.test(label)) return { ok: false, reason: '别名段不合规' };
    const origin = `${url.protocol}//${url.host}`;
    if (raw !== origin && raw !== `${origin}/`) return { ok: false, reason: '写法与规范形式不一致' };
    return { ok: true, label, host: url.host, origin };
  }

  #tokenStatus(kind: TokenStatus['kind'], raw: unknown): TokenStatus {
    const r = asRecord(raw);
    const out: TokenStatus = { kind, status: word(r.status) };
    const expiresOn = timeOf(r.expires_on);
    if (expiresOn !== undefined) out.expiresOn = expiresOn;
    return out;
  }

  #checkCredentials(): void {
    if (this.#credentialProblem) throw new PagesApiError('auth', `Cloudflare：${this.#credentialProblem}`);
  }

  #checkInput(input: DeployInput): void {
    const invalid = (why: string) => new PagesApiError('invalid', `Cloudflare：${why}，没有部署`);
    if (!BRANCH_PATTERN.test(input.branch)) throw invalid('分支名不合规');
    if (input.files.length > MAX_FILES) throw invalid(`一次部署最多 ${MAX_FILES} 个文件`);
    const seen = new Set<string>();
    for (const [i, f] of input.files.entries()) {
      const problem = pathProblem(f.path);
      if (problem) throw invalid(`第 ${i + 1} 个文件的路径${problem}`);
      if (seen.has(f.path)) throw invalid(`第 ${i + 1} 个文件的路径与前面的重复`);
      seen.add(f.path);
      if (f.bytes.byteLength > MAX_ASSET_BYTES) throw invalid(`第 ${i + 1} 个文件超过 25 MiB`);
    }
  }

  #projectPath(rest: string): string {
    return `/accounts/${this.#accountId}/pages/projects/${enc(this.#project)}${rest}`;
  }

  async #fetchJwt(session: JwtSession, signal: AbortSignal | undefined): Promise<string> {
    const label = '取上传凭据';
    const sent = await this.#api(label, 'GET', this.#projectPath('/upload-token'), { signal });
    const jwt = str(asRecord(this.#ok(label, sent).result).jwt);
    if (!jwt || !JWT_PATTERN.test(jwt)) throw new PagesApiError('unexpected', `Cloudflare：${label}的返回不对`);
    this.#jwts.add(jwt);
    session.issued.push(jwt);
    return jwt;
  }

  async #checkMissing(session: JwtSession, keys: string[], signal: AbortSignal | undefined): Promise<Set<string>> {
    const label = '查缺失资产';
    const result = (await this.#asset(session, label, '/pages/assets/check-missing', { hashes: keys }, signal)).result;
    if (!Array.isArray(result)) throw new PagesApiError('unexpected', `Cloudflare：${label}的返回不对`);
    return new Set(result.filter((k): k is string => typeof k === 'string'));
  }

  /** 资产接口：认上传 JWT；回 401 时同一次部署里重取一次 JWT 再试 */
  async #asset(
    session: JwtSession,
    label: string,
    path: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Json> {
    const body = JSON.stringify(payload);
    const send = (jwt: string) =>
      this.#send(
        label,
        `${this.#base}${path}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          body,
        },
        { signal, idempotent: true, timeoutMs },
      );
    const jwt = await session.current;
    let sent = await send(jwt);
    if (sent.status === 401) {
      if (!session.refreshed) {
        session.refreshed = true;
        session.current = this.#fetchJwt(session, signal);
      }
      const fresh = await session.current;
      if (fresh !== jwt) sent = await send(fresh);
    }
    return this.#ok(label, sent);
  }

  /** API 端点：认 API token */
  async #api(
    label: string,
    method: string,
    path: string,
    opts: { signal?: AbortSignal; body?: string | FormData; json?: boolean; idempotent?: boolean },
  ): Promise<Sent> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' };
    if (opts.json) headers['Content-Type'] = 'application/json';
    return this.#send(
      label,
      `${this.#base}${path}`,
      { method, headers, ...(opts.body !== undefined ? { body: opts.body } : {}) },
      { signal: opts.signal, idempotent: opts.idempotent ?? true, timeoutMs: REQUEST_TIMEOUT_MS },
    );
  }

  async #send(
    label: string,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string | FormData },
    opts: { signal: AbortSignal | undefined; idempotent: boolean; timeoutMs: number },
  ): Promise<Sent> {
    const outer = this.#signal(opts.signal);
    let limited = 0;
    let failures = 0;
    for (;;) {
      await this.#gate.take(outer);
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.any([outer, timeout]) });
        text = await res.text();
      } catch (err) {
        outer.throwIfAborted();
        if (opts.idempotent && ++failures < TRANSIENT_ATTEMPTS) {
          await sleep(this.#retryBaseMs * 2 ** (failures - 1), outer);
          continue;
        }
        const why = timeout.aborted ? '超时' : `失败：${errorText(err)}`;
        throw new PagesApiError('transient', `Cloudflare：${label}${this.#scrub(why)}`);
      }
      if (res.status === 429 && ++limited <= MAX_RATE_LIMITED) {
        const wait = retryAfterMs(res.headers);
        this.#log.debug(`Cloudflare：${label}被限速，${Math.ceil(wait / 1000)} 秒后重试`);
        await sleep(wait, outer);
        continue;
      }
      if ((res.status >= 500 || res.status === 408) && opts.idempotent && ++failures < TRANSIENT_ATTEMPTS) {
        await sleep(this.#retryBaseMs * 2 ** (failures - 1), outer);
        continue;
      }
      return { status: res.status, data: text === '' ? undefined : parseJson(text) };
    }
  }

  /** 2xx 且 success 不为 false 时给出整个信封（result、result_info）；否则按状态码抛 */
  #ok(label: string, sent: Sent): Json {
    const envelope = asRecord(sent.data);
    if (sent.status >= 200 && sent.status < 300 && envelope.success !== false) return envelope;
    throw this.#httpError(label, sent);
  }

  #httpError(label: string, sent: Sent): PagesApiError {
    const { code, message } = remoteError(sent.data);
    const detail = message ? `：${this.#scrub(message.slice(0, MAX_SCRUB_CHARS)).slice(0, MAX_DETAIL_CHARS)}` : '';
    const text = `Cloudflare：${label}返回 ${sent.status}${code !== undefined ? ` ${code}` : ''}${detail}`;
    const status = sent.status;
    const kind: PagesErrorKind =
      status === 401 || status === 403
        ? 'auth'
        : status === 404
          ? 'not-found'
          : status === 429
            ? 'rate-limited'
            : status >= 500 || status === 408
              ? 'transient'
              : status >= 200 && status < 300
                ? 'unexpected'
                : 'rejected';
    return new PagesApiError(kind, text, { status, ...(code !== undefined ? { code } : {}) });
  }

  #signal(signal: AbortSignal | undefined): AbortSignal {
    return signal ? AbortSignal.any([signal, this.#life]) : this.#life;
  }

  #scrub(text: string): string {
    let out = text
      .replace(JWT_LIKE, '<凭据已去除>')
      .replace(HEX_RUN, '<已去除>')
      .replace(URL_QUERY, '$1?<查询串已去除>');
    for (const secret of [this.#token, this.#accountId, ...this.#jwts]) out = redactFragments(out, secret);
    return out;
  }
}
