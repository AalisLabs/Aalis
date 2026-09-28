import { randomBytes, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

// ════════════════════════════════════════════════════════════
// Cloudflare Pages（Direct Upload）API 的本机假服务：照 2026-09-27 在临时项目上的实测
// （works-site-20260927/pretest.md）回应各端点。只用于测试，不连真实账号。
//
// 站点按 Host 分发，使用同一份部署清单和资产存储；只监听本机。
//
// - 基址：`<origin>/client/v4`，与真实 API 同一前缀。API 端点认 `Authorization: Bearer <token>`（tokens 里登记，
//   且路径里的账号须与登记的一致）；资产端点只认上传 JWT，拿 API token 去调一律 401，反之亦然。错误信息里回显
//   凭据的一段（真实服务不回显；这里用来检验客户端把它去掉了）。
// - 上传 JWT：形如 `eyJ…`，声明里有 exp 与 max_file_count_allowed（实测 20000）；jwtTtlMs 可调，expireJwts()
//   让已发的全部失效。过期回 401、错误码 8000013。
// - 资产存储按实测：不核对键与内容；同一个键以第一次写入为准；键只要求 32 位十六进制。解码后超过 25 MiB 的
//   上传回 500 和一张 HTML 错误页（实测形状）。
// - 建部署：解析 multipart（manifest、branch、_headers、_worker.bundle；_worker.bundle 本身又是一份 multipart，
//   边界从内容第一行读）。manifest 里引用了存储里没有的键回 400。建好时 latest_stage 为 queued，queuedMs 之后变
//   success；nextOutcomes 可让某一次以 failure 结束或一直 queued。
// - 别名按实测：小写、非字母数字换连字符、去开头连字符、超过 28 个字符截断，与别的分支已占的别名冲突时加 4 位
//   随机后缀；含非 ASCII 的分支名得到 `branch-<10 位随机>`。别名只出现在分支最新、且没被更新的部署覆盖过的那份
//   部署上（强制删掉最新部署后回退到的旧部署，aliases 仍是 null，实测）。生产部署没有别名。别名与哈希网址以
//   `http://<名>.<项目名>.localhost:<端口>` 形式返回；aliasFor 可以改成任意字符串（造不合格的别名）。
// - 删除：分支最新的部署不带 force 回 400（8000035，实测）；当前生产部署一律 400（带 force 也删不掉，实测；错误码
//   未实测，这里用 8000034）；带 force 删分支最新的部署后，别名回退到同分支更早的一份。
// - 部署列表：新的在前，page 从 1 起、per_page 缺省与上限都是 25，带 result_info；列表项不含 files。
// - 项目：deployment_configs 的 production、preview 两套，测试可以直接改 project 预置绑定字段与名单外字段；PATCH
//   按两层合并。domains 端点只列自定义域名，项目对象的 domains 另含 <项目>.pages.dev（推论，未实测）。
// - intercept：下一次（或 times 次）匹配的请求回脚本里的应答（429 带 Retry-After、5xx、401……），优先于默认处理。
// ════════════════════════════════════════════════════════════

export interface FakePagesRequest {
  method: string;
  /** pathname 加查询串 */
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface FakeAsset {
  bytes: Uint8Array;
  contentType: string;
}

export interface FakeWorkerBundle {
  metadata: Record<string, unknown>;
  /** 模块名 → 类型与源码 */
  modules: Record<string, { type: string; content: string }>;
}

export type FakeStageStatus = 'queued' | 'success' | 'failure';

export interface FakeDeployment {
  id: string;
  /** 8 位十六进制：哈希网址的名字 */
  shortId: string;
  branch: string;
  environment: 'production' | 'preview';
  createdAt: number;
  status: FakeStageStatus;
  /** 路径 → 资产键 */
  manifest: Record<string, string>;
  headers?: string;
  worker?: FakeWorkerBundle;
  /** 同分支上后来又建了部署：别名随之移走，这份的 aliases 从此为 null */
  superseded: boolean;
  deleted: boolean;
}

export interface FakeTokenInfo {
  /** 账号级 token 只过账号端点的核验，用户 token 只过 /user/tokens/verify（实测） */
  kind: 'user' | 'account';
  /** 缺省 active；disabled 时一律 401 */
  status?: string;
  /** ISO 时间；不写即不过期 */
  expiresOn?: string;
}

export interface FakeReply {
  status: number;
  /** 对象按 JSON 发；字符串原样发 */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeProject {
  name: string;
  production_branch: string;
  subdomain: string;
  deployment_configs: { production: Record<string, unknown>; preview: Record<string, unknown> };
  /** 测试预置的名单外顶层字段 */
  [key: string]: unknown;
}

export interface FakePages {
  /** `http://127.0.0.1:<端口>/client/v4` */
  apiBase: string;
  port: number;
  accountId: string;
  projectName: string;
  /** 别名与哈希网址的主机后缀：`.<项目名>.localhost:<端口>` */
  hostSuffix: string;
  /** API token → 信息 */
  tokens: Map<string, FakeTokenInfo>;
  requests: FakePagesRequest[];
  assets: Map<string, FakeAsset>;
  /** 按建成先后；删掉的标 deleted、不移出（站点部分要用） */
  deployments: FakeDeployment[];
  project: FakeProject;
  /** 自定义域名（domains 端点列这些） */
  customDomains: string[];
  /** 新部署保持 queued 的毫秒数 */
  queuedMs: number;
  /** 依次消费：下一次建部署的结局；缺省 success */
  nextOutcomes: Array<'success' | 'failure' | 'stuck'>;
  /** 上传 JWT 的有效期 */
  jwtTtlMs: number;
  /** 模拟边缘保留已缓存、后来从部署中删除的路径。 */
  edgeCache: boolean;
  /** 规范网址内容改变后仍返回旧内容的时长；新查询串绕过。 */
  contentLagMs: number;
  /** 模拟 Functions 额度用尽时跳过 Worker。 */
  workerQuotaExhausted: boolean;
  /** 按分支给出别名网址（返回 undefined 时按实测规则） */
  aliasFor?: (branch: string) => string | undefined;
  intercept(method: string, path: string | RegExp, reply: FakeReply, times?: number): void;
  /** 丢掉还没用完的 intercept */
  clearIntercepts(): void;
  /** 已发的上传 JWT 全部失效 */
  expireJwts(): void;
  /** 直接登记一份已完成的部署（不经 API），如组表之外分支上的账外部署 */
  seedDeployment(opts: {
    branch: string;
    manifest?: Record<string, string>;
    headers?: string;
    worker?: string;
    createdAt?: number;
  }): FakeDeployment;
  /** 分支当前的别名名字（第一次部署这个分支时分配） */
  aliasLabel(branch: string): string | undefined;
  requestsTo(method: string, path: string | RegExp): FakePagesRequest[];
  close(): Promise<void>;
}

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_FILE_COUNT = 20_000;
const PER_PAGE = 25;
const ALIAS_MAX = 28;
const API_PREFIX = '/client/v4';

const KEY_PATTERN = /^[0-9a-f]{32}$/;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

function ok(res: ServerResponse, result: unknown, extra: Record<string, unknown> = {}): void {
  send(res, 200, { success: true, errors: [], messages: [], result, ...extra });
}

function fail(res: ServerResponse, status: number, code: number, message: string): void {
  send(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function randomLabel(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(length)].map(b => alphabet[b % alphabet.length]).join('');
}

/** 实测的分支名到别名规则（冲突后缀另算） */
function aliasBase(branch: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 按 ASCII 范围判断
  if (/[^\x00-\x7f]/.test(branch)) return `branch-${randomLabel(10)}`;
  const base = branch
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-+/, '')
    .slice(0, ALIAS_MAX);
  return base || `branch-${randomLabel(10)}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function startFakePages(
  opts: { accountId?: string; projectName?: string; productionBranch?: string } = {},
): Promise<FakePages> {
  const accountId = opts.accountId ?? '0123456789abcdef0123456789abcdef';
  const projectName = opts.projectName ?? 'aalis';
  const intercepts: Array<{ method: string; path: string | RegExp; reply: FakeReply; left: number }> = [];
  const jwts = new Map<string, number>(); // jwt → 过期时刻
  const branchAlias = new Map<string, string>();
  const cachedPaths = new Map<string, { deploymentId: string; response: Response }>();
  const changedPaths = new Map<string, { until: number; prior: Response }>();
  const workerModules = new Map<
    string,
    { fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response> }
  >();
  const matches = (p: string | RegExp, path: string) => (typeof p === 'string' ? path === p : p.test(path));

  const fake: FakePages = {
    apiBase: '',
    port: 0,
    accountId,
    projectName,
    hostSuffix: '',
    tokens: new Map(),
    requests: [],
    assets: new Map(),
    deployments: [],
    project: {
      name: projectName,
      production_branch: opts.productionBranch ?? 'main',
      subdomain: `${projectName}.pages.dev`,
      deployment_configs: {
        production: {
          compatibility_date: '2026-09-27',
          compatibility_flags: [],
          fail_open: true,
          usage_model: 'standard',
          always_use_latest_compatibility_date: false,
          build_image_major_version: 3,
        },
        preview: {
          compatibility_date: '2026-09-27',
          compatibility_flags: [],
          fail_open: true,
          usage_model: 'standard',
          always_use_latest_compatibility_date: false,
          build_image_major_version: 3,
        },
      },
    },
    customDomains: [],
    queuedMs: 300,
    nextOutcomes: [],
    jwtTtlMs: 30 * 60_000,
    edgeCache: false,
    contentLagMs: 0,
    workerQuotaExhausted: false,
    intercept(method, path, reply, times = 1) {
      intercepts.push({ method, path, reply, left: times });
    },
    clearIntercepts() {
      intercepts.length = 0;
    },
    expireJwts() {
      for (const k of jwts.keys()) jwts.set(k, 0);
    },
    seedDeployment({ branch, manifest = {}, headers, worker, createdAt = Date.now() }) {
      return addDeployment(
        branch,
        manifest,
        headers,
        worker
          ? {
              metadata: { main_module: '_worker.js' },
              modules: { '_worker.js': { type: 'application/javascript', content: worker } },
            }
          : undefined,
        createdAt,
        'success',
      );
    },
    aliasLabel(branch) {
      return branchAlias.get(branch);
    },
    requestsTo(method, path) {
      return fake.requests.filter(r => r.method === method && matches(path, r.path.split('?')[0]));
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    },
  };

  const timers = new Set<ReturnType<typeof setTimeout>>();

  function assignAlias(branch: string): string {
    const existing = branchAlias.get(branch);
    if (existing) return existing;
    const taken = new Set(branchAlias.values());
    let label = aliasBase(branch);
    while (taken.has(label)) label = `${aliasBase(branch).slice(0, ALIAS_MAX - 5)}-${randomLabel(4)}`;
    branchAlias.set(branch, label);
    return label;
  }

  function addDeployment(
    branch: string,
    manifest: Record<string, string>,
    headers: string | undefined,
    worker: FakeWorkerBundle | undefined,
    createdAt: number,
    status: FakeStageStatus,
  ): FakeDeployment {
    const environment = branch === fake.project.production_branch ? 'production' : 'preview';
    for (const d of fake.deployments) if (d.branch === branch && !d.deleted) d.superseded = true;
    if (environment === 'preview') assignAlias(branch);
    const d: FakeDeployment = {
      id: randomUUID(),
      shortId: randomBytes(4).toString('hex'),
      branch,
      environment,
      createdAt,
      status,
      manifest,
      ...(headers !== undefined ? { headers } : {}),
      ...(worker ? { worker } : {}),
      superseded: false,
      deleted: false,
    };
    fake.deployments.push(d);
    return d;
  }

  function live(): FakeDeployment[] {
    return fake.deployments.filter(d => !d.deleted);
  }

  /** 分支上最新的一份（别名或生产域名此刻服务的部署） */
  function latestOf(branch: string): FakeDeployment | undefined {
    return live()
      .filter(d => d.branch === branch)
      .sort((a, b) => b.createdAt - a.createdAt || fake.deployments.indexOf(b) - fake.deployments.indexOf(a))[0];
  }

  function hostUrl(name: string): string {
    return `http://${name}${fake.hostSuffix}`;
  }

  function deploymentJson(d: FakeDeployment, withFiles: boolean): Record<string, unknown> {
    let aliases: string[] | null = null;
    if (d.environment === 'preview' && !d.superseded) {
      const custom = fake.aliasFor?.(d.branch);
      const label = branchAlias.get(d.branch);
      aliases = custom !== undefined ? [custom] : label ? [hostUrl(label)] : null;
    }
    const stage = {
      name: d.status === 'queued' ? 'queued' : 'deploy',
      status: d.status === 'queued' ? 'active' : d.status,
    };
    return {
      id: d.id,
      short_id: d.shortId,
      project_name: projectName,
      environment: d.environment,
      url: hostUrl(d.shortId),
      created_on: iso(d.createdAt),
      modified_on: iso(d.createdAt),
      latest_stage: {
        ...stage,
        started_on: iso(d.createdAt),
        ended_on: d.status === 'queued' ? null : iso(d.createdAt),
      },
      deployment_trigger: { type: 'ad_hoc', metadata: { branch: d.branch, commit_hash: '', commit_message: '' } },
      aliases,
      is_skipped: false,
      ...(withFiles ? { files: d.manifest } : {}),
    };
  }

  function projectJson(): Record<string, unknown> {
    return {
      id: 'project-0000',
      created_on: '2026-09-27T00:00:00.000Z',
      ...fake.project,
      domains: [fake.project.subdomain, ...fake.customDomains],
      source: null,
      build_config: {},
    };
  }

  function issueJwt(): string {
    const payload = { exp: Math.floor((Date.now() + fake.jwtTtlMs) / 1000), max_file_count_allowed: MAX_FILE_COUNT };
    const jwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ ...payload, n: randomUUID() })}.${randomBytes(24).toString('base64url')}`;
    jwts.set(jwt, Date.now() + fake.jwtTtlMs);
    return jwt;
  }

  function bearer(req: IncomingMessage): string {
    const auth = req.headers.authorization ?? '';
    return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  }

  /** 上传 JWT 有效时返回 true；否则已回 401 */
  function checkJwt(req: IncomingMessage, res: ServerResponse): boolean {
    const jwt = bearer(req);
    const exp = jwts.get(jwt);
    if (exp === undefined || exp <= Date.now()) {
      fail(res, 401, 8000013, `Unauthorized: invalid or expired upload token ${jwt.slice(0, 24)}`);
      return false;
    }
    return true;
  }

  /** API token 有效且可访问这个账号时返回它的信息；否则已回错误 */
  function checkToken(req: IncomingMessage, res: ServerResponse, account?: string): FakeTokenInfo | undefined {
    const token = bearer(req);
    const info = fake.tokens.get(token);
    if (!info || info.status === 'disabled' || (info.expiresOn && Date.parse(info.expiresOn) <= Date.now())) {
      fail(res, 401, 10000, `Authentication error: ${token.slice(0, 12)}`);
      return undefined;
    }
    if (account !== undefined && account !== accountId) {
      fail(res, 403, 9109, 'Unauthorized to access requested resource');
      return undefined;
    }
    return info;
  }

  async function parseMultipart(req: IncomingMessage, body: Buffer): Promise<FormData> {
    const type = req.headers['content-type'] ?? '';
    return new Request('http://fake/', {
      method: 'POST',
      headers: { 'content-type': type },
      body: new Uint8Array(body),
    }).formData();
  }

  async function parseBundle(file: Blob): Promise<FakeWorkerBundle> {
    const text = await file.text();
    const first = text.slice(0, text.indexOf('\r\n'));
    if (!first.startsWith('--')) throw new Error('bundle is not multipart');
    const inner = await new Response(text, {
      headers: { 'content-type': `multipart/form-data; boundary=${first.slice(2)}` },
    }).formData();
    const metadata = JSON.parse(String(inner.get('metadata') ?? '{}')) as Record<string, unknown>;
    const modules: FakeWorkerBundle['modules'] = {};
    for (const [name, value] of inner.entries()) {
      if (name === 'metadata' || typeof value === 'string') continue;
      modules[name] = { type: value.type, content: await value.text() };
    }
    const main = metadata.main_module;
    if (typeof main !== 'string' || !Object.hasOwn(modules, main)) throw new Error('main_module missing');
    return { metadata, modules };
  }

  async function createDeployment(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    let form: FormData;
    try {
      form = await parseMultipart(req, body);
    } catch {
      fail(res, 400, 8000000, 'Invalid multipart body');
      return;
    }
    const manifestRaw = form.get('manifest');
    let manifest: Record<string, string>;
    try {
      manifest = JSON.parse(typeof manifestRaw === 'string' ? manifestRaw : '') as Record<string, string>;
    } catch {
      fail(res, 400, 8000096, 'Invalid manifest');
      return;
    }
    for (const key of Object.values(manifest)) {
      if (!fake.assets.has(key)) {
        fail(res, 400, 8000096, `Manifest references a missing asset ${key}`);
        return;
      }
    }
    const branchRaw = form.get('branch');
    const branch = typeof branchRaw === 'string' && branchRaw ? branchRaw : fake.project.production_branch;
    const headersPart = form.get('_headers');
    const headers = headersPart && typeof headersPart !== 'string' ? await headersPart.text() : undefined;
    const bundlePart = form.get('_worker.bundle');
    let worker: FakeWorkerBundle | undefined;
    if (bundlePart && typeof bundlePart !== 'string') {
      try {
        worker = await parseBundle(bundlePart);
      } catch {
        fail(res, 400, 8000000, 'Invalid _worker.bundle');
        return;
      }
    }
    const outcome = fake.nextOutcomes.shift() ?? 'success';
    const d = addDeployment(branch, manifest, headers, worker, Date.now(), 'queued');
    if (outcome !== 'stuck') {
      const t = setTimeout(() => {
        timers.delete(t);
        d.status = outcome;
      }, fake.queuedMs);
      timers.add(t);
    }
    ok(res, deploymentJson(d, false));
  }

  function listDeployments(res: ServerResponse, url: URL): void {
    const page = Number(url.searchParams.get('page') ?? '1');
    const perRaw = Number(url.searchParams.get('per_page') ?? String(PER_PAGE));
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perRaw) || perRaw < 1) {
      fail(res, 400, 8000024, 'Invalid list options');
      return;
    }
    const perPage = Math.min(perRaw, PER_PAGE);
    const env = url.searchParams.get('env');
    const all = live()
      .filter(d => !env || d.environment === env)
      .sort((a, b) => b.createdAt - a.createdAt || fake.deployments.indexOf(b) - fake.deployments.indexOf(a));
    const items = all.slice((page - 1) * perPage, page * perPage);
    ok(
      res,
      items.map(d => deploymentJson(d, false)),
      {
        result_info: {
          page,
          per_page: perPage,
          count: items.length,
          total_count: all.length,
          total_pages: Math.max(1, Math.ceil(all.length / perPage)),
        },
      },
    );
  }

  function deleteDeployment(res: ServerResponse, url: URL, id: string): void {
    const d = live().find(x => x.id === id);
    if (!d) {
      fail(res, 404, 8000009, 'The deployment could not be found');
      return;
    }
    const latest = latestOf(d.branch);
    if (d.environment === 'production' && latest === d) {
      fail(res, 400, 8000034, 'Cannot delete the active production deployment');
      return;
    }
    if (latest === d && url.searchParams.get('force') !== 'true') {
      fail(res, 400, 8000035, 'You cannot delete an aliased deployment without `?force=true`.');
      return;
    }
    d.deleted = true;
    ok(res, null);
  }

  function siteDeployment(host: string): FakeDeployment | undefined {
    const suffix = fake.hostSuffix.toLowerCase();
    const normalized = host.toLowerCase();
    if (normalized === suffix.slice(1)) return latestOf(fake.project.production_branch);
    if (!normalized.endsWith(suffix)) return undefined;
    const label = normalized.slice(0, -suffix.length);
    const exact = live().find(d => d.shortId === label);
    if (exact) return exact;
    for (const [branch, alias] of branchAlias) if (alias === label) return latestOf(branch);
    return undefined;
  }

  function applySiteHeaders(response: Response, source: string | undefined): Response {
    if (!source) return response;
    const headers = new Headers(response.headers);
    let wildcard = false;
    for (const line of source.split(/\r?\n/)) {
      if (line.trim() === '/*') {
        wildcard = true;
        continue;
      }
      if (!wildcard || !/^\s+/.test(line)) continue;
      const value = line.trim();
      if (value.startsWith('! ')) {
        headers.delete(value.slice(2).trim());
        continue;
      }
      const colon = value.indexOf(':');
      if (colon > 0) headers.set(value.slice(0, colon).trim(), value.slice(colon + 1).trim());
    }
    return new Response(response.body, { status: response.status, headers });
  }

  async function staticAsset(d: FakeDeployment, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const normalized = path.endsWith('/') ? `${path}index.html` : path;
    const decoded = decodeURIComponent(normalized);
    if (
      !path.endsWith('/') &&
      (Object.hasOwn(d.manifest, `${decoded}/index.html`) || decoded.endsWith('/index.html'))
    ) {
      const target = decoded.endsWith('/index.html') ? decoded.slice(0, -'index.html'.length) : `${decoded}/`;
      return new Response(null, { status: 308, headers: { Location: `${target}${url.search}` } });
    }
    const key = d.manifest[decoded];
    const asset = key ? fake.assets.get(key) : undefined;
    if (asset) {
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.bytes), {
        status: 200,
        headers: { 'Content-Type': asset.contentType },
      });
    }
    const fallbackKey = d.manifest['/404.html'];
    const fallback = fallbackKey ? fake.assets.get(fallbackKey) : undefined;
    return new Response(request.method === 'HEAD' ? null : fallback ? new Uint8Array(fallback.bytes) : null, {
      status: 404,
      headers: fallback ? { 'Content-Type': fallback.contentType } : {},
    });
  }

  async function siteResponse(d: FakeDeployment, request: Request): Promise<Response> {
    if (d.worker && !fake.workerQuotaExhausted) {
      let module = workerModules.get(d.id);
      if (!module) {
        const main = d.worker.metadata.main_module;
        if (typeof main !== 'string' || !d.worker.modules[main]) throw new Error('worker main module missing');
        const source = d.worker.modules[main].content;
        const imported = (await import(`data:text/javascript,${encodeURIComponent(source)}`)) as {
          default: typeof module;
        };
        if (!imported.default) throw new Error('worker default export missing');
        module = imported.default;
        workerModules.set(d.id, module);
      }
      return module.fetch(request, { ASSETS: { fetch: inner => staticAsset(d, inner) } });
    }
    return applySiteHeaders(await staticAsset(d, request), d.headers);
  }

  async function handleSite(req: IncomingMessage, res: ServerResponse, d: FakeDeployment): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? ''}`);
    const request = new Request(url, { method, headers: req.headers as HeadersInit });
    const cacheKey = `${req.headers.host}${url.pathname}`;
    const old = cachedPaths.get(cacheKey);
    let response = await siteResponse(d, request);
    if (old && old.deploymentId !== d.id && fake.edgeCache && response.status === 404) {
      response = old.response.clone();
    } else if (old && old.deploymentId !== d.id && fake.contentLagMs > 0 && !url.search) {
      const lag = changedPaths.get(cacheKey) ?? { until: Date.now() + fake.contentLagMs, prior: old.response };
      changedPaths.set(cacheKey, lag);
      if (Date.now() < lag.until) response = lag.prior.clone();
    }
    if (!url.search && response.status === 200 && (!old || old.deploymentId !== d.id)) {
      cachedPaths.set(cacheKey, { deploymentId: d.id, response: response.clone() });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const body = await readBody(req);
    const method = req.method ?? 'GET';
    fake.requests.push({ method, path: url.pathname + url.search, headers: req.headers, body });
    const path = url.pathname;

    const deployment = siteDeployment(req.headers.host ?? '');
    if (deployment) {
      await handleSite(req, res, deployment);
      return;
    }

    for (const it of intercepts) {
      if (it.left > 0 && it.method === method && matches(it.path, path)) {
        it.left--;
        send(res, it.reply.status, it.reply.body ?? '', it.reply.headers);
        return;
      }
    }

    if (!path.startsWith(`${API_PREFIX}/`)) {
      send(res, 404, 'not found');
      return;
    }
    const rest = path.slice(API_PREFIX.length);

    // ── 资产端点：只认上传 JWT ──
    if (rest.startsWith('/pages/assets/')) {
      if (method !== 'POST') {
        fail(res, 405, 10405, 'Method not allowed');
        return;
      }
      if (!checkJwt(req, res)) return;
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf-8'));
      } catch {
        fail(res, 400, 8000000, 'Invalid JSON');
        return;
      }
      if (rest === '/pages/assets/check-missing') {
        const hashes = (payload as { hashes?: unknown }).hashes;
        if (!Array.isArray(hashes) || hashes.length > MAX_FILE_COUNT) {
          fail(res, 400, 8000000, 'Invalid hashes');
          return;
        }
        ok(
          res,
          hashes.filter(h => typeof h === 'string' && !fake.assets.has(h)),
        );
        return;
      }
      if (rest === '/pages/assets/upload') {
        if (!Array.isArray(payload)) {
          fail(res, 400, 8000000, 'Invalid upload payload');
          return;
        }
        const decoded: Array<{ key: string; bytes: Buffer; contentType: string }> = [];
        for (const item of payload as Array<Record<string, unknown>>) {
          const key = item.key;
          if (typeof key !== 'string' || !KEY_PATTERN.test(key) || typeof item.value !== 'string') {
            fail(res, 400, 8000000, `Invalid asset key ${String(key)}`);
            return;
          }
          const bytes = Buffer.from(item.value, item.base64 === true ? 'base64' : 'utf-8');
          if (bytes.byteLength > MAX_ASSET_BYTES) {
            send(
              res,
              500,
              '<!DOCTYPE html><html><head><title>500 Internal Server Error</title></head><body>error</body></html>',
            );
            return;
          }
          const meta = item.metadata as { contentType?: unknown } | undefined;
          decoded.push({ key, bytes, contentType: typeof meta?.contentType === 'string' ? meta.contentType : '' });
        }
        // 同一个键以第一次写入为准：后来的内容不替换（实测）
        for (const a of decoded) {
          if (!fake.assets.has(a.key))
            fake.assets.set(a.key, { bytes: new Uint8Array(a.bytes), contentType: a.contentType });
        }
        ok(res, { successful_key_count: decoded.length, unsuccessful_keys: [] });
        return;
      }
      if (rest === '/pages/assets/upsert-hashes') {
        ok(res, true);
        return;
      }
      fail(res, 404, 7003, 'No route for that URI');
      return;
    }

    // ── token 核验 ──
    if (method === 'GET' && rest === '/user/tokens/verify') {
      const info = fake.tokens.get(bearer(req));
      if (!info || info.kind !== 'user') {
        fail(res, 401, 1000, 'Invalid API Token');
        return;
      }
      ok(res, {
        id: 'token-0000',
        status: info.status ?? 'active',
        ...(info.expiresOn ? { expires_on: info.expiresOn } : {}),
      });
      return;
    }
    const verify = /^\/accounts\/([^/]+)\/tokens\/verify$/.exec(rest);
    if (method === 'GET' && verify) {
      const info = fake.tokens.get(bearer(req));
      if (!info || info.kind !== 'account' || verify[1] !== accountId) {
        fail(res, 401, 1000, 'Invalid API Token');
        return;
      }
      ok(res, {
        id: 'token-0001',
        status: info.status ?? 'active',
        ...(info.expiresOn ? { expires_on: info.expiresOn } : {}),
      });
      return;
    }

    // ── 项目与部署：认 API token ──
    const m = /^\/accounts\/([^/]+)\/pages\/projects\/([^/]+)(?:\/(.*))?$/.exec(rest);
    if (!m) {
      fail(res, 404, 7003, 'No route for that URI');
      return;
    }
    if (!checkToken(req, res, decodeURIComponent(m[1]))) return;
    if (decodeURIComponent(m[2]) !== projectName) {
      fail(
        res,
        404,
        8000007,
        'Project not found. The specified project name does not match any of your existing projects.',
      );
      return;
    }
    const sub = m[3] ?? '';

    if (sub === '' && method === 'GET') {
      ok(res, projectJson());
      return;
    }
    if (sub === '' && method === 'PATCH') {
      let patch: Record<string, unknown>;
      try {
        patch = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
      } catch {
        fail(res, 400, 8000000, 'Invalid JSON');
        return;
      }
      const configs = patch.deployment_configs as Record<string, Record<string, unknown>> | undefined;
      for (const env of ['production', 'preview'] as const) {
        if (configs?.[env]) Object.assign(fake.project.deployment_configs[env], configs[env]);
      }
      if (typeof patch.production_branch === 'string') fake.project.production_branch = patch.production_branch;
      ok(res, projectJson());
      return;
    }
    if (sub === 'upload-token' && method === 'GET') {
      ok(res, { jwt: issueJwt() });
      return;
    }
    if (sub === 'domains' && method === 'GET') {
      ok(
        res,
        fake.customDomains.map((name, i) => ({ id: `domain-${i}`, name, status: 'active', created_on: iso(0) })),
      );
      return;
    }
    if (sub === 'deployments' && method === 'POST') {
      await createDeployment(req, res, body);
      return;
    }
    if (sub === 'deployments' && method === 'GET') {
      listDeployments(res, url);
      return;
    }
    const dm = /^deployments\/([^/]+)$/.exec(sub);
    if (dm && method === 'GET') {
      const d = live().find(x => x.id === decodeURIComponent(dm[1]));
      if (!d) fail(res, 404, 8000009, 'The deployment could not be found');
      else ok(res, deploymentJson(d, true));
      return;
    }
    if (dm && method === 'DELETE') {
      deleteDeployment(res, url, decodeURIComponent(dm[1]));
      return;
    }
    fail(res, 404, 7003, 'No route for that URI');
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) send(res, 500, { success: false, errors: [{ code: 1, message: String(err) }] });
      else res.destroy();
    });
  });
  server.on('close', () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fake.port = (server.address() as AddressInfo).port;
  fake.apiBase = `http://127.0.0.1:${fake.port}${API_PREFIX}`;
  fake.hostSuffix = `.${projectName}.localhost:${fake.port}`;
  return fake;
}
