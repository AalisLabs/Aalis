import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type TriggerProvider, trigger } from '../../packages/api-trigger/src/index.js';
import { App, type LogEntry, LogHub, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import layaPlugin from '../../packages/plugin-trigger-laya/src/index.js';
import { createSelfCheck } from '../../packages/plugin-trigger-laya/src/self-check.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import { buildIncomingContent, type IncomingMessage, type Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// plugin-trigger-laya：trigger 服务的 Laya 模型提供者。
//
// 侧车一律用本地 http.createServer 做的假侧车（不碰真实侧车）；memory 用内存替身。
// 前半直接调提供者的 decide，验证请求体、模式、阈值、弃权与熔断；中段与相位宿主
// plugin-trigger-policy 联调，验证影子期由规则判定、live 由模型判定及各种回落；
// 末段是运行期自检（判定时的 cur 与归档正文比对），联调用真实 message-archive 与内存 memory。
// ════════════════════════════════════════════════════════════

const LAYA_LABEL = 'Laya 模型';
const RULE_LABEL = '规则（计数/评分）';
const AT = '<at self id="10000">Aalis</at> ';

interface ScoreRequest {
  rows: Array<{ role: string; content: string; userId?: string; nick?: string }>;
  cur: string;
  curUserId?: string;
  curNick?: string;
  replyTo: { userId?: string; nickname?: string } | null;
  selfId: string;
}

/** 假侧车的一次应答：hang = 收下请求不应答；stall = 发完响应头、体只发一半就停住；body 为字符串时原样发出 */
type Reply = 'hang' | 'stall' | { status: number; body: unknown };

const score = (logit: number, threshold = 0): Reply => ({
  status: 200,
  body: { logit, threshold, version: 'v-test' },
});

interface Sidecar {
  url: string;
  requests: Array<{ body: ScoreRequest; headers: IncomingHttpHeaders }>;
  reply: (body: ScoreRequest) => Reply;
}

const servers: Server[] = [];
const booted: App[] = [];
let sidecar: Sidecar;

async function startSidecar(): Promise<Sidecar> {
  const state: Sidecar = { url: '', requests: [], reply: () => score(1) };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // 与真实侧车一致：只认 POST /v1/score，其余 404（不记为一次打分请求）
      if (req.method !== 'POST' || req.url !== '/v1/score') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not_found"}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ScoreRequest;
      state.requests.push({ body, headers: req.headers });
      const r = state.reply(body);
      if (r === 'hang') return;
      if (r === 'stall') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"logit":');
        return; // 永不 end
      }
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

beforeEach(async () => {
  sidecar = await startSidecar();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const app of booted.splice(0)) await app.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

const groupMsg = (content: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'group',
  sessionId: 'onebot:10000:group:20001',
  groupId: '20001',
  userId: '30001',
  nickname: '甲',
  ...extra,
});

const privateMsg = (content: string): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'private',
  sessionId: 'onebot:10001:private:30001',
  userId: '30001',
  nickname: '甲',
});

/** 窗口投影用的历史：system / tool / notice 行与非字符串正文应被丢弃，无昵称时 nick 回落 name */
const HISTORY: Message[] = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '乙: 早', name: '30002', metadata: { userId: '30002', nickname: '乙' } },
  { role: 'user', content: '30003: 在吗', name: '30003', metadata: { userId: '30003' } },
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }],
  },
  { role: 'tool', content: '工具结果', toolCallId: 't1' },
  { role: 'assistant', content: '在的' },
  { role: 'notice', content: '[notice/poke] 丙 戳了戳 Aalis' },
];

const EXPECTED_ROWS = [
  { role: 'user', content: '乙: 早', userId: '30002', nick: '乙' },
  { role: 'user', content: '30003: 在吗', userId: '30003', nick: '30003' },
  { role: 'assistant', content: '在的' },
];

/** 与真实后端一致：取最近 limit 行，按时间升序 */
function fakeMemory(history: Message[] = HISTORY) {
  const recent = async (_sid: string, limit = 200) => history.slice(-limit);
  return { getHistory: vi.fn(recent), getFullHistory: vi.fn(recent) };
}

interface SetupOptions {
  /** Laya 配置；endpoint 默认指向假侧车 */
  laya?: Record<string, unknown>;
  /** memory 替身；null = 不提供 memory */
  memory?: Partial<MemoryService> | null;
  /** 同时装相位宿主 trigger-policy，值为它的配置 */
  host?: Record<string, unknown>;
  archived?: string[];
  media?: { processMessage(msg: IncomingMessage): Promise<unknown> };
  /** 装真实的 message-archive 与内存 memory（memory 选项随之不用） */
  realArchive?: boolean;
}

