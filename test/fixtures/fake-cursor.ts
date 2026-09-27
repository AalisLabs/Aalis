import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

// ════════════════════════════════════════════════════════════
// Cursor Cloud Agents API v1 的本机假服务：照 2026-09 对真实接口实测到的形状回应各端点、事件流与
// 预签名下载。只用于测试，不连真实账号。
//
// - 鉴权：Bearer key 须在 accounts 里；不在就回 401，错误信息里回显 key 的一段（用来检验提供者去掉了它）。
// - 建代理：请求到达即登记代理与首轮，之后才按 createDelays 等待回应，所以超时后用同一 agentId 重发会得 409。
// - 事件流：按 streams 里给这一轮排好的连接脚本逐次回应；脚本用完后，终态的轮次回 result 加 done，未终态的挂住。
// - 预签名下载：链接指向本服务的 /s3/...，查询串带哨兵签名 signature；列表的 sizeBytes 可以和实际内容不符。
// ════════════════════════════════════════════════════════════

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface SseEvent {
  id?: string;
  event: string;
  data: unknown;
}

/** 一次事件流连接的脚本 */
export interface StreamSegment {
  /** 连上时先执行（如把这一轮改成终态） */
  before?: () => void;
  /** 不是 200 时直接回这个状态码与 body */
  status?: number;
  body?: unknown;
  events?: SseEvent[];
  /** done：发 done 后关闭；eof：不发 done 直接断开；hang：保持连接、不再发任何东西。缺省 done */
  end?: 'done' | 'eof' | 'hang';
}

