// ============================================================
// Cursor Cloud Agents API v1 的远端代理提供者。
//
// 对接细节按实测定：
// - 建代理的请求固定约 60 秒才回。客户端自带 agentId、超时后用同一 id 重发：服务端只认 id，已有就回
//   409 agent_id_conflict，再按 id 取回首轮。
// - 事件流只取简化事件（thinking、assistant、tool_call、result、done）。status 与 heartbeat 没有 id；
//   简化事件与随后的 interaction_update 共用 id，所以续传位置只按简化事件推进。终态以 result 事件或
//   GET run 为准，不看 status 事件的值（被取消的一轮 status 写 FINISHED 而 result 写 CANCELLED）；
//   error 之后跟来的 done 不代表结束。
// - 无参 POST（cancel、archive、unarchive）发 `{}` 加 JSON 头：只带头不带 body 回 400。
// - 错误体有两种：业务错误 {error:{code,message}}，框架层的 400/415 为 {code:'error',message}。
// - 产物列表的 path 以 `artifacts/` 开头，对应虚拟机里的 /opt/cursor/artifacts；下载拿到 15 分钟的
//   预签名链接，经 safeFetch 下载，边读边计字节。单个成品取不到下载链接（非临时错误）时只拒收这一件。
// - 列表翻页：响应是 {items, nextCursor?}，还有下一页时 nextCursor 为本页最后一项的 id，下一页以 cursor 传回，
//   末页不带；limit 上限 100（超过回 400；不带时默认 20 取自文档）。认不出的 cursor：列代理回 200 空页，
//   列轮次回 400。列代理按 updatedAt 倒序，翻页期间更新的代理会挪到已读过的头部，这一次可能漏掉。
//   列代理、列轮次都取完所有页，取不全时抛错，不把已取到的当完整列表（对账与开轮认领都依赖列表完整）。
//   产物列表不分页（文档与实测都只有 items）。
//
// key 只放在发往 baseUrl 的请求头里；预签名下载不带它。错误与日志一律先去掉 key 的片段与链接的查询串。
// ============================================================

import {
  type ArtifactLimits,
  type ArtifactSink,
  artifactRelProblem,
  type CollectReport,
  type EgressMode,
  type EgressReport,
  isRemoteAgentError,
  isTerminalRun,
  RemoteAgentError,
  type RemoteAgentErrorCode,
  type RemoteAgentProvider,
  type RemoteAgentSummary,
  type RemoteRunSummary,
  type RunCost,
  type RunProgress,
  type RunState,
  type RunStatus,
  type WorkspaceLayout,
} from '@aalis/api-remote-agent';
import type { Logger } from '@aalis/core';
import { safeFetch } from '@aalis/util-network-guard';
import { type SseMessage, SseParser } from './sse.js';

export interface CursorProviderOptions {
  apiKey: string;
  /** API 根地址（不含 /v1） */
  baseUrl: string;
  /** 建代理用的模型；params 须写全，并等于 /v1/models 列出的某个变体 */
  model: { id: string; params: Readonly<Record<string, string>> };
  /** owner 在 Cursor 后台给云端代理设的出网方式（接口读不到） */
  egressMode: EgressMode;
  createTimeoutMs: number;
  requestTimeoutMs: number;
  /** 事件流与下载的读空闲超时 */
  streamIdleMs: number;
  /** listAgents 跳过的代理名（owner 自管的代理） */
  reconcileIgnoreNames: readonly string[];
  /** 事件流断开后重连的退避起点：逐次翻倍，封顶 30 秒，收到新事件后复位 */
  retryBaseMs: number;
  /** 事件流过期（410）后轮询这一轮状态的间隔 */
  pollIntervalMs: number;
}

interface CursorProviderContext {
  logger: Logger;
  /** 插件这次激活的取消信号：所有请求与等待都受它约束 */
  signal: AbortSignal;
}

/** 虚拟机里的产物目录；产物列表的 path 以 `artifacts/` 开头，对应这里 */
const REMOTE_ARTIFACTS = '/opt/cursor/artifacts';
const LISTED_OUT = 'artifacts/out/';
const LISTED_BUNDLE = 'artifacts/workspace.tar.gz';