async function setup(opts: SetupOptions = {}) {
  const logHub = new LogHub();
  const logs: LogEntry[] = [];
  logHub.onEntry(e => logs.push(e));
  const app = new App({ name: 'T', logLevel: 'debug', logHub });
  booted.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, hooks, services, messageArchive });
  if (opts.realArchive) {
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.register(messageArchivePlugin, { debugLogs: false });
  } else if (opts.memory !== null) host.provide(memory, (opts.memory ?? fakeMemory()) as never);
  if (opts.media) host.provide(media, opts.media as never);
  const archived = opts.archived;
  if (archived) {
    host.provide(messageArchive, {
      async archiveIncoming(m: IncomingMessage) {
        archived.push(m.content);
      },
    } as never);
  }
  await app.plugins.register(layaPlugin, { endpoint: sidecar.url, ...opts.laya });
  if (opts.host) {
    host.provide(gateway, {} as never); // 满足宿主的 required 依赖；相位判定本身不经过 gateway
    await app.plugins.register(triggerPolicyPlugin, opts.host);
  }
  await app.plugins.idle();
  // 激活闸：依赖缺席时插件停在 pending 而不报错，不核状态会让整组用例伪装成绿
  const defs = [
    layaPlugin,
    ...(opts.host ? [triggerPolicyPlugin] : []),
    ...(opts.realArchive ? [memoryInMemory, messageArchivePlugin] : []),
  ];
  for (const def of defs) {
    const state = app.plugins.getPlugin(def.name)?.state;
    if (state !== 'active') throw new Error(`${def.name} 未激活（state=${state}）`);
  }
  const view = host.services.all(trigger).find(v => v.label === LAYA_LABEL);
  if (!view) throw new Error('Laya 提供者不在 trigger 服务里');
  return { host, laya: view.instance, logs };
}

/** 直接问提供者；记下 awaitAttachmentDescriptions 被调用的次数，调用时按需写入附件描述 */
async function ask(laya: TriggerProvider, message: IncomingMessage, addressed = false, descs?: string[]) {
  let awaited = 0;
  const decision = await laya.decide({
    message,
    addressed,
    async awaitAttachmentDescriptions() {
      awaited++;
      if (descs) message._attachmentDescriptions = descs;
    },
  });
  return { decision, awaited };
}

const warns = (logs: LogEntry[]) => logs.filter(e => e.level === 'warn').map(e => e.message);