export interface FakeRun {
  id: string;
  agentId: string;
  status: string;
  result?: string;
  durationMs?: number;
  cost?: { rawCostCents: number; chargedCents: number };
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export interface FakeArtifact {
  data: Uint8Array;
  /** 列表里报的大小；缺省为实际大小 */
  declaredSize?: number;
}

export interface FakeAgent {
  id: string;
  name: string;
  status: string;
  runs: FakeRun[];
  /** 键为列表里的 path（`artifacts/...`） */
  artifacts: Map<string, FakeArtifact>;
  body: Record<string, unknown>;
}

export interface InterceptReply {
  status: number;
  body?: unknown;
  /** 按请求算出回应体（优先于 body） */
  bodyFrom?: (req: RecordedRequest) => unknown;
  headers?: Record<string, string>;
  /** 回应前等待的毫秒数 */
  delayMs?: number;
}

export interface FakeCursor {
  baseUrl: string;
  requests: RecordedRequest[];
  /** key → 账号；userId 缺省时 /v1/me 不带这个字段 */
  accounts: Map<string, { userId?: string }>;
  models: unknown[];
  agents: Map<string, FakeAgent>;
  /** runId → 依次消费的连接脚本 */
  streams: Map<string, StreamSegment[]>;
  /** 每次建代理 POST 回应前等待的毫秒数（依次消费） */
  createDelays: number[];
  /** 预签名链接查询串里的哨兵签名 */
  signature: string;
  /** 预签名链接的来源；缺省为本服务 */
  downloadOrigin: string;
  /** 下一次（或 times 次）匹配的请求回这个应答，优先于默认处理 */
  intercept(method: string, path: string | RegExp, reply: InterceptReply, times?: number): void;
  /** 直接登记一个代理（不经 API），首轮状态由调用方给 */
  seedAgent(opts: { name?: string; status?: string; runs?: Array<Partial<FakeRun>> }): FakeAgent;
  requestsTo(method: string, path: string | RegExp): RecordedRequest[];
  close(): Promise<void>;
}

const TERMINAL = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

/** 与实测 grok-4.7 同形，但只列出一部分变体，便于构造「组合不在 variants 里」 */
export const FAKE_MODELS = [
  { id: 'default', displayName: 'Auto', aliases: ['auto'], variants: [{ params: [], isDefault: true }] },
  {
    id: 'grok-4.7',
    displayName: 'Grok 4.7',
    parameters: [
      { id: 'context', values: [{ value: '256k' }, { value: '500k' }] },
      { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
    ],
    variants: [
      {
        params: [
          { id: 'context', value: '256k' },
          { id: 'reasoning_effort', value: 'high' },
          { id: 'fast', value: 'false' },
        ],
      },
      {
        params: [
          { id: 'context', value: '256k' },
          { id: 'reasoning_effort', value: 'high' },
          { id: 'fast', value: 'true' },
        ],
      },
      {
        params: [
          { id: 'context', value: '500k' },
          { id: 'reasoning_effort', value: 'high' },
          { id: 'fast', value: 'true' },
        ],
        isDefault: true,
      },
      {
        params: [
          { id: 'context', value: '500k' },
          { id: 'reasoning_effort', value: 'low' },
          { id: 'fast', value: 'false' },
        ],
      },
    ],
  },
  {
    id: 'composer-2.5',
    aliases: ['composer'],
    parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }],
    variants: [
      { params: [{ id: 'fast', value: 'true' }], isDefault: true },
      { params: [{ id: 'fast', value: 'false' }] },
    ],
  },
];

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function apiError(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

function agentJson(a: FakeAgent): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    env: { type: 'cloud' },
    repos: [],
    latestRunId: a.runs.at(-1)?.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function runJson(r: FakeRun): Record<string, unknown> {
  return {
    id: r.id,
    agentId: r.agentId,
    status: r.status,
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(r.result !== undefined ? { result: r.result } : {}),
  };
}

function writeSse(res: ServerResponse, e: SseEvent): void {
  if (res.destroyed || res.writableEnded) return;
  const lines: string[] = [];
  if (e.id !== undefined) lines.push(`id: ${e.id}`);
  lines.push(`event: ${e.event}`);
  lines.push(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`);
  res.write(`${lines.join('\n')}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

export async function startFakeCursor(): Promise<FakeCursor> {
  const intercepts: Array<{ method: string; path: string | RegExp; reply: InterceptReply; left: number }> = [];
  const matches = (p: string | RegExp, path: string) => (typeof p === 'string' ? path === p : p.test(path));

  const fake: FakeCursor = {
    baseUrl: '',
    requests: [],
    accounts: new Map(),
    models: FAKE_MODELS,
    agents: new Map(),
    streams: new Map(),
    createDelays: [],
    signature: `SIGSENTINEL${randomUUID().replace(/-/g, '')}`,
    downloadOrigin: '',
    intercept(method, path, reply, times = 1) {
      intercepts.push({ method, path, reply, left: times });
    },
    seedAgent({ name = 'aalis-paper-00000000', status = 'IDLE', runs = [] }) {
      const id = `bc-${randomUUID()}`;
      const agent: FakeAgent = {
        id,
        name,
        status,
        runs: runs.map(r => ({ id: `run-${randomUUID()}`, agentId: id, status: 'FINISHED', ...r })),
        artifacts: new Map(),
        body: {},
      };
      fake.agents.set(id, agent);
      return agent;
    },
    requestsTo(method, path) {
      return fake.requests.filter(r => r.method === method && matches(path, r.path.split('?')[0]));
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    },
  };

  const pending = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    if (ms <= 0) {
      fn();
      return;
    }
    const t = setTimeout(() => {
      pending.delete(t);
      fn();
    }, ms);
    pending.add(t);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const body = await readBody(req);
    const rec: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      headers: req.headers,
      body,
    };
    fake.requests.push(rec);
    const path = url.pathname;
    const method = rec.method;

    // 预签名下载：不看 Authorization
    const s3 = /^\/s3\/([^/]+)\/(.+)$/.exec(path);
    if (s3 && method === 'GET') {
      const art = fake.agents.get(s3[1])?.artifacts.get(decodeURIComponent(s3[2]));
      if (!art || url.searchParams.get('X-Amz-Signature') !== fake.signature) {
        res.writeHead(403);
        res.end('denied');
        return;
      }
      // 不给 Content-Length，分块发送：只有边读边计字节才能发现实际大小
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const step = 16 * 1024;
      for (let i = 0; i < art.data.byteLength; i += step) {
        if (res.destroyed) return;
        res.write(art.data.subarray(i, i + step));
        await new Promise(r => setImmediate(r));
      }
      res.end();
      return;
    }

    for (const it of intercepts) {
      if (it.left > 0 && it.method === method && matches(it.path, path)) {
        it.left--;
        const payload = it.reply.bodyFrom ? it.reply.bodyFrom(rec) : it.reply.body;
        const reply = () => json(res, it.reply.status, payload ?? '', it.reply.headers);
        later(reply, it.reply.delayMs ?? 0);
        return;
      }
    }

    const auth = req.headers.authorization ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    const account = fake.accounts.get(key);
    if (!account) {
      apiError(res, 401, 'unauthorized', `Invalid API key ${key.slice(0, 12)}`);
      return;
    }

    // 带 JSON 头却没有 body 的 POST：实测回 400（框架层的错误体）
    if (method === 'POST' && (req.headers['content-type'] ?? '').includes('application/json') && body === '') {
      json(res, 400, { code: 'error', message: "Body cannot be empty when content-type is set to 'application/json'" });
      return;
    }

    if (method === 'GET' && path === '/v1/me') {
      json(res, 200, {
        apiKeyName: 'placeholder-key',
        ...(account.userId !== undefined ? { userId: account.userId } : {}),
        createdAt: '2026-01-01T00:00:00.000Z',
        userEmail: 'owner@example.invalid',
        userFirstName: 'Placeholder',
        userLastName: 'Owner',
      });
      return;
    }
    if (method === 'GET' && path === '/v1/models') {
      json(res, 200, { items: fake.models });
      return;
    }
    if (method === 'GET' && path === '/v1/agents') {
      json(res, 200, { items: [...fake.agents.values()].map(agentJson) });
      return;
    }
    if (method === 'POST' && path === '/v1/agents') {
      const b = JSON.parse(body) as Record<string, unknown>;
      const agentId = String(b.agentId ?? '');
      if (!/^bc-[0-9a-f-]{36}$/.test(agentId)) {
        apiError(res, 400, 'validation_error', "Agent ID must be in the format 'bc-<uuid>'");
        return;
      }
      if (fake.agents.has(agentId)) {
        apiError(res, 409, 'agent_id_conflict', 'An agent with this agentId already exists.');
        return;
      }
      const run: FakeRun = { id: `run-${randomUUID()}`, agentId, status: 'RUNNING' };
      const agent: FakeAgent = {
        id: agentId,
        name: String(b.name ?? ''),
        status: 'ACTIVE',
        runs: [run],
        artifacts: new Map(),
        body: b,
      };
      fake.agents.set(agentId, agent);
      later(() => json(res, 201, { agent: agentJson(agent), run: runJson(run) }), fake.createDelays.shift() ?? 0);
      return;
    }

    const m = /^\/v1\/agents\/([^/]+)(?:\/(.*))?$/.exec(path);
    const agent = m ? fake.agents.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !agent) {
      apiError(res, 404, 'agent_not_found', 'Agent not found');
      return;
    }
    const rest = m[2] ?? '';

    if (rest === '' && method === 'GET') {
      json(res, 200, agentJson(agent));
      return;
    }
    if (rest === '' && method === 'DELETE') {
      fake.agents.delete(agent.id);
      json(res, 200, { id: agent.id });
      return;
    }
    if ((rest === 'archive' || rest === 'unarchive') && method === 'POST') {
      agent.status = rest === 'archive' ? 'ARCHIVED' : 'IDLE';
      json(res, 200, { id: agent.id });
      return;
    }
    if (rest === 'runs' && method === 'GET') {
      json(res, 200, { items: agent.runs.map(runJson) });
      return;
    }
    if (rest === 'runs' && method === 'POST') {
      if (agent.status === 'ARCHIVED') {
        apiError(res, 409, 'agent_archived', 'Agent is archived');
        return;
      }
      const last = agent.runs.at(-1);
      if (last && !TERMINAL.has(last.status)) {
        apiError(res, 409, 'agent_busy', 'Agent already has an active run');
        return;
      }
      const run: FakeRun = { id: `run-${randomUUID()}`, agentId: agent.id, status: 'CREATING' };
      agent.runs.push(run);
      json(res, 201, { run: runJson(run) });
      return;
    }
    if (rest === 'usage' && method === 'GET') {
      const runId = url.searchParams.get('runId');
      const runs = agent.runs.filter(r => !runId || r.id === runId);
      if (runId && runs.length === 0) {
        apiError(res, 404, 'run_not_found', 'Run not found');
        return;
      }
      json(res, 200, {
        runs: runs.map(r => ({
          id: r.id,
          usageUuid: randomUUID(),
          usage: r.usage,
          ...(r.cost ? { cost: r.cost } : {}),
        })),
      });
      return;
    }
    if (rest === 'artifacts' && method === 'GET') {
      json(res, 200, {
        items: [...agent.artifacts].map(([p, a]) => ({
          path: p,
          sizeBytes: a.declaredSize ?? a.data.byteLength,
          updatedAt: '2026-01-01T00:00:00.000Z',
        })),
      });
      return;
    }
    if (rest === 'artifacts/download' && method === 'GET') {
      const p = url.searchParams.get('path') ?? '';
      if (!p.startsWith('artifacts/')) {
        apiError(res, 400, 'validation_error', 'Artifact path must be under artifacts/');
        return;
      }
      if (!agent.artifacts.has(p)) {
        apiError(res, 404, 'artifact_not_found', 'Artifact not found');
        return;
      }
      const origin = fake.downloadOrigin || fake.baseUrl;
      json(res, 200, {
        url: `${origin}/s3/${agent.id}/${encodeURIComponent(p)}?X-Amz-Expires=900&X-Amz-Signature=${fake.signature}`,
        expiresAt: '2026-01-01T00:15:00.000Z',
      });
      return;
    }

    const rm = /^runs\/([^/]+)(?:\/(stream|cancel))?$/.exec(rest);
    const run = rm ? agent.runs.find(r => r.id === decodeURIComponent(rm[1])) : undefined;
    if (!rm || !run) {
      apiError(res, 404, 'run_not_found', 'Run not found');
      return;
    }
    if (rm[2] === undefined && method === 'GET') {
      json(res, 200, runJson(run));
      return;
    }
    if (rm[2] === 'cancel' && method === 'POST') {
      if (TERMINAL.has(run.status)) {
        apiError(res, 409, 'run_not_cancellable', 'Run is already finished');
        return;
      }
      run.status = 'CANCELLED';
      json(res, 200, { id: run.id });
      return;
    }
    if (rm[2] === 'stream' && method === 'GET') {
      const seg = fake.streams.get(run.id)?.shift();
      seg?.before?.();
      if (seg?.status !== undefined && seg.status !== 200) {
        json(res, seg.status, seg.body ?? '');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const events =
        seg?.events ??
        (TERMINAL.has(run.status)
          ? [
              { event: 'status', data: { runId: run.id, status: run.status } },
              {
                id: '9999999999999-0',
                event: 'result',
                data: { runId: run.id, status: run.status, text: run.result, durationMs: run.durationMs },
              },
            ]
          : []);
      for (const e of events) writeSse(res, e);
      const end = seg?.end ?? (seg || TERMINAL.has(run.status) ? 'done' : 'hang');
      if (end === 'done') {
        writeSse(res, { id: '9999999999999-0', event: 'done', data: {} });
        res.end();
      } else if (end === 'eof') {
        res.end();
      }
      return;
    }
    apiError(res, 404, 'not_found', 'Not found');
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: String(err) } });
      else res.destroy();
    });
  });
  server.on('close', () => {
    for (const t of pending) clearTimeout(t);
    pending.clear();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
