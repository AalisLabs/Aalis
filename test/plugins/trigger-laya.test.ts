import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CheckResult, type CheckSpec, doctor } from '../../packages/api-doctor/src/index.js';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type PersonaService, type PersonaSessionOptions, persona } from '../../packages/api-persona/src/index.js';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { trigger } from '../../packages/api-trigger/src/index.js';
import { App, type LogEntry, LogHub, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import layaPlugin from '../../packages/plugin-trigger-laya/src/index.js';
import { createSelfCheck } from '../../packages/plugin-trigger-laya/src/self-check.js';
import { buildIncomingContent, type IncomingMessage, type Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// plugin-trigger-laya：自成一体的模型触发插件。
//
// 侧车一律用本地 http.createServer 做的假侧车（不碰真实侧车）；memory、flow-control、message-archive、
// media、persona、doctor 用内存替身。经 inbound:trigger 钩子链驱动，验证判定各步骤、请求体、阈值、
// 兜底（只回点名）与熔断告警、诊断项；末段是运行期自检（判定时的 cur 与归档正文比对），联调用真实
// message-archive 与内存 memory。与 trigger-policy 二选一的联调见 trigger-select.test.ts。
// ════════════════════════════════════════════════════════════

const LAYA_LABEL = 'Laya 模型';
const AT = '<at self id="10000">Aalis</at> ';
const GROUP_SID = 'onebot:10000:group:20001';

interface ScoreRequest {
  rows: Array<{ role: string; content: string; userId?: string; nick?: string }>;
  cur: string;
  curUserId?: string;
  curNick?: string;
  replyTo: { userId?: string; nickname?: string } | null;
  selfId: string;
  selfNames: string[];
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
  /** GET /health 的应答 */
  health: Reply;
}

const servers: Server[] = [];
const booted: App[] = [];
let sidecar: Sidecar;

function respond(res: ServerResponse, r: Reply): void {
  if (r === 'hang') return;
  if (r === 'stall') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"logit":');
    return; // 永不 end
  }
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
}

async function startSidecar(): Promise<Sidecar> {
  const state: Sidecar = {
    url: '',
    requests: [],
    reply: () => score(1),
    health: { status: 200, body: { ok: true, version: 'v-test' } },
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // 与真实侧车一致：只认 GET /health 与 POST /v1/score，其余 404（不记为一次打分请求）
      if (req.method === 'GET' && req.url === '/health') return respond(res, state.health);
      if (req.method !== 'POST' || req.url !== '/v1/score') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not_found"}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ScoreRequest;
      state.requests.push({ body, headers: req.headers });
      respond(res, state.reply(body));
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
  sessionId: GROUP_SID,
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

const pokeMsg = (): IncomingMessage => groupMsg('[戳一戳: 甲(30001) 戳了你]', { noticeType: 'poke' });

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

/** 假 media：记下被识别的消息，识别完给图片写描述（文件附件不写） */
function fakeMedia(finish: (msg: IncomingMessage) => Promise<void> = async () => {}) {
  const calls: IncomingMessage[] = [];
  const svc = {
    async processMessage(msg: IncomingMessage) {
      calls.push(msg);
      await finish(msg);
      msg._attachmentDescriptions = msg.attachments?.map(a => (a.kind === 'file' ? undefined : '[图片: 一只猫]'));
      return { total: 1, successCount: 1, items: [] };
    },
  };
  return { svc, calls };
}

interface SetupOptions {
  /** Laya 配置；endpoint 默认指向假侧车 */
  laya?: Record<string, unknown>;
  /** memory 替身；null = 不提供 memory */
  memory?: Partial<MemoryService> | null;
  media?: { processMessage(msg: IncomingMessage): Promise<unknown> };
  /** persona 提供者，按顺序登记（先登记者为胜者） */
  personas?: PersonaService[];
  /** session-manager 替身：只用 resolveConfig */
  sessionManager?: Pick<SessionManagerService, 'resolveConfig'>;
  /** 装真实的 message-archive 与内存 memory（memory 选项随之不用，归档替身不装） */
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

  // flow-control 替身：禁言表与 setMuted 调用（连同 platform：真实实现在会话还没有流控状态时，
  // 不带 platform 就什么都不做）
  const flow = {
    muted: new Set<string>(),
    setMuted: [] as Array<[sessionId: string, seconds: number, platform?: string]>,
  };
  host.provide(flowControl, {
    isMuted: sid => flow.muted.has(sid),
    isCoolingDown: () => false,
    isRateLimited: () => false,
    setMuted: (sid, seconds, platform) => {
      flow.muted.add(sid);
      flow.setMuted.push([sid, seconds, platform]);
    },
  });
  // doctor 替身：收下登记的检查项
  const checks: CheckSpec[] = [];
  host.provide(doctor, {
    registerCheck(spec: CheckSpec) {
      checks.push(spec);
      return () => {};
    },
  } as never);

  const archived: string[] = [];
  if (opts.realArchive) {
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.register(messageArchivePlugin, { debugLogs: false });
  } else {
    if (opts.memory !== null) host.provide(memory, (opts.memory ?? fakeMemory()) as never);
    host.provide(messageArchive, {
      async archiveIncoming(m: IncomingMessage) {
        archived.push(m.content);
      },
    } as never);
  }
  if (opts.media) host.provide(media, opts.media as never);
  for (const p of opts.personas ?? []) host.provide(persona, p);
  if (opts.sessionManager) host.provide(sessionManager, opts.sessionManager as SessionManagerService);
  await app.plugins.register(layaPlugin, { endpoint: sidecar.url, ...opts.laya });
  await app.plugins.idle();
  // 激活闸：依赖缺席时插件停在 pending 而不报错，不核状态会让整组用例伪装成绿
  for (const def of [layaPlugin, ...(opts.realArchive ? [memoryInMemory, messageArchivePlugin] : [])]) {
    const state = app.plugins.getPlugin(def.name)?.state;
    if (state !== 'active') throw new Error(`${def.name} 未激活（state=${state}）`);
  }
  if (host.services.all(trigger)[0]?.label !== LAYA_LABEL) throw new Error('Laya 不是 trigger 服务的胜者');
  const check = checks.find(c => c.id === 'trigger.laya');
  if (!check) throw new Error('Laya 没有登记诊断项');
  return {
    host,
    logs,
    archived,
    flow,
    send: (message: IncomingMessage) => run(host.hooks, message),
    diagnose: async () => (await check.run()) as CheckResult,
  };
}

/** 驱动 inbound:trigger 钩子链；记下是否放行 */
async function run(chain: Hooks, message: IncomingMessage) {
  let reached = false;
  await chain.run('inbound:trigger', { message, metadata: {}, agent: undefined }, async () => {
    reached = true;
  });
  return { reached, message };
}

const byLevel = (logs: LogEntry[], level: LogEntry['level']) => logs.filter(e => e.level === level).map(e => e.message);
const decisions = (logs: LogEntry[]) => logs.filter(e => e.message.startsWith('[laya] 判定 |'));

describe('plugin-trigger-laya：请求与判定', () => {
  it('请求体按侧车接口拼好（窗口投影、与归档一致的 cur、发言人、引用、selfId），logit ≥ 阈值即开口', async () => {
    const mem = fakeMemory();
    const { svc, calls } = fakeMedia();
    const { send } = await setup({ memory: mem, media: svc });
    const message = groupMsg('看看这个', {
      replyTo: { messageId: '1', content: '原话', userId: '30002', nickname: '乙' },
      attachments: [{ kind: 'image', data: 'https://example.invalid/a.jpg' }],
    });

    const r = await send(message);
    expect(r.reached).toBe(true);
    expect(calls, '拼 cur 之前先等附件识别，只识别一次').toEqual([message]);
    expect(mem.getFullHistory, '多取一倍，过滤后留 80 行').toHaveBeenCalledWith(GROUP_SID, 160);
    expect(sidecar.requests).toHaveLength(1);
    const { body, headers } = sidecar.requests[0];
    expect(headers['content-type']).toBe('application/json');
    expect(Number(headers['content-length']), '侧车要求 Content-Length').toBeGreaterThan(0);
    expect(body.rows).toEqual(EXPECTED_ROWS);
    expect(body.cur).toBe(buildIncomingContent(message));
    expect(body.cur).toContain('[图片: 一只猫]');
    expect(body.cur).toContain('原话');
    expect(body).toMatchObject({ curUserId: '30001', curNick: '甲', selfId: '10000', selfNames: [] });
    expect(body.replyTo).toEqual({ userId: '30002', nickname: '乙' });
  });

  it('当前消息没有昵称时 curNick 回落 userId，与历史行的 nick 和训练导出同一口径', async () => {
    const { send } = await setup();
    await send(groupMsg('[戳一戳: 30009 戳了你]', { userId: '30009', nickname: undefined, noticeType: 'poke' }));
    await send(groupMsg('有人在吗', { userId: '30010', nickname: '' }));
    expect(sidecar.requests.map(r => r.body.curNick)).toEqual(['30009', '30010']);
  });

  it('孤代理：请求体里的字符串先换成 U+FFFD 再发（侧车分词器不收孤代理，整条只能兜底）', async () => {
    const lone = '😀'.slice(0, 1); // 截在 emoji 中间
    const mem = fakeMemory([
      { role: 'user', content: `乙: 转发${lone}`, name: '30002', metadata: { userId: '30002', nickname: `乙${lone}` } },
    ]);
    const { send } = await setup({ memory: mem });
    await send(
      groupMsg(`转发摘要${lone}`, {
        nickname: `甲${lone}`,
        replyTo: { messageId: '1', content: '原话', userId: '30002', nickname: `乙${lone}` },
      }),
    );
    const { body } = sidecar.requests[0];
    const strings = [body.cur, body.curNick, body.replyTo?.nickname, ...body.rows.flatMap(r => [r.content, r.nick])];
    for (const s of strings) expect(s).not.toMatch(/\p{Cs}/u);
    expect(body.cur).toContain('转发摘要�');
    expect(body.rows[0]).toMatchObject({ content: '乙: 转发�', nick: '乙�' });
  });

  it('没有 getFullHistory 的 memory 回落 getHistory；historyRows 可配；无引用时 replyTo 为 null', async () => {
    const mem = { getHistory: vi.fn(async () => HISTORY) };
    const { send } = await setup({ laya: { historyRows: 20 }, memory: mem });
    await send(groupMsg('随便聊聊'));
    expect(mem.getHistory).toHaveBeenCalledWith(GROUP_SID, 40);
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
    const { send } = await setup({ laya: { historyRows: 3 }, memory: mem });
    await send(groupMsg('x'));
    expect(mem.getFullHistory).toHaveBeenCalledWith(GROUP_SID, 6);
    expect(sidecar.requests[0].body.rows.map(r => r.content)).toEqual(['三', '四', '五']);
  });

  it('阈值来源：配置 > 侧车；logit 等于阈值即开口', async () => {
    sidecar.reply = () => score(0.5, 1);
    const fromSidecar = await setup();
    expect((await fromSidecar.send(groupMsg('a'))).reached).toBe(false);

    const fromConfig = await setup({ laya: { threshold: 0.5 } });
    expect((await fromConfig.send(groupMsg('b'))).reached).toBe(true);
  });

  it('按作用域覆盖阈值，最具体者胜；只写阈值的覆盖也启用该作用域', async () => {
    sidecar.reply = () => score(0.5, 0);
    const { send, logs } = await setup({
      laya: {
        threshold: 0.2,
        overrides: [
          { scope: '*:group', threshold: 0.4 },
          { scope: 'onebot:group:20002', threshold: 0.8 },
          { scope: 'onebot:private:30001', threshold: 0.6 },
        ],
      },
    });
    const inGroup = (gid: string) => groupMsg('x', { sessionId: `onebot:10000:group:${gid}`, groupId: gid });

    expect((await send(inGroup('20001'))).reached, '*:group 的 0.4').toBe(true);
    expect((await send(inGroup('20002'))).reached, 'targetId 级 0.8 压过 *:group').toBe(false);
    expect((await send(privateMsg('y'))).reached, '私聊不在默认作用域，但覆盖条目启用了它').toBe(false);
    expect(sidecar.requests).toHaveLength(3);
    expect(decisions(logs).map(e => e.message.match(/阈值=([\d.]+)/)?.[1])).toEqual(['0.4', '0.8', '0.6']);
  });

  it('判定日志：每次判定一行 debug（会话、开口、点名、logit、阈值、版本、耗时），不含正文与昵称', async () => {
    const { send, logs } = await setup();
    await send(groupMsg('这是一段不该进日志的正文'));
    const lines = decisions(logs);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('debug');
    expect(lines[0].message).toMatch(
      /^\[laya\] 判定 \| session=onebot:10000:group:20001 \| speak=true \| addressed=false \| logit=1\.000 \| 阈值=0 \| 版本=v-test \| 耗时=\d+ms$/,
    );
    expect(lines[0].message).not.toContain('不该进日志');
    expect(lines[0].message).not.toContain('甲');
  });

  it('非法或留空的配置值回退默认：阈值用侧车的、历史 80 行；endpoint 末尾斜杠去掉', async () => {
    sidecar.reply = () => score(0.5, 1);
    const mem = fakeMemory();
    const { send } = await setup({
      laya: { threshold: null, historyRows: 0, endpoint: `${sidecar.url}/` },
      memory: mem,
    });
    expect((await send(groupMsg('x'))).reached, '0.5 < 侧车阈值 1').toBe(false);
    expect(sidecar.requests).toHaveLength(1);
    expect(mem.getFullHistory).toHaveBeenCalledWith(GROUP_SID, 160);
  });
});

describe('plugin-trigger-laya：判定各步骤', () => {
  it('带 source 的内部注入：不判定，triggerType 原样保留', async () => {
    const { send } = await setup();
    const r = await send(groupMsg('委派任务', { source: 'delegate', triggerType: 'proactive' }));
    expect(r.reached).toBe(true);
    expect(r.message.triggerType).toBe('proactive');
    expect(sidecar.requests).toHaveLength(0);
  });

  it('作用域：私聊不在默认作用域，直接放行、不写 triggerType；scopes 纳入后照常判定', async () => {
    sidecar.reply = () => score(-3);
    const byDefault = await setup();
    const r = await byDefault.send(privateMsg('在吗'));
    expect(r.reached).toBe(true);
    expect(r.message.triggerType).toBeUndefined();
    expect(sidecar.requests).toHaveLength(0);

    const withPrivate = await setup({ laya: { scopes: ['*:group', '*:private'] } });
    expect((await withPrivate.send(privateMsg('在吗'))).reached).toBe(false);
    expect(sidecar.requests).toHaveLength(1);
  });

  it('禁言期：放行给 flow 相位，不判定、不识别禁言关键词', async () => {
    const { send, flow } = await setup({ laya: { muteKeywords: '闭嘴' } });
    flow.muted.add(GROUP_SID);
    const r = await send(groupMsg('闭嘴'));
    expect(r.reached).toBe(true);
    expect(flow.setMuted).toEqual([]);
    expect(sidecar.requests).toHaveLength(0);
  });

  it('作用域外的禁言关键词：放行，不设禁言、不归档、不判定（作用域判断先于禁言关键词）', async () => {
    const { send, flow, archived } = await setup({ laya: { muteKeywords: '闭嘴' } });
    const r = await send(privateMsg('你闭嘴吧'));
    expect(r.reached).toBe(true);
    expect(flow.setMuted).toEqual([]);
    expect(archived).toEqual([]);
    expect(sidecar.requests).toHaveLength(0);
  });

  it('禁言关键词：设自禁言、归档后吞掉，不判定；戳一戳的合成文案不当关键词', async () => {
    const { send, flow, archived } = await setup({ laya: { muteKeywords: '闭嘴,安静', muteTimeSeconds: 120 } });
    const r = await send(groupMsg('你们安静点'));
    expect(r.reached).toBe(false);
    // 带 platform：新群或重启后还没人回复过的群，flow-control 里还没有这个会话的状态
    expect(flow.setMuted).toEqual([[GROUP_SID, 120, 'onebot']]);
    expect(archived).toEqual(['你们安静点']);
    expect(sidecar.requests).toHaveLength(0);

    flow.muted.clear();
    await send(groupMsg('[戳一戳: 闭嘴(30001) 戳了你]', { noticeType: 'poke' }));
    expect(flow.setMuted).toHaveLength(1);
    expect(sidecar.requests).toHaveLength(1);
  });

  it('@ 与叫名字不强制开口：模型判不回就吞掉并归档；判回时记 immediate，授权主体维持缺省', async () => {
    let next = score(-3);
    sidecar.reply = () => next;
    const persona: PersonaService = { getSystemPrompt: () => '', getPersonaName: () => 'Aalis' };
    const { send, archived } = await setup({ personas: [persona] });

    expect((await send(groupMsg(`${AT}在吗`))).reached).toBe(false);
    expect((await send(groupMsg('Aalis 在吗'))).reached).toBe(false);
    expect((await send(pokeMsg())).reached).toBe(false);
    expect(archived).toEqual([`${AT}在吗`, 'Aalis 在吗', '[戳一戳: 甲(30001) 戳了你]']);

    next = score(3);
    const spoke = await send(groupMsg('Aalis 还在吗'));
    expect(spoke.reached).toBe(true);
    expect(spoke.message.triggerType).toBe('immediate');
    expect(spoke.message.actor).toBeUndefined();
  });

  it('没点名、模型判回：记 interval 并回填无主体授权；判不回：归档后吞掉', async () => {
    let next = score(1);
    sidecar.reply = () => next;
    const { send, archived } = await setup();
    const spoke = await send(groupMsg('随便聊聊'));
    expect(spoke.reached).toBe(true);
    expect(spoke.message.triggerType).toBe('interval');
    expect(spoke.message.actor).toEqual({ platform: 'onebot', userId: '' });

    next = score(-1);
    const silent = await send(groupMsg('再聊聊'));
    expect(silent.reached).toBe(false);
    expect(silent.message.triggerType).toBeUndefined();
    expect(archived).toEqual(['再聊聊']);
  });

  it('triggerOnPoke 关闭：戳一戳不算点名，模型判回时记 interval', async () => {
    const { send } = await setup({ laya: { triggerOnPoke: false } });
    const r = await send(pokeMsg());
    expect(r.reached).toBe(true);
    expect(r.message.triggerType).toBe('interval');
  });

  it('名字表是别名与全部人设的名字、昵称：叫任何一个都算点名，同一份作为 selfNames 发给侧车', async () => {
    const card = (name: string, nicks: string[]): PersonaService => ({
      getSystemPrompt: () => '',
      getPersonaName: () => name,
      getNickNames: () => nicks,
    });
    // 判定不了时兜底 speak = 是否被点名：用 422 让判定落到兜底，放行与否即点名与否
    sidecar.reply = () => ({ status: 422, body: { error: 'empty_cur' } });
    const tooLong = '长'.repeat(33);
    const { send } = await setup({
      laya: { triggerNames: '阿狸' },
      personas: [card('Aalis', ['小A', tooLong]), card('Bob', ['阿狸'])],
    });
    const byOther = await send(groupMsg('Bob 在吗'));
    expect(byOther.reached, '第二个人设的名字也算点名').toBe(true);
    expect(byOther.message.triggerType).toBe('immediate');
    expect(sidecar.requests[0].body.selfNames, '别名在前，去重；超过 32 个字符的名字不发').toEqual([
      '阿狸',
      'Aalis',
      '小A',
      'Bob',
    ]);
    expect((await send(groupMsg('随便聊聊'))).reached).toBe(false);
  });

  it('selfNames 至多 32 个：多出的取前面的（别名与生效的人设在前）', async () => {
    const aliases = Array.from({ length: 40 }, (_, i) => `别名${i}`);
    const { send } = await setup({ laya: { triggerNames: aliases.join(',') } });
    await send(groupMsg('随便聊聊'));
    expect(sidecar.requests[0].body.selfNames).toEqual(aliases.slice(0, 32));
  });

  it('某个人设读名字抛错（persona 故障）：只跳过它的名字，照常问模型；同一原因只告警一次', async () => {
    const broken: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: () => {
        throw new Error('persona 故障');
      },
    };
    const good: PersonaService = { getSystemPrompt: () => '', getPersonaName: () => 'Aalis' };
    sidecar.reply = () => score(-1);
    const { send, logs } = await setup({ personas: [broken, good] });
    const r = await send(groupMsg('Aalis 在吗'));
    expect(r.reached, '模型判不回就吞掉，不因人设故障直接放行').toBe(false);
    expect(sidecar.requests).toHaveLength(1);
    expect(sidecar.requests[0].body.selfNames).toEqual(['Aalis']);
    expect(decisions(logs).at(-1)?.message).toContain('addressed=true');

    await send(groupMsg('Aalis 还在吗'));
    const warns = byLevel(logs, 'warn').filter(m => m.includes('读名字失败'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^\[laya\] 人设「.*」读名字失败.*persona 故障/);
  });

  it('附件识别超过 mediaWaitMs：照常判定（cur 缺描述），识别在后台继续，只识别一次', async () => {
    const gate = deferred();
    const { svc, calls } = fakeMedia(() => gate.promise);
    const { send } = await setup({ laya: { mediaWaitMs: 20 }, media: svc });
    const message = groupMsg('看图', { attachments: [{ kind: 'image', data: 'https://example.invalid/a.jpg' }] });
    const r = await send(message);
    expect(r.reached).toBe(true);
    expect(sidecar.requests[0].body.cur).not.toContain('一只猫');
    gate.resolve();
    await vi.waitFor(() => expect(message._attachmentDescriptions).toEqual(['[图片: 一只猫]']));
    expect(calls).toHaveLength(1);
  });

  it('名字表按会话取人设：两个会话用不同的卡，点名识别与发给侧车的 selfNames 各用各的，不串', async () => {
    const byCard: Record<string, [string, string[]]> = { bob: ['Bob', ['阿B']] };
    const pick = (o?: PersonaSessionOptions): [string, string[]] =>
      (o?.persona && byCard[o.persona]) || ['Aalis', ['小A']];
    const card: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: o => pick(o)[0],
      getNickNames: o => pick(o)[1],
    };
    // 兜底 speak = 是否被点名：用 422 让判定落到兜底，放行与否即点名与否
    sidecar.reply = () => ({ status: 422, body: { error: 'empty_cur' } });
    const { send } = await setup({
      personas: [card],
      sessionManager: { resolveConfig: sid => (sid === GROUP_SID ? { persona: 'bob' } : {}) },
    });
    const inOther = (content: string) => groupMsg(content, { sessionId: 'onebot:10000:group:20002', groupId: '20002' });

    expect((await send(groupMsg('Bob 在吗'))).reached).toBe(true);
    expect((await send(groupMsg('Aalis 在吗'))).reached, '改用 bob 卡的会话里叫主卡名不算点名').toBe(false);
    expect((await send(inOther('Aalis 在吗'))).reached).toBe(true);
    expect((await send(inOther('Bob 在吗'))).reached, '用主卡的会话里叫 bob 不算点名').toBe(false);
    expect(sidecar.requests.map(r => r.body.selfNames)).toEqual([
      ['Bob', '阿B'],
      ['Bob', '阿B'],
      ['Aalis', '小A'],
      ['Aalis', '小A'],
    ]);
  });
});

describe('plugin-trigger-laya：兜底（只回点名）', () => {
  const failures: Array<[what: string, reply: Reply]> = [
    ['超时', 'hang'],
    ['响应体发一半停住（读体也在超时窗口内）', 'stall'],
    ['HTTP 500', { status: 500, body: { error: 'non_finite' } }],
    ['HTTP 400', { status: 400, body: { error: 'bad_field:rows' } }],
    ['响应不是 JSON', { status: 200, body: 'not json' }],
    ['logit 不是有限数', { status: 200, body: { logit: null, threshold: 0, version: 'v-test' } }],
    ['响应缺 threshold 且配置未填阈值', { status: 200, body: { logit: 1, version: 'v-test' } }],
  ];
  it.each(failures)('%s计一次失败：连续第 3 次熔断并记一条 error，熔断期不发请求', async (_what, reply) => {
    sidecar.reply = () => reply;
    // 超时留足余量：假侧车与客户端在同一进程，负载高时事件循环卡顿，超时过短会在请求送达假侧车之前就中止，
    // 这次请求没被记下。改成收到请求即记也关不住这个窗口（中止可能早于请求送达）
    const { send, logs } = await setup({ laya: { timeoutMs: 500 } });
    for (let i = 0; i < 3; i++) expect((await send(groupMsg(`第 ${i} 条`))).reached).toBe(false);
    expect(sidecar.requests).toHaveLength(3);
    const errors = byLevel(logs, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('判定不可用');
    expect(errors[0]).toContain('只回点名');

    expect((await send(groupMsg('熔断期'))).reached).toBe(false);
    expect(sidecar.requests, '熔断期不发请求').toHaveLength(3);
  });

  it('不可用期间只回点名：@、叫名字、戳一戳放行并记 immediate，其余吞掉归档；不等附件识别', async () => {
    sidecar.reply = () => ({ status: 500, body: { error: 'internal' } });
    const { svc, calls } = fakeMedia();
    const { send, archived, logs } = await setup({ laya: { triggerNames: '阿A' }, media: svc });
    for (let i = 0; i < 3; i++) await send(groupMsg(`失败 ${i}`));
    archived.length = 0;

    const at = await send(groupMsg(`${AT}在吗`));
    const named = await send(groupMsg('阿A 在吗'));
    const poke = await send(pokeMsg());
    const plain = await send(
      groupMsg('带图闲聊', { attachments: [{ kind: 'image', data: 'https://example.invalid/b.jpg' }] }),
    );
    expect([at, named, poke].map(r => [r.reached, r.message.triggerType])).toEqual([
      [true, 'immediate'],
      [true, 'immediate'],
      [true, 'immediate'],
    ]);
    expect(plain.reached).toBe(false);
    expect(archived).toEqual(['带图闲聊']);
    expect(calls, '兜底不等附件识别').toHaveLength(0);
    expect(sidecar.requests).toHaveLength(3);
    expect(decisions(logs).at(-1)?.message).toContain('兜底=侧车熔断中');
  });

  it('转入不可用的 error 不写死点名的类型：triggerOnPoke 关闭时不说戳一戳照常回复，戳一戳被吞', async () => {
    sidecar.reply = () => ({ status: 500, body: { error: 'internal' } });
    const { send, logs } = await setup({ laya: { triggerOnPoke: false } });
    for (let i = 0; i < 3; i++) await send(groupMsg(`失败 ${i}`));
    const [error, ...rest] = byLevel(logs, 'error');
    expect(rest).toEqual([]);
    expect(error).toContain('只回点名');
    expect(error).not.toContain('戳一戳');
    expect((await send(pokeMsg())).reached).toBe(false);
  });

  it('等附件识别期间熔断：等完不再发请求，本条兜底，也不把熔断往后推', async () => {
    sidecar.reply = () => ({ status: 500, body: { error: 'internal' } });
    const gate = deferred();
    const { svc, calls } = fakeMedia(() => gate.promise);
    const { send, logs } = await setup({ media: svc });
    const withImage = send(
      groupMsg('看图闲聊', { attachments: [{ kind: 'image', data: 'https://example.invalid/a.jpg' }] }),
    );
    // 进入识别等待时已过了判定前的熔断检查
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    for (let i = 0; i < 3; i++) await send(groupMsg(`失败 ${i}`));
    expect(sidecar.requests).toHaveLength(3);
    gate.resolve();
    expect((await withImage).reached).toBe(false);
    expect(sidecar.requests, '熔断期不发请求').toHaveLength(3);
    expect(byLevel(logs, 'debug').some(m => m.includes('连续 4 次失败'))).toBe(false);
    expect(decisions(logs).at(-1)?.message).toContain('兜底=侧车熔断中');
  });

  it('连不上侧车同样计失败并熔断', async () => {
    const { send, logs } = await setup({ laya: { endpoint: `http://127.0.0.1:${await freePort()}` } });
    for (let i = 0; i < 3; i++) await send(groupMsg(`第 ${i} 条`));
    expect(byLevel(logs, 'error')).toHaveLength(1);
  });

  it('熔断 30s 后恢复请求：成功一次记一条恢复 warn，此后要再连续失败 3 次才熔断', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let next: Reply = { status: 500, body: { error: 'internal' } };
    sidecar.reply = () => next;
    const { send, logs } = await setup();
    for (let i = 0; i < 3; i++) await send(groupMsg(`失败 ${i}`));
    expect(sidecar.requests).toHaveLength(3);

    next = score(1);
    vi.setSystemTime(Date.now() + 29_999);
    expect((await send(groupMsg('还在熔断'))).reached).toBe(false);
    expect(sidecar.requests).toHaveLength(3);

    vi.setSystemTime(Date.now() + 2);
    expect((await send(groupMsg('恢复'))).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(4);
    expect(byLevel(logs, 'warn').filter(m => m.includes('判定恢复'))).toHaveLength(1);

    next = { status: 500, body: { error: 'internal' } };
    await send(groupMsg('再失败 1'));
    await send(groupMsg('再失败 2'));
    next = score(1);
    expect((await send(groupMsg('照常'))).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(7);
    expect(byLevel(logs, 'error')).toHaveLength(1);
  });

  it('熔断到期后再失败：立即重新熔断，同一次故障不再记 error；恢复后的新故障照常告警', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let next: Reply = { status: 500, body: { error: 'internal' } };
    sidecar.reply = () => next;
    const { send, logs } = await setup();
    for (let i = 0; i < 3; i++) await send(groupMsg(`失败 ${i}`));
    vi.setSystemTime(Date.now() + 30_001);
    await send(groupMsg('试探'));
    expect(sidecar.requests).toHaveLength(4);
    await send(groupMsg('又熔断'));
    expect(sidecar.requests).toHaveLength(4);
    expect(byLevel(logs, 'error'), '同一次故障只在转入时告警').toHaveLength(1);
    expect(byLevel(logs, 'debug').some(m => m.includes('连续 4 次失败'))).toBe(true);

    vi.setSystemTime(Date.now() + 30_001);
    next = score(1);
    expect((await send(groupMsg('恢复'))).reached).toBe(true);
    expect(byLevel(logs, 'warn').filter(m => m.includes('判定恢复'))).toHaveLength(1);

    next = { status: 500, body: { error: 'internal' } };
    for (let i = 0; i < 3; i++) await send(groupMsg(`新故障 ${i}`));
    expect(byLevel(logs, 'error'), '恢复后的新故障照常告警').toHaveLength(2);
  });

  it('并发失败：同一次故障只记一条 error；到期后并发到达的请求都会发出，再失败也不再记', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sidecar.reply = () => 'hang';
    const { send, logs } = await setup({ laya: { timeoutMs: 500 } });
    const burst = (tag: string) => Promise.all(Array.from({ length: 5 }, (_, i) => send(groupMsg(`${tag} ${i}`))));
    await burst('挂起');
    expect(sidecar.requests).toHaveLength(5);
    vi.setSystemTime(Date.now() + 30_001);
    await burst('到期');
    expect(sidecar.requests).toHaveLength(10);
    expect(byLevel(logs, 'error')).toHaveLength(1);
  });

  const unsuitable: Array<[what: string, reply: Reply]> = [
    ['422（消息不适合交给模型）', { status: 422, body: { error: 'system_notice' } }],
    ['413（请求体超限，发请求前判断的兜底）', { status: 413, body: { error: 'too_large' } }],
  ];
  it.each(unsuitable)('%s：本条只回点名，不计失败，并把此前的失败计数清零', async (_what, reply) => {
    let next: Reply = reply;
    sidecar.reply = () => next;
    const { send, logs, archived } = await setup();
    expect((await send(groupMsg('[系统通知] x'))).reached).toBe(false);
    expect((await send(groupMsg(`${AT}在吗`))).message.triggerType).toBe('immediate');
    expect(archived).toEqual(['[系统通知] x']);
    for (let i = 0; i < 3; i++) await send(groupMsg(`第 ${i} 条`));
    expect(sidecar.requests).toHaveLength(5);

    // 失败 2 次 → 422 / 413 → 再失败 1 次：中间清零过，不熔断，下一条照常请求
    next = { status: 500, body: { error: 'internal' } };
    await send(groupMsg('a'));
    await send(groupMsg('b'));
    next = reply;
    await send(groupMsg('c'));
    next = { status: 500, body: { error: 'internal' } };
    await send(groupMsg('d'));
    next = score(1);
    expect((await send(groupMsg('e'))).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(10);
    expect(byLevel(logs, 'error')).toEqual([]);
  });

  it('熔断到期后先回 422 / 413：不算恢复，诊断仍报尚未确认恢复；之后再攒满 3 次失败属同一次故障，不另记 error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let next: Reply = { status: 500, body: { error: 'internal' } };
    sidecar.reply = () => next;
    const { send, logs, diagnose } = await setup();
    for (let i = 0; i < 3; i++) await send(groupMsg(`失败 ${i}`));
    vi.setSystemTime(Date.now() + 30_001);

    next = { status: 422, body: { error: 'system_notice' } };
    await send(groupMsg('[系统通知] x'));
    expect(sidecar.requests).toHaveLength(4);
    expect(
      byLevel(logs, 'warn').filter(m => m.includes('判定恢复')),
      '422 没有经过推理',
    ).toEqual([]);
    const stale = await diagnose();
    expect(stale.level).toBe('warn');
    expect(stale.message).toContain('尚未经请求确认恢复');

    next = { status: 500, body: { error: 'internal' } };
    for (let i = 0; i < 3; i++) await send(groupMsg(`又失败 ${i}`));
    expect(sidecar.requests, '422 清零了失败计数：要再攒满 3 次才重新熔断').toHaveLength(7);
    expect(byLevel(logs, 'error'), '同一次故障只在转入时告警').toHaveLength(1);

    vi.setSystemTime(Date.now() + 30_001);
    next = score(1);
    expect((await send(groupMsg('恢复'))).reached).toBe(true);
    expect(byLevel(logs, 'warn').filter(m => m.includes('判定恢复'))).toHaveLength(1);
    expect((await diagnose()).level).toBe('ok');
  });

  it('请求体超过侧车上限（1 MiB，按 UTF-8 字节计）：不发请求，本条只回点名并记 info，不计失败', async () => {
    // 40 万个汉字：字符数不到 1 MiB，UTF-8 编码后约 1.2 MB
    const big: Message = { role: 'user', content: '字'.repeat(400_000), name: '30002', metadata: { userId: '30002' } };
    const history = [big];
    const { send, logs } = await setup({ memory: fakeMemory(history) });
    for (let i = 0; i < 4; i++) expect((await send(groupMsg(`第 ${i} 条`))).reached).toBe(false);
    expect((await send(groupMsg(`${AT}在吗`))).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(0);
    expect(byLevel(logs, 'info').filter(m => m.includes('超过侧车上限'))).toHaveLength(5);
    expect(byLevel(logs, 'error')).toEqual([]);

    // 大行滚出窗口后照常请求：前面几次若计失败，这里已在熔断期
    history.splice(0, 1, ...HISTORY);
    expect((await send(groupMsg('照常'))).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(1);
  });

  it('memory 缺席：判定不可用，只回点名，记一条 error；memory 上线后判定恢复', async () => {
    const { host, send, logs } = await setup({ memory: null });
    expect((await send(groupMsg('随便聊聊'))).reached).toBe(false);
    expect((await send(groupMsg(`${AT}在吗`))).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(0);
    const errors = byLevel(logs, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('memory 缺席');

    host.provide(memory, fakeMemory() as never);
    expect((await send(groupMsg('再聊聊'))).reached).toBe(true);
    expect(byLevel(logs, 'warn').filter(m => m.includes('判定恢复'))).toHaveLength(1);
  });

  it('取历史抛错：记 warn，本条只回点名，不计侧车失败', async () => {
    const mem = {
      getFullHistory: async () => {
        throw new Error('库不可用');
      },
    };
    const { send, logs } = await setup({ memory: mem as never });
    for (let i = 0; i < 3; i++) expect((await send(groupMsg(`第 ${i} 条`))).reached).toBe(false);
    expect((await send(groupMsg(`${AT}在吗`))).reached).toBe(true);
    expect(byLevel(logs, 'warn').filter(m => m.includes('[laya] 判定异常') && m.includes('库不可用'))).toHaveLength(4);
    expect(byLevel(logs, 'error')).toEqual([]);
  });

  it('作用域内但模型没见过的会话（非 onebot、频道）：只回点名，不发请求', async () => {
    const { send } = await setup({ laya: { scopes: ['*'] } });
    const webui: IncomingMessage = { content: 'hi', platform: 'webui', sessionId: 'webui:default' };
    const channel = groupMsg('频道', { sessionType: 'channel', sessionId: 'onebot:10000:channel:40001:50001' });
    expect((await send(webui)).reached).toBe(false);
    expect((await send(channel)).reached).toBe(false);
    expect((await send({ ...channel, content: `${AT}频道` })).reached).toBe(true);
    expect(sidecar.requests).toHaveLength(0);
  });

  it('模型没见过的会话：每类（平台与会话类型）首次遇到记一条 warn，默认 info 级日志看得到', async () => {
    const { send, logs } = await setup();
    const other = (gid: string): IncomingMessage => ({
      content: 'hi',
      platform: 'discordx',
      sessionType: 'group',
      sessionId: `discordx:group:${gid}`,
    });
    await send(other('1'));
    await send(other('2'));
    await send(groupMsg('照常'));
    const warns = byLevel(logs, 'warn').filter(m => m.includes('一律按兜底只回点名'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('discordx:group');
    expect(sidecar.requests).toHaveLength(1);
  });
});

describe('plugin-trigger-laya：诊断项', () => {
  it('侧车在线且生效：ok', async () => {
    const { diagnose } = await setup();
    const result = await diagnose();
    expect(result).toMatchObject({ id: 'trigger.laya', category: 'service', level: 'ok' });
    expect(result.message).toBe('Laya 触发判定生效中：侧车在线（版本 v-test）');
  });

  it('生效时侧车不可达：error，并说明判定按兜底只回点名', async () => {
    sidecar.health = { status: 500, body: { error: 'internal' } };
    const { diagnose } = await setup();
    const result = await diagnose();
    expect(result.level).toBe('error');
    expect(result.message).toContain('侧车不可达（HTTP 500 internal）');
    expect(result.message).toContain('只回点名');
  });

  it('熔断后：报判定不可用；memory 缺席同样报出', async () => {
    sidecar.reply = () => ({ status: 500, body: { error: 'internal' } });
    const fused = await setup();
    for (let i = 0; i < 3; i++) await fused.send(groupMsg(`失败 ${i}`));
    const r1 = await fused.diagnose();
    expect(r1.level).toBe('error');
    expect(r1.message).toContain('判定不可用（侧车连续 3 次失败');

    const noMemory = await setup({ memory: null });
    const r2 = await noMemory.diagnose();
    expect(r2.level).toBe('error');
    expect(r2.message).toContain('memory 缺席');
  });

  it('熔断到期、还没有请求确认恢复：报探活结果与「上次判定不可用」，降为 warn；切走后侧车修好也不再报当前不可用', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sidecar.reply = () => ({ status: 500, body: { error: 'internal' } });
    const { host, send, diagnose } = await setup();
    for (let i = 0; i < 3; i++) await send(groupMsg(`失败 ${i}`));
    sidecar.reply = () => score(1);

    vi.setSystemTime(Date.now() + 30_001);
    const expired = await diagnose();
    expect(expired.level).toBe('warn');
    expect(expired.message).toBe(
      'Laya 触发判定生效中：侧车在线（版本 v-test）；上次判定不可用（侧车连续 3 次失败，最近一次: HTTP 500 internal；' +
        '熔断 30s 后重试），尚未经请求确认恢复',
    );

    // 按「切换与回滚」切到规则判定、修好侧车：本插件不再判定，锁存的故障不能写成当前不可用
    host.provide(trigger, { label: '规则（计数/评分）' }, { label: '规则（计数/评分）' });
    const rule = host.services.all(trigger).find(v => v.label === '规则（计数/评分）');
    host.services.prefer(trigger, rule?.contextId ?? '');
    vi.setSystemTime(Date.now() + 3_600_000);
    const inactive = await diagnose();
    expect(inactive.level).toBe('warn');
    expect(inactive.message).toMatch(
      /^Laya 触发判定未生效（生效的触发插件是「规则（计数\/评分）」）：侧车在线（版本 v-test）；上次判定不可用/,
    );

    // 切回后一次成功判定即确认恢复
    const laya = host.services.all(trigger).find(v => v.label === LAYA_LABEL);
    host.services.prefer(trigger, laya?.contextId ?? '');
    expect((await send(groupMsg('恢复'))).reached).toBe(true);
    expect((await diagnose()).level).toBe('ok');
  });

  describe('带图消息判定时只有图片指针', () => {
    const IMAGE = { kind: 'image', data: 'https://example.invalid/a.jpg' } as const;
    const POINTER = '[图片 | ref:data/images/a.png]';
    const BLIND =
      '条判定时只有图片指针、没有内容描述：media 未开启图片到达即识别（vision.recognizeOnArrival），或没有可用的识别模型';

    /** 按给定写法写图片描述位的 media 替身（undefined = 识别跑完但没有描述） */
    function describing(desc: () => string | undefined) {
      return {
        async processMessage(msg: IncomingMessage) {
          msg._attachmentDescriptions = msg.attachments?.map(a => (a.kind === 'image' ? desc() : undefined));
          return {};
        },
      };
    }

    it('近 20 条带图消息里只有指针的达到 10 条：生效时 warn 并说明两种可能原因；未生效不报；有描述的挤出窗口后恢复 ok', async () => {
      let desc: string | undefined = POINTER;
      const { host, send, diagnose } = await setup({ media: describing(() => desc) });
      const image = (content: string) => send(groupMsg(content, { attachments: [IMAGE] }));

      // 指针与空描述位都算只有指针；不带图的消息（没有附件、只带文件）不计
      for (let i = 0; i < 5; i++) await image(`指针 ${i}`);
      desc = undefined;
      for (let i = 0; i < 4; i++) await image(`空 ${i}`);
      await send(groupMsg('没有附件'));
      await send(groupMsg('只带文件', { attachments: [{ kind: 'file', data: 'aalis-file://f1', name: 'a.txt' }] }));
      expect((await diagnose()).level, '9 条还不到门限').toBe('ok');
      await image('空 4');
      const blind = await diagnose();
      expect(blind.level).toBe('warn');
      expect(blind.message).toBe(`Laya 触发判定生效中：侧车在线（版本 v-test）；近 10 条带图消息有 10 ${BLIND}`);

      // 切到规则判定：本插件不判定，不报
      host.provide(trigger, { label: '规则（计数/评分）' }, { label: '规则（计数/评分）' });
      const rule = host.services.all(trigger).find(v => v.label === '规则（计数/评分）');
      host.services.prefer(trigger, rule?.contextId ?? '');
      const inactive = await diagnose();
      expect(inactive.level).toBe('ok');
      expect(inactive.message).not.toContain('指针');
      const laya = host.services.all(trigger).find(v => v.label === LAYA_LABEL);
      host.services.prefer(trigger, laya?.contextId ?? '');

      // 有描述的、识别失败的占位都不算只有指针：再来 10 条，窗口 20 条里只有指针的仍是 10 条
      desc = '[图片: 一只猫 | ref:data/images/a.png]';
      for (let i = 0; i < 9; i++) await image(`有描述 ${i}`);
      desc = '[图片：获取或识别失败，内容未知]';
      await image('识别失败');
      expect((await diagnose()).message).toContain(`近 20 条带图消息有 10 ${BLIND}`);
      // 第 21 条把最早的一条挤出窗口
      await image('再一条');
      expect(await diagnose()).toMatchObject({ level: 'ok', message: 'Laya 触发判定生效中：侧车在线（版本 v-test）' });
    });

    it('一条消息带多张图：每张都只有指针才算一条只有指针，有一张带描述就不算', async () => {
      const described = '[图片: 一只猫 | ref:data/images/b.png]';
      let descs: Array<string | undefined> = [];
      const svc = {
        async processMessage(msg: IncomingMessage) {
          msg._attachmentDescriptions = descs;
          return {};
        },
      };
      const { send, diagnose } = await setup({ media: svc });
      const twoImages = (content: string) => send(groupMsg(content, { attachments: [IMAGE, IMAGE] }));

      for (let i = 0; i < 10; i++) {
        descs = i % 2 === 0 ? [POINTER, described] : [described, undefined];
        await twoImages(`一张有描述 ${i}`);
      }
      expect((await diagnose()).level, '有一张带描述的不计为只有指针').toBe('ok');
      descs = [POINTER, undefined];
      for (let i = 0; i < 10; i++) await twoImages(`两张都只有指针 ${i}`);
      expect((await diagnose()).message).toContain(`近 20 条带图消息有 10 ${BLIND}`);
    });

    it('不计入：附件识别超过 mediaWaitMs 还没写回、media 缺席', async () => {
      const gate = deferred();
      const { svc } = fakeMedia(() => gate.promise);
      const slow = await setup({ laya: { mediaWaitMs: 20 }, media: svc });
      for (let i = 0; i < 10; i++) await slow.send(groupMsg(`慢 ${i}`, { attachments: [IMAGE] }));
      expect((await slow.diagnose()).level).toBe('ok');
      gate.resolve();

      const noMedia = await setup();
      for (let i = 0; i < 10; i++) await noMedia.send(groupMsg(`无 media ${i}`, { attachments: [IMAGE] }));
      expect((await noMedia.diagnose()).level).toBe('ok');
    });
  });

  it('未生效时侧车不可达：warn，并点名当前生效的触发插件', async () => {
    sidecar.health = 'hang';
    const { host, diagnose } = await setup({ laya: { timeoutMs: 100 } });
    host.provide(trigger, { label: '规则（计数/评分）' }, { label: '规则（计数/评分）' });
    const rule = host.services.all(trigger).find(v => v.label === '规则（计数/评分）');
    host.services.prefer(trigger, rule?.contextId ?? '');
    const result = await diagnose();
    expect(result.level).toBe('warn');
    expect(result.message).toContain('未生效（生效的触发插件是「规则（计数/评分）」）');
    expect(result.message).toContain('侧车不可达');
    expect(result.message).not.toContain('只回点名');
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
    const msg = (messageId: string, extra: Partial<IncomingMessage> = {}) => groupMsg('x', { messageId, ...extra });

    c.record(msg('1'), 'cur-1');
    c.settle(GROUP_SID, '1', 'cur-1');
    expect(c.lines.at(-1)).toBe(summary(1, 0, 0, 0, 0));

    // 图片判定时还没有描述，归档时补上
    c.record(msg('2', { attachments: [IMAGE] }), 'cur-2');
    c.settle(GROUP_SID, '2', 'cur-2\n[图片: 一只猫]');
    // 文件描述到 agent 预处理阶段才写入
    c.record(msg('3', { attachments: [FILE] }), 'cur-3');
    c.settle(GROUP_SID, '3', 'cur-3\n[文件 a.txt]');
    // 长度相同、内容不同也算不一致（有描述的图片不算缺）
    c.record(msg('4', { attachments: [IMAGE], _attachmentDescriptions: ['[图片: 一只猫]'] }), 'cur-4');
    c.settle(GROUP_SID, '4', 'cur-X');
    // 文件与没识别完的图片同时在：计入缺附件描述
    c.record(msg('5', { attachments: [FILE, IMAGE] }), 'cur-5');
    c.settle(GROUP_SID, '5', 'cur-5\n[文件 a.txt]\n[图片: 一只猫]');
    expect(c.lines.at(-1)).toBe(summary(1, 2, 1, 1, 0));

    // 带附件但归档与判定时一致（如识别失败两边都没有描述）：计一致
    c.record(msg('6', { attachments: [IMAGE, FILE] }), 'cur-6');
    c.settle(GROUP_SID, '6', 'cur-6');
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
    c.settle(GROUP_SID, '1', 'cur-1\n[图片: 一只狗]');
    expect(c.lines).toEqual([summary(0, 1, 0, 0, 0)]);
  });

  it('没有消息 ID 的判定不记；没记过的键不计；取出即删，同一条再归档不再计', () => {
    const c = selfCheck(2);
    // 不同会话的三条无 ID 消息：若被记下会撑破上限 2、淘汰出「未归档」
    for (const gid of ['20001', '20002', '20003']) {
      c.record(groupMsg('x', { sessionId: `onebot:10000:group:${gid}` }), 'cur');
      c.settle(`onebot:10000:group:${gid}`, undefined, 'cur');
    }
    c.settle(GROUP_SID, '9', 'cur');
    expect(c.lines).toEqual([]);

    c.record(groupMsg('x', { messageId: '1' }), 'cur');
    c.settle('onebot:10000:group:20002', '1', 'cur');
    expect(c.lines, '键带会话 ID：别的会话同号消息不算').toEqual([]);
    c.settle(GROUP_SID, '1', 'cur');
    c.settle(GROUP_SID, '1', 'cur');
    expect(c.lines).toEqual([summary(1, 0, 0, 0, 0)]);
  });

  it('超过上限按记下的先后淘汰最早的一条，计入未归档；被淘汰的再归档不计', () => {
    const c = selfCheck(2);
    for (const id of ['1', '2', '3']) c.record(groupMsg('x', { messageId: id }), `cur-${id}`);
    expect(c.lines).toEqual([summary(0, 0, 0, 0, 1)]);
    c.settle(GROUP_SID, '1', 'cur-1');
    expect(c.lines).toHaveLength(1);
    c.settle(GROUP_SID, '2', 'cur-2');
    c.settle(GROUP_SID, '3', 'cur-3');
    expect(c.lines.at(-1)).toBe(summary(2, 0, 0, 0, 1));
  });

  it('每结清 reportEvery 条记一行累计计数，比对与淘汰都算', () => {
    const c = selfCheck(1, 3);
    c.record(groupMsg('x', { messageId: '1' }), 'a');
    c.record(groupMsg('x', { messageId: '2' }), 'b'); // 淘汰 1
    c.settle(GROUP_SID, '2', 'b');
    expect(c.lines).toEqual([]);
    c.record(groupMsg('x', { messageId: '3' }), 'c');
    c.settle(GROUP_SID, '3', 'x');
    expect(c.lines).toEqual([summary(1, 0, 0, 1, 1)]);
  });

  it('发请求前就记下：侧车回 422、请求失败、超时时照样比对（兜底吞掉的消息由本插件归档）', async () => {
    const { send, logs } = await setup({ realArchive: true, laya: { timeoutMs: 500 } });
    let n = 0;
    const next = () => groupMsg(`第 ${++n} 条正文`, { messageId: String(1000 + n) });

    sidecar.reply = () => 'hang';
    expect((await send(next())).reached).toBe(false);
    sidecar.reply = () => ({ status: 500, body: { error: 'internal' } });
    await send(next());
    // 其余侧车回 422（消息不适合交给模型），凑满 200 条结清
    sidecar.reply = () => ({ status: 422, body: { error: 'system_notice' } });
    for (let i = 0; i < 198; i++) await send(next());
    expect(sidecar.requests).toHaveLength(200);
    expect(logs.filter(e => e.message.startsWith('[laya] 自检')).map(e => e.message)).toEqual([
      summary(200, 0, 0, 0, 0),
    ]);
  });

  it('真实归档：只比对向侧车发了请求的判定，每结清 200 条记一行 info，只含计数', async () => {
    // messageId 为 slow 的消息识别要等闸门：判定等不到（mediaWaitMs 很短），归档前才写好
    const gate = deferred();
    const recognizer = fakeMedia(msg => (msg.messageId === 'slow' ? gate.promise : Promise.resolve()));
    const { host, send, logs } = await setup({ realArchive: true, media: recognizer.svc, laya: { mediaWaitMs: 10 } });
    const archive = host.messageArchive.require();
    const lines = () => logs.filter(e => e.message.startsWith('[laya] 自检'));
    let n = 0;
    const next = (extra: Partial<IncomingMessage> = {}) =>
      groupMsg(`第 ${++n} 条正文`, { messageId: String(1000 + n), ...extra });
    // 模型都判开口：放行的消息本该由 agent 归档，这里在判定之后手动归档
    const decideThenArchive = async (m: IncomingMessage, beforeArchive?: () => void) => {
      expect((await send(m)).reached).toBe(true);
      beforeArchive?.();
      await archive.archiveIncoming(m);
    };

    // 不发请求的判定不记：作用域外的私聊；请求体超限（窗口里有一条 1.2 MB 的行，没点名的兜底吞掉并由本插件归档）
    await decideThenArchive({ ...privateMsg('私聊'), messageId: 'p1' });
    await archive.archiveIncoming(groupMsg('字'.repeat(400_000), { sessionId: 'onebot:10000:group:20003' }));
    expect((await send(next({ sessionId: 'onebot:10000:group:20003', groupId: '20003' }))).reached).toBe(false);
    // 没有消息 ID 的不记
    await decideThenArchive(groupMsg('没有消息 ID'));
    expect(sidecar.requests).toHaveLength(1);

    // 图片识别超过 mediaWaitMs：判定时 cur 缺描述，归档前才写好
    await decideThenArchive(next({ messageId: 'slow', attachments: [IMAGE] }), () => gate.resolve());
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
    // 正文含孤代理：发给侧车的换成 U+FFFD，自检记的是原文（归档事件带的也是原文），计一致
    await decideThenArchive(groupMsg(`转发摘要${'😀'.slice(0, 1)}`, { messageId: String(1000 + ++n) }));
    for (let i = 0; i < 195; i++) await decideThenArchive(next());
    expect(lines(), '结清 199 条时还不记').toEqual([]);

    await decideThenArchive(next());
    expect(sidecar.requests).toHaveLength(201);
    // JSON.stringify 把孤代理编成 \udXXX 转义：窗口行里（memory 原样保留）与 cur 里都不应出现
    expect(sidecar.requests.filter(r => /\\ud[89a-f][0-9a-f]{2}/.test(JSON.stringify(r.body)))).toEqual([]);
    const [line, ...rest] = lines();
    expect(rest).toEqual([]);
    expect(line.level).toBe('info');
    expect(line.message).toBe(summary(197, 1, 1, 1, 0));
    for (const secret of ['onebot', '20001', '1001', '甲', '乙', '正文', '猫', '文件内容']) {
      expect(line.message).not.toContain(secret);
    }
  });
});