describe('plugin-trigger-laya：请求与判定', () => {
  it('live：请求体按侧车接口拼好（窗口投影、与归档一致的 cur、发言人、引用、selfId），按 logit ≥ 阈值开口', async () => {
    const mem = fakeMemory();
    const { laya } = await setup({ laya: { mode: 'live' }, memory: mem });
    const message = groupMsg('看看这个', {
      replyTo: { messageId: '1', content: '原话', userId: '30002', nickname: '乙' },
      attachments: [{ kind: 'image', data: 'https://example.invalid/a.jpg' }],
    });

    const { decision, awaited } = await ask(laya, message, true, ['[图片: 一只猫]']);
    expect(decision).toEqual({ speak: true, reason: 'Laya v-test 阈值=0', score: 1 });
    expect(awaited, '拼 cur 之前先等附件描述').toBe(1);
    expect(mem.getFullHistory, '多取一倍，过滤后留 80 行').toHaveBeenCalledWith('onebot:10000:group:20001', 160);
    expect(sidecar.requests).toHaveLength(1);
    const { body, headers } = sidecar.requests[0];
    expect(headers['content-type']).toBe('application/json');
    expect(Number(headers['content-length']), '侧车要求 Content-Length').toBeGreaterThan(0);
    expect(body.rows).toEqual(EXPECTED_ROWS);
    expect(body.cur).toBe(buildIncomingContent(message));
    expect(body.cur).toContain('[图片: 一只猫]');
    expect(body.cur).toContain('原话');
    expect(body).toMatchObject({ curUserId: '30001', curNick: '甲', selfId: '10000' });
    expect(body.replyTo).toEqual({ userId: '30002', nickname: '乙' });
  });

  it('没有 getFullHistory 的 memory 回落 getHistory；historyRows 可配；无引用时 replyTo 为 null', async () => {
    const mem = { getHistory: vi.fn(async () => HISTORY) };
    const { laya } = await setup({ laya: { mode: 'live', historyRows: 20 }, memory: mem });
    await ask(laya, groupMsg('随便聊聊'));
    expect(mem.getHistory).toHaveBeenCalledWith('onebot:10000:group:20001', 40);
    expect(sidecar.requests[0].body.rows).toEqual(EXPECTED_ROWS);
    expect(sidecar.requests[0].body.replyTo).toBeNull();
  });

  it('historyRows 只算 user / assistant 行：tool 等行占掉的额度靠多取补上，过滤后只留最后 historyRows 行', async () => {
    const u = (content: string): Message => ({ role: 'user', content, name: '30002', metadata: { userId: '30002' } });
    const mem = fakeMemory([
      u('一'),
      u('二'),
      u('三'),
      { role: 'assistant', content: '四' },
      { role: 'tool', content: '工具结果', toolCallId: 't1' },
      u('五'),
      { role: 'notice', content: '[notice/poke] 丙 戳了戳 Aalis' },
    ]);
    const { laya } = await setup({ laya: { mode: 'live', historyRows: 3 }, memory: mem });
    await ask(laya, groupMsg('x'));
    expect(mem.getFullHistory).toHaveBeenCalledWith('onebot:10000:group:20001', 6);
    expect(sidecar.requests[0].body.rows.map(r => r.content)).toEqual(['三', '四', '五']);
  });

  it('请求体超过侧车上限（1 MiB，按 UTF-8 字节计）：不发请求，直接弃权，不计失败', async () => {
    // 40 万个汉字：字符数不到 1 MiB，UTF-8 编码后约 1.2 MB
    const big: Message = { role: 'user', content: '字'.repeat(400_000), name: '30002', metadata: { userId: '30002' } };
    const history = [big];
    const { laya, logs } = await setup({ laya: { mode: 'live' }, memory: fakeMemory(history) });
    for (let i = 0; i < 4; i++) expect((await ask(laya, groupMsg(`第 ${i} 条`))).decision).toBeNull();
    expect(sidecar.requests).toHaveLength(0);
    expect(warns(logs)).toEqual([]);

    // 大行滚出窗口后照常请求：前面 4 次若计失败，这里已在熔断期
    history.splice(0, 1, ...HISTORY);
    expect((await ask(laya, groupMsg('照常'))).decision).toMatchObject({ speak: true });
    expect(sidecar.requests).toHaveLength(1);
  });

  it('off：直接弃权，不等附件、不发请求', async () => {
    const { laya } = await setup({ laya: { mode: 'off' } });
    const r = await ask(laya, groupMsg('随便聊聊'));
    expect(r).toEqual({ decision: null, awaited: 0 });
    expect(sidecar.requests).toHaveLength(0);
  });

  it('shadow（默认）：照常请求并记一行 info（不含正文与昵称），然后弃权', async () => {
    sidecar.reply = () => score(0.5, 1);
    const { laya, logs } = await setup();
    const r = await ask(laya, groupMsg('这是一段不该进日志的正文'), true);
    expect(r.decision).toBeNull();
    expect(sidecar.requests).toHaveLength(1);
    const lines = logs.filter(e => e.message.startsWith('[laya] 影子判定'));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    for (const part of [
      'session=onebot:10000:group:20001',
      'logit=0.500',
      '阈值=1',
      '会开口=false',
      'addressed=true',
      '版本=v-test',
    ]) {
      expect(lines[0].message).toContain(part);
    }
    expect(lines[0].message).toMatch(/耗时=\d+ms/);
    expect(lines[0].message).not.toContain('不该进日志');
    expect(lines[0].message).not.toContain('甲');
  });

  it('阈值来源：配置 > 侧车；logit 等于阈值即开口', async () => {
    sidecar.reply = () => score(0.5, 1);
    const fromSidecar = await setup({ laya: { mode: 'live' } });
    expect((await ask(fromSidecar.laya, groupMsg('a'))).decision).toMatchObject({ speak: false, score: 0.5 });

    const fromConfig = await setup({ laya: { mode: 'live', threshold: 0.5 } });
    expect((await ask(fromConfig.laya, groupMsg('b'))).decision).toEqual({
      speak: true,
      reason: 'Laya v-test 阈值=0.5',
      score: 0.5,
    });
  });

  it('按作用域覆盖 mode / threshold，最具体者胜', async () => {
    sidecar.reply = () => score(0.5, 0);
    const { laya, logs } = await setup({
      laya: {
        mode: 'shadow',
        threshold: 0.2,
        overrides: [
          { scope: '*:group', mode: 'live' },
          { scope: 'onebot:group:20002', mode: 'off' },
          { scope: 'onebot:group:20003', threshold: 0.8 },
        ],
      },
    });
    const inGroup = (gid: string) => groupMsg('x', { sessionId: `onebot:10000:group:${gid}`, groupId: gid });

    expect((await ask(laya, inGroup('20001'))).decision).toMatchObject({ speak: true, reason: 'Laya v-test 阈值=0.2' });
    expect((await ask(laya, inGroup('20002'))).decision, 'targetId 级 off 压过 *:group 的 live').toBeNull();
    expect(sidecar.requests).toHaveLength(1);
    // 只覆盖阈值的条目：mode 穿透到顶层 shadow（不继承另一条 *:group 的 live）
    expect((await ask(laya, inGroup('20003'))).decision).toBeNull();
    expect(
      logs.some(e => e.message.includes('session=onebot:10000:group:20003') && e.message.includes('阈值=0.8')),
    ).toBe(true);
    // 私聊不命中任何覆盖：顶层 shadow
    expect((await ask(laya, privateMsg('y'))).decision).toBeNull();
    expect(sidecar.requests).toHaveLength(3);
  });

  it('selfId：群与私聊从 onebot 会话 ID 解析；非 onebot 与频道会话弃权且不发请求', async () => {
    const { laya } = await setup({ laya: { mode: 'live' } });
    await ask(laya, groupMsg('群'));
    await ask(laya, privateMsg('私聊'));
    expect(sidecar.requests.map(r => r.body.selfId)).toEqual(['10000', '10001']);

    const webui: IncomingMessage = { content: 'hi', platform: 'webui', sessionId: 'webui:default' };
    const channel = groupMsg('频道', { sessionType: 'channel', sessionId: 'onebot:10000:channel:40001:50001' });
    expect(await ask(laya, webui)).toEqual({ decision: null, awaited: 0 });
    expect(await ask(laya, channel)).toEqual({ decision: null, awaited: 0 });
    expect(sidecar.requests).toHaveLength(2);
  });

  it('非法或留空的配置值回退默认：模式 shadow、阈值用侧车的、历史 80 行；endpoint 末尾斜杠去掉', async () => {
    sidecar.reply = () => score(0.5, 1);
    const mem = fakeMemory();
    const { laya, logs } = await setup({
      laya: { mode: 'bogus', threshold: null, historyRows: 0, endpoint: `${sidecar.url}/` },
      memory: mem,
    });
    expect((await ask(laya, groupMsg('x'))).decision).toBeNull();
    expect(sidecar.requests).toHaveLength(1);
    expect(mem.getFullHistory).toHaveBeenCalledWith('onebot:10000:group:20001', 160);
    expect(logs.some(e => e.message.startsWith('[laya] 影子判定') && e.message.includes('阈值=1'))).toBe(true);
  });

  it('memory 缺席：弃权，不发请求', async () => {
    const { laya, logs } = await setup({ laya: { mode: 'live' }, memory: null });
    expect(await ask(laya, groupMsg('x'))).toEqual({ decision: null, awaited: 0 });
    expect(sidecar.requests).toHaveLength(0);
    expect(warns(logs), '正常弃权，不是异常').toEqual([]);
  });

  it('取历史抛错：自己兜住，弃权并记 warn', async () => {
    const mem = {
      getFullHistory: async () => {
        throw new Error('库不可用');
      },
    };
    const { laya, logs } = await setup({ laya: { mode: 'live' }, memory: mem as never });
    expect((await ask(laya, groupMsg('x'))).decision).toBeNull();
    expect(warns(logs).some(m => m.includes('[laya] 判定异常') && m.includes('库不可用'))).toBe(true);
  });
});