const LAYOUT: WorkspaceLayout = {
  workDir: '/agent',
  outDir: `${REMOTE_ARTIFACTS}/out`,
  bundlePath: `${REMOTE_ARTIFACTS}/workspace.tar.gz`,
  policyNotes: [
    '不要创建或修改 AGENTS.md、.cursor/rules 这类会影响以后各轮的规则文件',
    '不要使用订阅或定时唤醒工具（如 subscribe_timer）',
  ],
};

const READY_TTL_MS = 10 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const RETRY_CAP_MS = 30_000;
const MAX_DETAIL_CHARS = 300;
/** 错误与日志里出现 key 的这么长的片段就去掉 */
const MIN_SECRET_FRAGMENT = 8;
/** URL 的查询串（预签名链接的签名在这里） */
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]*)\?[^\s"'<>]*/gi;
/** 列表每页的条数（接口上限） */
const PAGE_LIMIT = 100;
/** 列表最多取这么多页，超过按取不完处理 */
const MAX_PAGES = 50;

const RUN_STATUS: Readonly<Record<string, RunStatus>> = {
  CREATING: 'creating',
  RUNNING: 'running',
  FINISHED: 'finished',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

type Json = Record<string, unknown>;

interface CallResult {
  /** 方法与路径，用于错误信息 */
  what: string;
  status: number;
  data: unknown;
  headers: Headers;
}

interface StreamCursor {
  /** 续传位置：最后一个简化事件的 id */
  lastId: string | undefined;
  /** 已交出的简化事件 id（重放时跳过） */
  seen: Set<string>;
}

type StreamOutcome =
  | { kind: 'terminal' }
  | { kind: 'expired' }
  | { kind: 'restart' }
  | { kind: 'dropped'; reason: string; progressed: boolean; waitMs?: number };

/** 单个成品不取回的原因（记进 rejected，不中断其余文件） */
class ArtifactRejected extends Error {}

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

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toRunStatus(raw: unknown): RunStatus | undefined {
  return typeof raw === 'string' && Object.hasOwn(RUN_STATUS, raw) ? RUN_STATUS[raw] : undefined;
}

function runState(runId: string, status: RunStatus, text: unknown): RunState {
  const state: RunState = { runId, status };
  const resultText = str(text);
  if (resultText !== undefined) state.resultText = resultText;
  return state;
}

/** 两种错误体都认：{error:{code,message}} 与 {code,message}；不是 JSON 时整段当说明 */
function remoteError(data: unknown): { code?: string; message?: string } {
  if (typeof data === 'string') return { message: data };
  const body = asRecord(data);
  if (body.error !== null && typeof body.error === 'object') {
    const inner = asRecord(body.error);
    return { code: str(inner.code), message: str(inner.message) };
  }
  return { code: str(body.code), message: str(body.message) };
}

/** Retry-After 可以是秒数或 HTTP 日期；没有时按 60 秒 */
function retryAfterMs(headers: Headers): number {
  const raw = headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message ? `${err.message}（${cause.message}）` : err.message;
}

/**
 * 去掉文本里 secret 的片段：从每个位置起取能在 secret 里找到的最长子串，长度够 {@link MIN_SECRET_FRAGMENT}
 * 就整段换掉。远端可能在错误信息里回显 key 的一段，只替换整串挡不住。
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

/** 模型是否在列表里、参数是否写全且等于某个变体；不成立时返回原因 */
function modelProblem(listing: unknown, model: CursorProviderOptions['model']): string | undefined {
  const item = asArray(asRecord(listing).items)
    .map(asRecord)
    .find(m => m.id === model.id);
  if (!item) return `模型 ${model.id} 不在 /v1/models 的列表里`;
  const declared = asArray(item.parameters)
    .map(p => str(asRecord(p).id))
    .filter((id): id is string => id !== undefined);
  const written = Object.keys(model.params);
  const missing = declared.filter(id => !written.includes(id));
  if (missing.length > 0) {
    return `模型 ${model.id} 的参数 ${missing.join('、')} 没有写出：参数须写全，缺的会按默认变体计费`;
  }
  const extra = written.filter(id => !declared.includes(id));
  if (extra.length > 0) return `${extra.join('、')} 不是模型 ${model.id} 的参数`;
  const isVariant = asArray(item.variants).some(v => {
    const params = asArray(asRecord(v).params).map(asRecord);
    return (
      params.length === written.length &&
      params.every(p => {
        const id = str(p.id);
        return id !== undefined && Object.hasOwn(model.params, id) && model.params[id] === str(p.value);
      })
    );
  });
  if (!isVariant) {
    const combo = written.map(k => `${k}=${model.params[k]}`).join('、');
    return `参数组合 ${combo} 不是模型 ${model.id} 列出的变体`;
  }
  return undefined;
}

/** 账号标识的 SHA-256 前 16 位十六进制：同一账号的不同 key 得到同一个值，值里不含账号原文 */
async function accountKeyOf(userId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId)));
  return [...digest.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
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

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export class CursorProvider implements RemoteAgentProvider {
  readonly transcriptIsolation = 'shared';
  readonly layout = LAYOUT;
  readonly #opt: CursorProviderOptions;
  readonly #log: Logger;
  readonly #life: AbortSignal;
  readonly #base: string;
  #ready: { accountKey: string; at: number } | undefined;

  constructor(options: CursorProviderOptions, ctx: CursorProviderContext) {
    this.#opt = options;
    this.#log = ctx.logger;
    this.#life = ctx.signal;
    this.#base = options.baseUrl.replace(/\/+$/, '');
  }

  async egress(): Promise<EgressReport> {
    return { mode: this.#opt.egressMode, source: 'owner-config' };
  }

  async ready(signal: AbortSignal): Promise<{ accountKey: string }> {
    const cached = this.#ready;
    if (cached && Date.now() - cached.at < READY_TTL_MS) return { accountKey: cached.accountKey };
    const me = asRecord(this.#ok(await this.#call('GET', '/v1/me', { signal })));
    // 实测是整数；按十进制写法取哈希，超出安全整数的已经丢了精度，同样按取不到处理
    const userId = num(me.userId);
    if (userId === undefined || !Number.isSafeInteger(userId)) {
      throw this.#error('unavailable', '/v1/me 的响应里没有整数的账号标识 userId，判不出哪些实例属于同一账号');
    }
    const problem = modelProblem(this.#ok(await this.#call('GET', '/v1/models', { signal })), this.#opt.model);
    if (problem) throw this.#error('unavailable', problem);
    const accountKey = await accountKeyOf(String(userId));
    this.#ready = { accountKey, at: Date.now() };
    return { accountKey };
  }

  mintAgentId(): string {
    return `bc-${crypto.randomUUID()}`;
  }

  async createAgent(
    req: { agentId: string; name: string; prompt: string },
    signal: AbortSignal,
  ): Promise<{ runId: string }> {
    // 模型参数没校验过就不建代理：参数不全会按默认变体（贵数倍）计费
    await this.ready(signal);
    const body = {
      agentId: req.agentId,
      name: req.name,
      prompt: { text: req.prompt },
      model: {
        id: this.#opt.model.id,
        params: Object.entries(this.#opt.model.params).map(([id, value]) => ({ id, value })),
      },
    };
    let lastError: RemoteAgentError | undefined;
    // 超时或临时故障时代理可能已经建出来了：同一 agentId 重发是安全的，已有就得 409，再按 id 取回
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.#call('POST', '/v1/agents', { signal, body, timeoutMs: this.#opt.createTimeoutMs });
        if (res.status === 409 && remoteError(res.data).code === 'agent_id_conflict') {
          return await this.#createdRun(req.agentId, signal);
        }
        const runId = str(asRecord(asRecord(this.#ok(res)).run).id);
        if (!runId) throw this.#error('transient', '建代理的响应里没有 run.id');
        return { runId };
      } catch (err) {
        if (!isRemoteAgentError(err) || err.code !== 'transient') throw err;
        lastError = err;
        if (attempt === 0)
          this.#note('warn', `建代理 ${req.agentId} 没有得到结果（${err.message}），用同一 agentId 重发`);
      }
    }
    return this.#createdRun(req.agentId, signal, lastError);
  }

  /** 按 id 取回已建出的代理的首轮；代理不存在时抛 notCreated（没有就是 transient：可以同一 agentId 再建） */
  async #createdRun(agentId: string, signal: AbortSignal, notCreated?: RemoteAgentError): Promise<{ runId: string }> {
    const res = await this.#call('GET', `/v1/agents/${enc(agentId)}`, { signal });
    if (res.status === 404) throw notCreated ?? this.#error('transient', `代理 ${agentId} 还没有建出来`);
    const runId = str(asRecord(this.#ok(res)).latestRunId);
    if (!runId) throw this.#error('transient', `代理 ${agentId} 已建出，但还没有首轮`);
    return { runId };
  }

  async startRun(agentId: string, prompt: string, signal: AbortSignal): Promise<{ runId: string }> {
    const res = await this.#call('POST', `/v1/agents/${enc(agentId)}/runs`, {
      signal,
      body: { prompt: { text: prompt } },
    });
    const runId = str(asRecord(asRecord(this.#ok(res)).run).id);
    if (!runId) throw this.#error('transient', '开新一轮的响应里没有 run.id');
    return { runId };
  }

  async *followRun(
    agentId: string,
    runId: string,
    opts: { lastEventId?: string; signal: AbortSignal },
  ): AsyncGenerator<RunProgress, void, undefined> {
    const { signal } = opts;
    const cursor: StreamCursor = { lastId: opts.lastEventId, seen: new Set() };
    const streamPath = `/v1/agents/${enc(agentId)}/runs/${enc(runId)}/stream`;
    let backoff = this.#opt.retryBaseMs;
    for (;;) {
      const outcome = yield* this.#streamOnce(streamPath, runId, cursor, signal);
      if (outcome.kind === 'terminal') return;
      if (outcome.kind === 'expired') {
        yield { kind: 'terminal', state: await this.#pollUntilTerminal(agentId, runId, signal) };
        return;
      }
      if (outcome.kind === 'restart') {
        this.#note('warn', `续传位置不属于轮次 ${runId}，不带位置从头重放，已见过的事件跳过`);
        cursor.lastId = undefined;
        continue;
      }
      // 连接在 result 之前结束（含 error 之后的 done）：先查这一轮，未到终态才重连
      if (outcome.progressed) backoff = this.#opt.retryBaseMs;
      const state = await this.#peekRun(agentId, runId, signal);
      if (state && isTerminalRun(state.status)) {
        yield { kind: 'terminal', state };
        return;
      }
      const wait = outcome.waitMs ?? backoff;
      this.#note('debug', `轮次 ${runId} 的事件流断开（${outcome.reason}），${wait} 毫秒后重连`);
      await sleep(wait, AbortSignal.any([signal, this.#life]));
      backoff = Math.min(backoff * 2, RETRY_CAP_MS);
    }
  }

  /** 连一次事件流，交出进展；返回这次连接怎么结束的 */
  async *#streamOnce(
    path: string,
    runId: string,
    cursor: StreamCursor,
    signal: AbortSignal,
  ): AsyncGenerator<RunProgress, StreamOutcome, undefined> {
    const conn = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => conn.abort(), ms);
    };
    let progressed = false;
    const dropped = (reason: string, waitMs?: number): StreamOutcome => ({
      kind: 'dropped',
      reason: this.#scrub(reason),
      progressed,
      waitMs,
    });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#opt.apiKey}`,
      Accept: 'text/event-stream',
    };
    if (cursor.lastId !== undefined) headers['Last-Event-ID'] = cursor.lastId;
    arm(this.#opt.requestTimeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.#base}${path}`, {
          headers,
          signal: AbortSignal.any([signal, this.#life, conn.signal]),
        });
      } catch (err) {
        this.#throwIfStopped(signal);
        return dropped(conn.signal.aborted ? '连接超时' : errorText(err));
      }
      if (!res.ok) {
        let text = '';
        try {
          text = await res.text();
        } catch {
          this.#throwIfStopped(signal);
        }
        const result: CallResult = {
          what: `GET ${path}`,
          status: res.status,
          data: parseJson(text),
          headers: res.headers,
        };
        if (res.status === 410) return { kind: 'expired' };
        if (res.status === 400 && remoteError(result.data).code === 'invalid_last_event_id' && cursor.lastId) {
          return { kind: 'restart' };
        }
        const err = this.#httpError(result);
        if (err.code === 'transient') return dropped(err.message);
        if (err.code === 'rate-limited') return dropped(err.message, err.retryAfterMs);
        throw err;
      }
      if (!res.body) return dropped('响应没有正文');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        for (;;) {
          arm(this.#opt.streamIdleMs);
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (err) {
            this.#throwIfStopped(signal);
            return dropped(conn.signal.aborted ? '读空闲超时' : errorText(err));
          }
          clearTimeout(timer);
          if (chunk.done) return dropped('连接在 result 之前结束');
          for (const msg of parser.push(decoder.decode(chunk.value, { stream: true }))) {
            const step = this.#onEvent(msg, runId, cursor);
            if (step === 'done') return dropped('done 之前没有 result');
            if (!step) continue;
            yield step;
            if (step.kind === 'terminal') return { kind: 'terminal' };
            progressed = true;
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #onEvent(msg: SseMessage, runId: string, cursor: StreamCursor): RunProgress | 'done' | undefined {
    switch (msg.event) {
      case 'thinking':
      case 'assistant':
      case 'tool_call': {
        if (msg.id === undefined || cursor.seen.has(msg.id)) return undefined;
        cursor.seen.add(msg.id);
        cursor.lastId = msg.id;
        return { kind: 'progress', eventId: msg.id };
      }
      case 'result': {
        const data = asRecord(parseJson(msg.data));
        const status = toRunStatus(data.status);
        // 认不出或不是终态的 result 不作数，连接结束后以 GET run 为准
        if (!status || !isTerminalRun(status)) return undefined;
        return { kind: 'terminal', state: runState(runId, status, data.text) };
      }
      case 'done':
        return 'done';
      default:
        // status、heartbeat、interaction_update、error 都不推进续传位置
        return undefined;
    }
  }

  /** 断线后查一次这一轮；临时故障与限流返回 undefined（由调用方退避后重试），其余照抛 */
  async #peekRun(agentId: string, runId: string, signal: AbortSignal): Promise<RunState | undefined> {
    try {
      return await this.getRun(agentId, runId, signal);
    } catch (err) {
      if (isRemoteAgentError(err) && (err.code === 'transient' || err.code === 'rate-limited')) return undefined;
      throw err;
    }
  }

  async #pollUntilTerminal(agentId: string, runId: string, signal: AbortSignal): Promise<RunState> {
    for (;;) {
      const state = await this.#peekRun(agentId, runId, signal);
      if (state && isTerminalRun(state.status)) return state;
      await sleep(this.#opt.pollIntervalMs, AbortSignal.any([signal, this.#life]));
    }
  }

  async getRun(agentId: string, runId: string, signal: AbortSignal): Promise<RunState> {
    const data = asRecord(
      this.#ok(await this.#call('GET', `/v1/agents/${enc(agentId)}/runs/${enc(runId)}`, { signal })),
    );
    const id = str(data.id) ?? runId;
    return runState(id, this.#status(data.status, id), data.result);
  }

  async cancelRun(agentId: string, runId: string, signal: AbortSignal): Promise<void> {
    const res = await this.#call('POST', `/v1/agents/${enc(agentId)}/runs/${enc(runId)}/cancel`, { signal, body: {} });
    if (res.status === 409 && remoteError(res.data).code === 'run_not_cancellable') return;
    this.#ok(res);
  }

  async listRuns(agentId: string, signal: AbortSignal): Promise<RemoteRunSummary[]> {
    const items = await this.#listAll(`/v1/agents/${enc(agentId)}/runs`, signal);
    return items.map(([id, r]) => ({ runId: id, status: this.#status(r.status, id) }));
  }

  /**
   * 计入额度的花费取 chargedCents 与 rawCostCents 的较大者：文档写计划内额度、BYOK、赠送额度的用量 chargedCents
   * 为 0，按请求计价的用量 rawCostCents 为 0（试点账号实测两者恒等，不能依赖）。
   */
  async runCost(agentId: string, runId: string, signal: AbortSignal): Promise<RunCost | undefined> {
    const path = `/v1/agents/${enc(agentId)}/usage?runId=${enc(runId)}`;
    const data = asRecord(this.#ok(await this.#call('GET', path, { signal })));
    const run = asArray(data.runs)
      .map(asRecord)
      .find(r => r.id === runId);
    const cost = asRecord(run?.cost);
    const charged = num(cost.chargedCents);
    const raw = num(cost.rawCostCents);
    if (!run || (charged === undefined && raw === undefined)) return undefined;
    const usage = asRecord(run.usage);
    return {
      cents: Math.max(charged ?? 0, raw ?? 0),
      inputTokens: num(usage.inputTokens) ?? 0,
      cacheReadTokens: num(usage.cacheReadTokens) ?? 0,
    };
  }

  async collectArtifacts(
    agentId: string,
    taskId: string,
    sink: ArtifactSink,
    limits: ArtifactLimits,
    signal: AbortSignal,
  ): Promise<CollectReport> {
    const idProblem = taskId.includes('/') ? '含 /' : artifactRelProblem(taskId);
    if (idProblem) throw this.#error('rejected', `任务 id ${taskId} 不能用作目录名（${idProblem}）`);
    const prefix = `${LISTED_OUT}${taskId}/`;
    const report: CollectReport = { rejected: [] };
    const reject = (path: string, reason: string) => report.rejected.push({ path, reason: this.#scrub(reason) });
    let runFiles = 0;
    let runBytes = 0;
    for (const item of await this.#listArtifacts(agentId, signal)) {
      const isBundle = item.path === LISTED_BUNDLE;
      let rel = '';
      let limit = limits.maxBundleBytes;
      if (!isBundle) {
        if (!item.path.startsWith(prefix)) continue;
        rel = item.path.slice(prefix.length);
        const problem = artifactRelProblem(rel);
        if (problem) {
          reject(item.path, problem);
          continue;
        }
        if (runFiles >= limits.maxRunFiles) {
          reject(item.path, `超过本轮文件数上限 ${limits.maxRunFiles}`);
          continue;
        }
        limit = Math.min(limits.maxFileBytes, limits.maxRunBytes - runBytes);
      }
      // 列表报的大小只用来预检，下载时仍按实际读到的字节判定
      if (item.sizeBytes > limit) {
        reject(item.path, `列表报的大小 ${item.sizeBytes} 字节超过上限 ${limit} 字节`);
        continue;
      }
      let data: Uint8Array;
      try {
        data = await this.#download(await this.#downloadLink(agentId, item.path, signal), limit, signal);
      } catch (err) {
        if (err instanceof ArtifactRejected) {
          reject(item.path, err.message);
          continue;
        }
        // 这一件取不到下载链接（已被删、路径过长等）：只拒收这一件；临时故障与限流照抛，由调用方整次重来
        if (isRemoteAgentError(err) && err.code !== 'transient' && err.code !== 'rate-limited') {
          reject(item.path, `取不到下载链接：${err.message}`);
          continue;
        }
        throw err;
      }
      try {
        await (isBundle ? sink.putBundle(data) : sink.putFile(rel, data));
      } catch (err) {
        this.#throwIfStopped(signal);
        reject(item.path, `写入口拒收：${errorText(err)}`);
        continue;
      }
      if (!isBundle) {
        runFiles++;
        runBytes += data.byteLength;
      }
    }
    return report;
  }

  async bundleLink(agentId: string, signal: AbortSignal): Promise<string | undefined> {
    const items = await this.#listArtifacts(agentId, signal);
    if (!items.some(i => i.path === LISTED_BUNDLE)) return undefined;
    return this.#downloadLink(agentId, LISTED_BUNDLE, signal);
  }

  async archiveAgent(agentId: string, signal: AbortSignal): Promise<void> {
    this.#ok(await this.#call('POST', `/v1/agents/${enc(agentId)}/archive`, { signal, body: {} }));
  }

  async unarchiveAgent(agentId: string, signal: AbortSignal): Promise<void> {
    this.#ok(await this.#call('POST', `/v1/agents/${enc(agentId)}/unarchive`, { signal, body: {} }));
  }

  async deleteAgent(agentId: string, signal: AbortSignal): Promise<void> {
    const res = await this.#call('DELETE', `/v1/agents/${enc(agentId)}`, { signal });
    if (res.status === 404) return;
    this.#ok(res);
  }

  async listAgents(signal: AbortSignal): Promise<RemoteAgentSummary[]> {
    const ignore = new Set(this.#opt.reconcileIgnoreNames);
    return (await this.#listAll('/v1/agents', signal)).flatMap(([agentId, a]) => {
      const name = str(a.name) ?? '';
      return ignore.has(name) ? [] : [{ agentId, name }];
    });
  }

  /**
   * 取完一个列表的所有页，按 id 去重（没有 id 的项不要），返回 [id, 项]。任何一页出错都整次照抛；此外：
   * - 响应形状认不出（items 不是数组、nextCursor 不是非空字符串）、页数超过 {@link MAX_PAGES}、下一页标记出现过
   *   （不会前进）时抛 unavailable；
   * - 带着标记取到空页、又没有下一页标记时抛 transient：标记指向的代理在翻页期间被删了，重新列举即可。
   */
  async #listAll(path: string, signal: AbortSignal): Promise<Array<[string, Json]>> {
    const items = new Map<string, Json>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `limit=${PAGE_LIMIT}${cursor === undefined ? '' : `&cursor=${enc(cursor)}`}`;
      const data = asRecord(this.#ok(await this.#call('GET', `${path}?${query}`, { signal })));
      if (!Array.isArray(data.items)) throw this.#error('unavailable', `GET ${path} 的响应没有 items 数组，列表取不全`);
      for (const item of data.items.map(asRecord)) {
        const id = str(item.id);
        if (id && !items.has(id)) items.set(id, item);
      }
      const next: unknown = data.nextCursor;
      if (next === undefined || next === null) {
        if (cursor !== undefined && data.items.length === 0) {
          throw this.#error('transient', `GET ${path} 翻页途中下一页标记失效（回了空页），列表取不全`);
        }
        return [...items];
      }
      if (typeof next !== 'string' || next === '') {
        throw this.#error('unavailable', `GET ${path} 的下一页标记认不出，列表取不全`);
      }
      if (cursors.has(next)) throw this.#error('unavailable', `GET ${path} 的下一页标记没有前进，列表取不全`);
      cursors.add(next);
      cursor = next;
    }
    throw this.#error('unavailable', `GET ${path} 超过 ${MAX_PAGES} 页，列表取不全`);
  }

  /** 产物列表不分页：响应没有 items 数组或带了下一页标记时抛 unavailable，不把已取到的当完整列表 */
  async #listArtifacts(agentId: string, signal: AbortSignal): Promise<Array<{ path: string; sizeBytes: number }>> {
    const path = `/v1/agents/${enc(agentId)}/artifacts`;
    const data = asRecord(this.#ok(await this.#call('GET', path, { signal })));
    if (!Array.isArray(data.items) || (data.nextCursor !== undefined && data.nextCursor !== null)) {
      throw this.#error(
        'unavailable',
        `GET ${path} 的响应形状认不出（没有 items 数组或带了下一页标记），产物列表取不全`,
      );
    }
    return data.items.map(asRecord).flatMap(i => {
      const listed = str(i.path);
      return listed ? [{ path: listed, sizeBytes: num(i.sizeBytes) ?? 0 }] : [];
    });
  }

  /** 产物的预签名下载链接；path 原样用列表给出的 `artifacts/...` */
  async #downloadLink(agentId: string, path: string, signal: AbortSignal): Promise<string> {
    const res = await this.#call('GET', `/v1/agents/${enc(agentId)}/artifacts/download?path=${enc(path)}`, { signal });
    const url = str(asRecord(this.#ok(res)).url);
    if (!url) throw new ArtifactRejected('没有拿到下载链接');
    return url;
  }

  /**
   * 下载预签名链接：经 safeFetch（逐跳核对私网与重定向），不带 Authorization。以实际读到的字节计量，
   * 超过 limit 就中止；列表的 sizeBytes 与响应头都不作数。
   */
  async #download(url: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const conn = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => conn.abort(), ms);
    };
    arm(this.#opt.requestTimeoutMs);
    try {
      let res: Response;
      try {
        res = await safeFetch(url, { signal: AbortSignal.any([signal, this.#life, conn.signal]) });
      } catch (err) {
        this.#throwIfStopped(signal);
        throw new ArtifactRejected(conn.signal.aborted ? '下载超时' : `下载失败：${errorText(err)}`);
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new ArtifactRejected(`下载返回 ${res.status}`);
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          arm(this.#opt.streamIdleMs);
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (err) {
            this.#throwIfStopped(signal);
            throw new ArtifactRejected(conn.signal.aborted ? '下载读空闲超时' : `下载中断：${errorText(err)}`);
          }
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > limit) throw new ArtifactRejected(`实际大小超过上限 ${limit} 字节`);
          chunks.push(chunk.value);
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      return concat(chunks, total);
    } finally {
      clearTimeout(timer);
    }
  }

  async #call(
    method: string,
    path: string,
    opts: { signal: AbortSignal; body?: unknown; timeoutMs?: number },
  ): Promise<CallResult> {
    const what = `${method} ${path}`;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.#opt.requestTimeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#opt.apiKey}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.any([opts.signal, this.#life, timeout]) };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    try {
      const res = await fetch(`${this.#base}${path}`, init);
      const text = await res.text();
      return { what, status: res.status, data: text === '' ? undefined : parseJson(text), headers: res.headers };
    } catch (err) {
      this.#throwIfStopped(opts.signal);
      throw this.#error('transient', timeout.aborted ? `${what} 超时` : `${what} 失败：${errorText(err)}`);
    }
  }

  #ok(res: CallResult): unknown {
    if (res.status >= 200 && res.status < 300) return res.data;
    throw this.#httpError(res);
  }

  #httpError(res: CallResult): RemoteAgentError {
    const { code, message } = remoteError(res.data);
    // 请求路径去掉查询串：查询串里可能有远端可控的内容（如成品路径）
    const what = res.what.replace(/\?.*$/, '');
    const detail = `${what} 返回 ${res.status}${code ? ` ${code}` : ''}${message ? `：${message.slice(0, MAX_DETAIL_CHARS)}` : ''}`;
    if (res.status === 429) return this.#error('rate-limited', detail, retryAfterMs(res.headers));
    if (res.status === 401 || res.status === 403) return this.#error('unavailable', detail);
    if (res.status === 404) return this.#error('not-found', detail);
    if (res.status === 409 && code === 'agent_busy') return this.#error('busy', detail);
    if (res.status === 409 && code === 'agent_archived') return this.#error('archived', detail);
    if (res.status === 408 || res.status >= 500) return this.#error('transient', detail);
    return this.#error('rejected', detail);
  }

  #error(code: RemoteAgentErrorCode, message: string, retryAfterMs?: number): RemoteAgentError {
    return new RemoteAgentError(
      code,
      `Cursor：${this.#scrub(message)}`,
      retryAfterMs === undefined ? undefined : { retryAfterMs },
    );
  }

  #status(raw: unknown, runId: string): RunStatus {
    const status = toRunStatus(raw);
    if (status) return status;
    this.#note('warn', `轮次 ${runId} 的状态 ${String(raw)} 认不出，按进行中处理`);
    return 'running';
  }

  /** 调用方或插件这次激活已中止时抛中止原因（不包成 RemoteAgentError） */
  #throwIfStopped(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.#life.throwIfAborted();
  }

  #scrub(text: string): string {
    return redactFragments(text.replace(URL_QUERY, '$1?<查询串已去除>'), this.#opt.apiKey);
  }

  #note(level: 'debug' | 'warn', message: string): void {
    this.#log[level](`Cursor：${this.#scrub(message)}`);
  }
}