describe('plugin-trigger-laya：失败与熔断', () => {
  const answered: Array<[what: string, reply: Reply]> = [
    ['422（消息不适合交给模型）', { status: 422, body: { error: 'system_notice' } }],
    ['413（请求体超限，发请求前判断的兜底）', { status: 413, body: { error: 'too_large' } }],
  ];
  it.each(answered)('%s：弃权，不计失败，并把此前的失败计数清零', async (_what, reply) => {
    let next: Reply = reply;
    sidecar.reply = () => next;
    const { laya, logs } = await setup({ laya: { mode: 'live' } });
    for (let i = 0; i < 4; i++) expect((await ask(laya, groupMsg('[系统通知] x'))).decision).toBeNull();
    expect(sidecar.requests).toHaveLength(4);

    // 失败 2 次 → 422 / 413 → 再失败 1 次：中间清零过，不熔断，下一条照常请求
    next = { status: 500, body: { error: 'internal' } };
    await ask(laya, groupMsg('a'));
    await ask(laya, groupMsg('b'));
    next = reply;
    await ask(laya, groupMsg('c'));
    next = { status: 500, body: { error: 'internal' } };
    await ask(laya, groupMsg('d'));
    next = score(1);
    expect((await ask(laya, groupMsg('e'))).decision).toMatchObject({ speak: true });
    expect(sidecar.requests).toHaveLength(9);
    expect(warns(logs)).toEqual([]);
  });

  const failures: Array<[what: string, reply: Reply]> = [
    ['超时', 'hang'],
    ['响应体发一半停住（读体也在超时窗口内）', 'stall'],
    ['HTTP 500', { status: 500, body: { error: 'non_finite' } }],
    ['HTTP 400', { status: 400, body: { error: 'bad_field:rows' } }],
    ['响应不是 JSON', { status: 200, body: 'not json' }],
    ['logit 不是有限数', { status: 200, body: { logit: null, threshold: 0, version: 'v-test' } }],
    ['响应缺 threshold 且配置未填阈值', { status: 200, body: { logit: 1, version: 'v-test' } }],
  ];
  it.each(failures)('%s计一次失败：连续第 3 次熔断并记 warn，熔断期不发请求', async (_what, reply) => {
    sidecar.reply = () => reply;
    // 超时留足余量：假侧车与客户端在同一进程，负载高时事件循环卡顿，超时过短会在请求送达假侧车之前就中止，
    // 这次请求没被记下。改成收到请求即记也关不住这个窗口（中止可能早于请求送达）
    const { laya, logs } = await setup({ laya: { mode: 'live', timeoutMs: 500 } });
    for (let i = 0; i < 3; i++) expect((await ask(laya, groupMsg(`第 ${i} 条`))).decision).toBeNull();
    expect(sidecar.requests).toHaveLength(3);
    expect(warns(logs).filter(m => m.includes('熔断 30s'))).toHaveLength(1);

    expect(await ask(laya, groupMsg('熔断期'))).toEqual({ decision: null, awaited: 0 });
    expect(sidecar.requests, '熔断期不发请求').toHaveLength(3);
  });

  it('连不上侧车同样计失败并熔断', async () => {
    const { laya, logs } = await setup({ laya: { mode: 'live', endpoint: `http://127.0.0.1:${await freePort()}` } });
    for (let i = 0; i < 3; i++) expect((await ask(laya, groupMsg(`第 ${i} 条`))).decision).toBeNull();
    expect(warns(logs).filter(m => m.includes('熔断 30s'))).toHaveLength(1);
  });

  it('熔断 30s 后恢复请求：成功一次记恢复并清零，此后要再连续失败 3 次才熔断', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let next: Reply = { status: 500, body: { error: 'internal' } };
    sidecar.reply = () => next;
    const { laya, logs } = await setup({ laya: { mode: 'live' } });
    for (let i = 0; i < 3; i++) await ask(laya, groupMsg(`失败 ${i}`));
    expect(sidecar.requests).toHaveLength(3);

    next = score(1);
    vi.setSystemTime(Date.now() + 29_999);
    expect((await ask(laya, groupMsg('还在熔断'))).decision).toBeNull();
    expect(sidecar.requests).toHaveLength(3);

    vi.setSystemTime(Date.now() + 2);
    expect((await ask(laya, groupMsg('恢复'))).decision).toMatchObject({ speak: true });
    expect(sidecar.requests).toHaveLength(4);
    expect(warns(logs).filter(m => m.includes('熔断解除'))).toHaveLength(1);

    next = { status: 500, body: { error: 'internal' } };
    await ask(laya, groupMsg('再失败 1'));
    await ask(laya, groupMsg('再失败 2'));
    next = score(1);
    expect((await ask(laya, groupMsg('照常'))).decision).toMatchObject({ speak: true });
    expect(sidecar.requests).toHaveLength(7);
    expect(warns(logs).filter(m => m.includes('熔断 30s'))).toHaveLength(1);
  });

  it('熔断到期后再失败：立即重新熔断，同一次故障不再记 warn；恢复记一条，之后的新故障照常告警', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let next: Reply = { status: 500, body: { error: 'internal' } };
    sidecar.reply = () => next;
    const { laya, logs } = await setup({ laya: { mode: 'live' } });
    const tripped = () => warns(logs).filter(m => m.includes('熔断 30s'));
    for (let i = 0; i < 3; i++) await ask(laya, groupMsg(`失败 ${i}`));
    vi.setSystemTime(Date.now() + 30_001);
    await ask(laya, groupMsg('试探'));
    expect(sidecar.requests).toHaveLength(4);
    await ask(laya, groupMsg('又熔断'));
    expect(sidecar.requests).toHaveLength(4);
    expect(tripped(), '同一次故障只在转入熔断时告警').toHaveLength(1);
    expect(logs.some(e => e.level === 'debug' && e.message.includes('连续 4 次失败'))).toBe(true);

    vi.setSystemTime(Date.now() + 30_001);
    next = score(1);
    expect((await ask(laya, groupMsg('恢复'))).decision).toMatchObject({ speak: true });
    expect(warns(logs).filter(m => m.includes('熔断解除'))).toHaveLength(1);

    next = { status: 500, body: { error: 'internal' } };
    for (let i = 0; i < 3; i++) await ask(laya, groupMsg(`新故障 ${i}`));
    expect(tripped(), '恢复后的新故障照常告警').toHaveLength(2);
  });

  it('并发失败：同一次故障只记一条熔断 warn；到期后并发到达的请求都会发出，再失败也只记 debug', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sidecar.reply = () => 'hang';
    const { laya, logs } = await setup({ laya: { mode: 'live', timeoutMs: 500 } });
    const burst = (tag: string) => Promise.all(Array.from({ length: 5 }, (_, i) => ask(laya, groupMsg(`${tag} ${i}`))));
    await burst('挂起');
    expect(sidecar.requests).toHaveLength(5);
    vi.setSystemTime(Date.now() + 30_001);
    await burst('到期');
    expect(sidecar.requests).toHaveLength(10);
    expect(warns(logs).filter(m => m.includes('熔断 30s'))).toHaveLength(1);
  });
});

/** 驱动宿主的 inbound:trigger 钩子链；记下是否放行 */
async function run(chain: Hooks, message: IncomingMessage) {
  let reached = false;
  await chain.run('inbound:trigger', { message, metadata: {}, agent: undefined }, async () => {
    reached = true;
  });
  return { reached, message };
}

const decisionLogs = (logs: LogEntry[]) => logs.filter(e => e.message.startsWith('[trigger] 判定')).map(e => e.message);

describe('plugin-trigger-laya：与相位宿主 trigger-policy 联调', () => {
  /** 规则提供者对每条未点名的群消息都开口 */
  const EVERY_MESSAGE = { intervalMode: 'fixed', fixedInterval: 1 };

  it('shadow：Laya 记影子判定后弃权，由规则判定', async () => {
    sidecar.reply = () => score(-3, 0);
    const { host, logs } = await setup({ host: EVERY_MESSAGE });
    const r = await run(host.hooks, groupMsg('随便聊聊'));
    expect(r.reached, '规则开口；Laya 的「不开口」只进日志').toBe(true);
    expect(sidecar.requests).toHaveLength(1);
    expect(logs.some(e => e.message.includes('会开口=false'))).toBe(true);
    const [line] = decisionLogs(logs);
    expect(line).toContain(`决定者=${RULE_LABEL}`);
    expect(line).toContain(`弃权=${LAYA_LABEL}(弃权)`);
  });

  it('live：Laya 决定；Laya 开口后规则计数清零', async () => {
    let next = score(1);
    sidecar.reply = () => next;
    const { host, logs } = await setup({ laya: { mode: 'live' }, host: { intervalMode: 'fixed', fixedInterval: 3 } });

    const spoke = await run(host.hooks, groupMsg('第一条'));
    expect(spoke.reached).toBe(true);
    expect(spoke.message.triggerType).toBe('interval');
    expect(decisionLogs(logs)[0]).toContain(`决定者=${LAYA_LABEL}`);
    expect(decisionLogs(logs)[0]).toContain('score=1');

    // 之后 Laya 弃权（422）交给规则：规则从 0 计，第 3 条才开口（未清零则第 2 条就凑满）
    next = { status: 422, body: { error: 'empty_cur' } };
    const reached: boolean[] = [];
    for (let i = 1; i <= 3; i++) reached.push((await run(host.hooks, groupMsg(`第 ${i} 条`))).reached);
    expect(reached).toEqual([false, false, true]);
  });

  it('live：@ 消息也交模型，判不回时被吞并归档；判回时记 immediate', async () => {
    let next = score(-3, 0);
    sidecar.reply = () => next;
    const archived: string[] = [];
    const { host } = await setup({ laya: { mode: 'live' }, host: {}, archived });

    const silent = await run(host.hooks, groupMsg(`${AT}在吗`));
    expect(silent.reached).toBe(false);
    expect(silent.message.triggerType).toBeUndefined();
    expect(archived).toEqual([`${AT}在吗`]);

    next = score(3, 0);
    const spoke = await run(host.hooks, groupMsg(`${AT}还在吗`));
    expect(spoke.reached).toBe(true);
    expect(spoke.message.triggerType).toBe('immediate');
  });

  const fallbacks: Array<[what: string, tag: string, opts: SetupOptions, reply: Reply]> = [
    ['侧车超过 Laya 自己的超时', '弃权', { laya: { mode: 'live', timeoutMs: 30 } }, 'hang'],
    [
      '侧车超过宿主的截止时间',
      '超时',
      { laya: { mode: 'live', timeoutMs: 1000 }, host: { ...EVERY_MESSAGE, decisionTimeoutMs: 30 } },
      'hang',
    ],
    [
      'Laya 内部抛错（取历史失败）',
      '弃权',
      {
        laya: { mode: 'live' },
        memory: {
          getFullHistory: async () => {
            throw new Error('库不可用');
          },
        } as never,
      },
      score(-3),
    ],
  ];
  it.each(fallbacks)('%s：回落规则判定', async (_what, tag, opts, reply) => {
    sidecar.reply = () => reply;
    const { host, logs } = await setup({ ...opts, host: opts.host ?? EVERY_MESSAGE });
    const r = await run(host.hooks, groupMsg('随便聊聊'));
    expect(r.reached).toBe(true);
    const [line] = decisionLogs(logs);
    expect(line).toContain(`决定者=${RULE_LABEL}`);
    expect(line).toContain(`弃权=${LAYA_LABEL}(${tag})`);
  });

  it('偏好切到规则（WebUI 服务页的回滚方式）：即时生效，Laya 不再被问', async () => {
    sidecar.reply = () => score(-3, 0);
    const { host } = await setup({ laya: { mode: 'live' }, host: EVERY_MESSAGE });
    expect((await run(host.hooks, groupMsg('第一条'))).reached).toBe(false);
    expect(sidecar.requests).toHaveLength(1);

    const rule = host.services.all(trigger).find(v => v.label === RULE_LABEL);
    expect(rule, '规则提供者应在 trigger 服务里').toBeDefined();
    host.services.prefer(trigger, rule?.contextId ?? '');
    expect((await run(host.hooks, groupMsg('第二条'))).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(1);
  });

  it('priority 配到规则之下：规则先判且不弃权，Laya 不会被问到', async () => {
    const { host } = await setup({ laya: { mode: 'live', priority: -1 }, host: EVERY_MESSAGE });
    expect((await run(host.hooks, groupMsg('x'))).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(0);
  });

  it('带图消息：Laya 经宿主启动识别并自己等到描述写好，cur 带上描述', async () => {
    const recognized: IncomingMessage[] = [];
    const svc = {
      async processMessage(msg: IncomingMessage) {
        recognized.push(msg);
        msg._attachmentDescriptions = ['[图片: 一只猫]'];
        return { total: 1, successCount: 1, items: [] };
      },
    };
    const { host } = await setup({ laya: { mode: 'live' }, host: {}, media: svc });
    const message = groupMsg('看图', { attachments: [{ kind: 'image', data: 'https://example.invalid/a.jpg' }] });
    const r = await run(host.hooks, message);
    expect(r.reached).toBe(true);
    expect(recognized).toHaveLength(1);
    expect(sidecar.requests[0].body.cur).toBe(buildIncomingContent(message));
    expect(sidecar.requests[0].body.cur).toContain('[图片: 一只猫]');
  });
});

describe('plugin-trigger-laya：运行期自检', () => {
  const IMAGE = { kind: 'image', data: 'https://example.invalid/a.jpg' } as const;
  const FILE = { kind: 'file', data: 'aalis-file://f1', name: 'a.txt' } as const;

  /** 直接驱动自检表：每结清 reportEvery 条交出一行，这里收下所有行 */
  function selfCheck(capacity = 1000, reportEvery = 1) {
    const lines: string[] = [];
    return { lines, ...createSelfCheck(line => lines.push(line), capacity, reportEvery) };
  }

  const summary = (match: number, missing: number, file: number, other: number, unarchived: number) =>
    `[laya] 自检 | 一致=${match} | 不一致:缺附件描述=${missing} | 不一致:含文件附件=${file} | ` +
    `不一致:其它=${other} | 未归档=${unarchived}`;

  it('分桶：逐字一致；不一致按判定时缺附件描述、含文件附件、其它归类，两个原因都成立时计入缺附件描述', () => {
    const c = selfCheck();
    const sid = 'onebot:10000:group:20001';
    const msg = (messageId: string, extra: Partial<IncomingMessage> = {}) => groupMsg('x', { messageId, ...extra });

    c.record(msg('1'), 'cur-1');
    c.settle(sid, '1', 'cur-1');
    expect(c.lines.at(-1)).toBe(summary(1, 0, 0, 0, 0));

    // 图片判定时还没有描述，归档时补上
    c.record(msg('2', { attachments: [IMAGE] }), 'cur-2');
    c.settle(sid, '2', 'cur-2\n[图片: 一只猫]');
    // 文件描述到 agent 预处理阶段才写入
    c.record(msg('3', { attachments: [FILE] }), 'cur-3');
    c.settle(sid, '3', 'cur-3\n[文件 a.txt]');
    // 长度相同、内容不同也算不一致（有描述的图片不算缺）
    c.record(msg('4', { attachments: [IMAGE], _attachmentDescriptions: ['[图片: 一只猫]'] }), 'cur-4');
    c.settle(sid, '4', 'cur-X');
    // 文件与没识别完的图片同时在：计入缺附件描述
    c.record(msg('5', { attachments: [FILE, IMAGE] }), 'cur-5');
    c.settle(sid, '5', 'cur-5\n[文件 a.txt]\n[图片: 一只猫]');
    expect(c.lines.at(-1)).toBe(summary(1, 2, 1, 1, 0));

    // 带附件但归档与判定时一致（如识别失败两边都没有描述）：计一致
    c.record(msg('6', { attachments: [IMAGE, FILE] }), 'cur-6');
    c.settle(sid, '6', 'cur-6');
    expect(c.lines.at(-1)).toBe(summary(2, 2, 1, 1, 0));
  });

  it('缺附件描述按每个非文件附件判：描述表在、但有一张图没有描述也算缺', () => {
    const c = selfCheck();
    const two = groupMsg('x', {
      messageId: '1',
      attachments: [IMAGE, IMAGE],
      _attachmentDescriptions: ['[图片: 一只猫]'],
    });
    c.record(two, 'cur-1');
    c.settle('onebot:10000:group:20001', '1', 'cur-1\n[图片: 一只狗]');
    expect(c.lines).toEqual([summary(0, 1, 0, 0, 0)]);
  });

  it('没有消息 ID 的判定不记；没记过的键不计；取出即删，同一条再归档不再计', () => {
    const c = selfCheck(2);
    // 不同会话的三条无 ID 消息：若被记下会撑破上限 2、淘汰出「未归档」
    for (const gid of ['20001', '20002', '20003']) {
      c.record(groupMsg('x', { sessionId: `onebot:10000:group:${gid}` }), 'cur');
      c.settle(`onebot:10000:group:${gid}`, undefined, 'cur');
    }
    c.settle('onebot:10000:group:20001', '9', 'cur');
    expect(c.lines).toEqual([]);

    c.record(groupMsg('x', { messageId: '1' }), 'cur');
    c.settle('onebot:10000:group:20002', '1', 'cur');
    expect(c.lines, '键带会话 ID：别的会话同号消息不算').toEqual([]);
    c.settle('onebot:10000:group:20001', '1', 'cur');
    c.settle('onebot:10000:group:20001', '1', 'cur');
    expect(c.lines).toEqual([summary(1, 0, 0, 0, 0)]);
  });

  it('超过上限按记下的先后淘汰最早的一条，计入未归档；被淘汰的再归档不计', () => {
    const c = selfCheck(2);
    const sid = 'onebot:10000:group:20001';
    for (const id of ['1', '2', '3']) c.record(groupMsg('x', { messageId: id }), `cur-${id}`);
    expect(c.lines).toEqual([summary(0, 0, 0, 0, 1)]);
    c.settle(sid, '1', 'cur-1');
    expect(c.lines).toHaveLength(1);
    c.settle(sid, '2', 'cur-2');
    c.settle(sid, '3', 'cur-3');
    expect(c.lines.at(-1)).toBe(summary(2, 0, 0, 0, 1));
  });

  it('每结清 reportEvery 条记一行累计计数，比对与淘汰都算', () => {
    const c = selfCheck(1, 3);
    const sid = 'onebot:10000:group:20001';
    c.record(groupMsg('x', { messageId: '1' }), 'a');
    c.record(groupMsg('x', { messageId: '2' }), 'b'); // 淘汰 1
    c.settle(sid, '2', 'b');
    expect(c.lines).toEqual([]);
    c.record(groupMsg('x', { messageId: '3' }), 'c');
    c.settle(sid, '3', 'x');
    expect(c.lines).toEqual([summary(1, 0, 0, 1, 1)]);
  });

  it('发请求前就记下：侧车回 422、请求失败、宿主不等了（侧车还没回）时照样比对', async () => {
    const { host, laya, logs } = await setup({ realArchive: true, laya: { timeoutMs: 500 } });
    const archive = host.messageArchive.require();
    let n = 0;
    const next = () => groupMsg(`第 ${++n} 条正文`, { messageId: String(1000 + n) });

    // 宿主不等了：侧车收到请求、还没回，这条已归档（宿主放弃判定后照常往下走）
    let arrived = () => {};
    const reached = new Promise<void>(r => {
      arrived = r;
    });
    sidecar.reply = () => {
      arrived();
      return 'hang';
    };
    const waiting = next();
    const deciding = ask(laya, waiting);
    await reached;
    await archive.archiveIncoming(waiting);
    expect((await deciding).decision, 'Laya 自己超时，计一次失败').toBeNull();

    sidecar.reply = () => ({ status: 500, body: { error: 'internal' } });
    const failed = next();
    await ask(laya, failed);
    await archive.archiveIncoming(failed);

    // 其余侧车回 422（消息不适合交给模型），凑满 200 条结清
    sidecar.reply = () => ({ status: 422, body: { error: 'system_notice' } });
    for (let i = 0; i < 198; i++) {
      const m = next();
      await ask(laya, m);
      await archive.archiveIncoming(m);
    }
    expect(sidecar.requests).toHaveLength(200);
    expect(logs.filter(e => e.message.startsWith('[laya] 自检')).map(e => e.message)).toEqual([
      summary(200, 0, 0, 0, 0),
    ]);
  });

  it('真实归档：只比对向侧车发了请求的判定，每结清 200 条记一行 info，只含计数', async () => {
    const recognizer = {
      async processMessage(msg: IncomingMessage) {
        msg._attachmentDescriptions = msg.attachments?.map(a => (a.kind === 'file' ? undefined : '[图片: 一只猫]'));
        return { total: 1, successCount: 1, items: [] };
      },
    };
    const { host, laya, logs } = await setup({
      realArchive: true,
      media: recognizer,
      laya: { overrides: [{ scope: 'onebot:group:20002', mode: 'off' }] },
    });
    const archive = host.messageArchive.require();
    const lines = () => logs.filter(e => e.message.startsWith('[laya] 自检'));
    let n = 0;
    const next = (extra: Partial<IncomingMessage> = {}) =>
      groupMsg(`第 ${++n} 条正文`, { messageId: String(1000 + n), ...extra });
    const decideThenArchive = async (m: IncomingMessage, beforeArchive?: () => void) => {
      await ask(laya, m);
      beforeArchive?.();
      await archive.archiveIncoming(m);
    };

    // 不发请求的判定不记：off 的会话、请求体超限（窗口里有一条 1.2 MB 的行）
    await decideThenArchive(next({ sessionId: 'onebot:10000:group:20002', groupId: '20002' }));
    await archive.archiveIncoming(groupMsg('字'.repeat(400_000), { sessionId: 'onebot:10000:group:20003' }));
    await decideThenArchive(next({ sessionId: 'onebot:10000:group:20003', groupId: '20003' }));
    // 没有消息 ID 的不记
    await decideThenArchive(groupMsg('没有消息 ID'));
    expect(sidecar.requests).toHaveLength(1);

    // 图片识别在判定之后才写好描述（Laya 没等到），归档时经 media 补上
    await decideThenArchive(next({ attachments: [IMAGE] }));
    // 文件描述在归档前才写入（file-reader 在 agent 预处理阶段）
    const file = next({ attachments: [FILE] });
    await decideThenArchive(file, () => {
      file._attachmentDescriptions = ['[文件 a.txt] 文件内容'];
    });
    // 判定后发送者昵称被改（同长度）：原因不明的不一致
    const renamed = next();
    await decideThenArchive(renamed, () => {
      renamed.nickname = '乙';
    });
    for (let i = 0; i < 196; i++) await decideThenArchive(next());
    expect(lines(), '结清 199 条时还不记').toEqual([]);

    await decideThenArchive(next());
    expect(sidecar.requests).toHaveLength(201);
    const [line, ...rest] = lines();
    expect(rest).toEqual([]);
    expect(line.level).toBe('info');
    expect(line.message).toBe(summary(197, 1, 1, 1, 0));
    for (const secret of ['onebot', '20001', '1001', '甲', '乙', '正文', '猫', '文件内容']) {
      expect(line.message).not.toContain(secret);
    }
  });
});
