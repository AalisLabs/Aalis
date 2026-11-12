import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvals } from '../../packages/api-approval/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { todoList } from '../../packages/api-todo-list/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { StepModel, stepModelPlugin } from '../fixtures/step-llm.js';
import { deferred } from '../helpers/deferred.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// 终端聊天区按会话协议的条目画她的输出：一轮里的每段回复另起一块，工具调用一行（做了什么、状态或用时），连续 3 个起的工具调用
// 收成一行，与 WebUI 同一句；有失败、等审批、还在跑的不收，还在跑的这一轮最后一段末尾那一组也不收；夹着的思考随这一组收起，
// 思考不画。Ctrl+O 全部展开或收起（审批卡在时也能按），帮助页列出。本地行（输入回显等）按到达先后插在行与行之间，落在收起的一组
// 内部时排到这一组之后。等你批准的写成黄色，失败的写成红色。
// 启动真的会话服务、会话管理、存档、网关、agent 与终端界面（假 TTY，收集 stdout 帧），模型是能阻塞某一次调用的替身，在终端里打字发出
// ════════════════════════════════════════════════════════════

// 颜色由终端能力定、在载入时取定，测试进程不是终端：载入之前钉成基本 16 色，帧里留着颜色码（只影响这个文件的进程）
vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});
/** 基本 16 色里染成 code 这种前景色的文字 */
const painted = (code: number, text: string) => `\x1b[${code}m${text}\x1b[39m`;

const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
/** 等两拍：渲染排在 setImmediate 上 */
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const PROBE = 'zz_probe';
/** 声明了命令展示的工具 */
const RUN = 'zz_run';
/** 执行前要 owner 批准的工具：没批准时结果带 error */
const ASK = 'zz_ask';

type Call = NonNullable<ChatResponse['toolCalls']>[number];
type Gate = ReturnType<typeof deferred<void>>;
const call = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const calls = (...list: Call[]): ChatResponse => ({ content: null, toolCalls: list });
const run = (id: string, command: string) => call(id, RUN, { command });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/**
 * decide 按这是 agent 第几次调用模型作答（带工具表的请求；不带的是会话管理给新会话起标题，回一个标题）；探针带 fail 时结果
 * 带 error，带 wait 时阻塞到放行。fresh 为假时终端的会话事先建好、起好标题：终端启动时就订上它，模型只收到 agent 的调用，
 * hold(n) 的 n 就是 agent 的第几次调用；为真时第一条消息发出之前才建档，终端在发出之前订上。待办服务是替身：holdSnapshot
 * 之后会话服务取订阅快照时挂在取待办上，直到放行
 */
async function setup(decide: (n: number) => ChatResponse, { rows = 40, columns = 100, fresh = false } = {}) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    writes.push(String(chunk));
    return true;
  });
  cleanups.push(fakeTty(rows, columns).restore);
  const home = mkdtempSync(join(tmpdir(), 'aalis-cli-turn-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const model: StepModel = new StepModel(
    (request): ChatResponse =>
      request.tools ? decide(model.requests.filter(each => each.tools).length) : { content: '<标题>' },
  );
  await app.plugin(stepModelPlugin(model));
  await app.plugin(memoryInMemoryPlugin);
  provideHostPaths(app, home);
  const host = app.bind({ provide, events, tools, sessionManager, approvals });
  host.provide.use(storage, memoryStorage(new Map()));
  let snapshotGate: { entered: Gate; release: Gate } | undefined;
  host.provide.use(todoList, {
    get: async () => {
      const gate = snapshotGate;
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return [];
    },
    clear: async () => {},
  });
  await app.plugin(toolsPlugin, {});
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  const probeGate = deferred<void>();
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async args => {
      if (args.wait) await probeGate.promise;
      return args.fail ? JSON.stringify({ error: '<坏了>' }) : 'ok';
    },
  });
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: RUN, description: '执行', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
    display: { kind: 'command', fields: { command: 'command' } },
  });
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: ASK, description: '要批准', parameters: { type: 'object', properties: {} } },
    },
    handler: async (_args, ctx) => {
      const outcome = await host.approvals.use.request({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        callId: ctx.callId,
        origin: { kind: 'hand', participants: [{ platform: 'cli', userId: 'console' }] },
        tool: ASK,
        args: {},
        rule: '<要批准>',
        canAnswer: () => true,
        ownerOnly: true,
      });
      return outcome.approved ? 'ok' : JSON.stringify({ error: outcome.message });
    },
  });
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugin(cliPlugin, { startupView: 'chat' });
  await app.plugins.idle();
  for (const definition of [agentPlugin, gatewayPlugin, sessionServerPlugin, cliPlugin]) {
    const state = app.plugins.getPlugin(definition.name)?.state;
    if (state !== 'active') throw new Error(`${definition.name} 未激活（state=${state}）`);
  }
  if (!fresh) {
    await host.sessionManager.use.ensureSession('cli-default', {}, { createdFrom: 'cli' });
    await host.sessionManager.use.updateSessionTitle('cli-default', '<标题>');
  }
  await app.start();
  await settle();
  const waiting: number[] = [];
  host.events.use.on('agent:queue', state => void waiting.push(state.waiting.length));
  /** 她这一轮交出的回复（outbound:message） */
  const replies: string[] = [];
  host.events.use.on('outbound:message', msg => {
    if (msg.source === 'agent') replies.push(msg.content);
  });

  /** 最后一帧原样（带颜色码），按行 */
  const rawLines = () => {
    const all = writes.join('');
    return all.slice(all.lastIndexOf(FRAME_SPLIT)).split('\n');
  };
  /** 最后一帧去掉控制序列，按行 */
  const lines = () => rawLines().map(line => line.replace(ANSI_RE, '').trimEnd());
  const frame = () => lines().join('\n');
  /** 打一行字再回车 */
  const say = async (text: string) => {
    for (const ch of text) process.stdin.emit('keypress', ch, { name: ch, sequence: ch });
    process.stdin.emit('keypress', '\r', { name: 'return' });
    await settle();
  };
  const ctrl = async (name: string) => {
    process.stdin.emit('keypress', '', { name, ctrl: true });
    await settle();
  };
  /** 等帧里出现 text */
  const shown = (text: string) => vi.waitFor(() => expect(frame()).toContain(text));
  /** 会话的历史被改写（如连对话一起回滚）：会话服务推 session/resync，终端重新订阅 */
  const resync = () => host.events.use.emit('history:changed', { sessionId: 'cli-default' });
  /** 发一条不是她回复的出站（如宿主提示），写成一段本地行 */
  const notify = (content: string) =>
    host.events.use.emit('outbound:message', { sessionId: 'cli-default', platform: 'cli', content, source: 'system' });
  /** 之后的订阅快照阻塞在取待办上：entered 在阻塞时落定，release 之后才回 */
  const holdSnapshot = () => {
    const gate = { entered: deferred<void>(), release: deferred<void>() };
    snapshotGate = gate;
    return {
      entered: gate.entered.promise,
      release: () => {
        snapshotGate = undefined;
        gate.release.resolve();
      },
    };
  };
  return {
    model,
    rawLines,
    lines,
    frame,
    say,
    ctrl,
    shown,
    resync,
    notify,
    holdSnapshot,
    replies,
    releaseProbe: () => probeGate.resolve(),
    untilJoined: () => vi.waitFor(() => expect(waiting.at(-1)).toBe(1)),
  };
}

/** 含 text 的行 */
const linesWith = (lines: string[], text: string | RegExp) =>
  lines.filter(line => (typeof text === 'string' ? line.includes(text) : text.test(line)));
/** 原样的行里去掉控制序列之后含 text 的那一行 */
const rawLineWith = (raw: string[], text: string) => raw.find(line => line.replace(ANSI_RE, '').includes(text)) ?? '';

describe('一轮的几段回复与工具调用', () => {
  it('工具调用前后的两段各自另起一块，带人设名的标签；中间一行写调用了什么与用时', async () => {
    const s = await setup(
      n =>
        n === 1
          ? { content: '我先看一下目录，请稍等……', toolCalls: [call('c1', PROBE)] }
          : { content: '这一轮我收到了 2 条输入' },
      { fresh: true },
    );
    await s.say('<看看目录>');
    await s.shown('这一轮我收到了 2 条输入');
    await settle();
    const lines = s.lines();
    const first = lines.findIndex(line => line.includes('我先看一下目录，请稍等……'));
    const second = lines.findIndex(line => line.includes('这一轮我收到了 2 条输入'));
    expect(first, s.frame()).toBeGreaterThanOrEqual(0);
    expect(lines[first]).not.toContain('这一轮我收到了 2 条输入');
    expect(lines[first]).toContain('✦ Aalis');
    expect(lines[second]).toContain('✦ Aalis');
    const between = lines.slice(first + 1, second);
    expect(between).toHaveLength(1);
    expect(between[0]).toMatch(/调用 zz_probe · \d+\.\d 秒/);
  });

  it('连续 3 个工具调用收成一行，按展示种类计数；Ctrl+O 全部展开，再按一次收起；2 个不收', async () => {
    const s = await setup(
      n =>
        [
          calls(run('c1', 'ls'), run('c2', 'pwd'), call('c3', PROBE)),
          { content: '<三个做完了>' },
          calls(run('c4', 'date'), call('c5', PROBE)),
          { content: '<两个做完了>' },
        ][n - 1],
    );
    await s.say('<三个>');
    await s.shown('<三个做完了>');
    await s.say('<两个>');
    await s.shown('<两个做完了>');
    await settle();
    expect(linesWith(s.lines(), '调用了 3 个工具：执行命令 2、其他 1'), s.frame()).toHaveLength(1);
    expect(linesWith(s.lines(), '执行 ls')).toEqual([]);
    expect(linesWith(s.lines(), '执行 date')).toHaveLength(1);
    expect(linesWith(s.lines(), /调用 zz_probe/)).toHaveLength(1);
    expect(linesWith(s.lines(), '调用了 2 个工具')).toEqual([]);

    await s.ctrl('o');
    expect(linesWith(s.lines(), '调用了 3 个工具')).toEqual([]);
    expect(linesWith(s.lines(), /执行 ls · \d+\.\d 秒/)).toHaveLength(1);
    expect(linesWith(s.lines(), /执行 pwd · \d+\.\d 秒/)).toHaveLength(1);
    expect(linesWith(s.lines(), /调用 zz_probe/)).toHaveLength(2);

    await s.ctrl('o');
    expect(linesWith(s.lines(), '调用了 3 个工具：执行命令 2、其他 1')).toHaveLength(1);
    expect(linesWith(s.lines(), '执行 ls')).toEqual([]);
  });

  it('其中有失败的不收：三行都在，失败的那一行写失败', async () => {
    const s = await setup(n =>
      n === 1 ? calls(run('c1', 'ls'), run('c2', 'pwd'), call('c3', PROBE, { fail: true })) : { content: '<做完了>' },
    );
    await s.say('<跑三个>');
    await s.shown('<做完了>');
    await settle();
    expect(linesWith(s.lines(), '调用了 3 个工具')).toEqual([]);
    expect(linesWith(s.lines(), '执行 ls')).toHaveLength(1);
    expect(linesWith(s.lines(), '执行 pwd')).toHaveLength(1);
    expect(linesWith(s.lines(), '调用 zz_probe · 失败')).toHaveLength(1);
    expect(rawLineWith(s.rawLines(), '调用 zz_probe · 失败')).toContain(painted(31, '失败'));
  });

  it('有一个调用等你批准：那一行写等你批准、黄色；审批卡在时 Ctrl+O 照样全部展开与收起；拒绝之后写没批准', async () => {
    const s = await setup(
      n =>
        [
          calls(run('c1', 'ls'), run('c2', 'pwd'), call('c3', PROBE)),
          { content: '<三个做完了>' },
          calls(call('q1', ASK)),
          { content: '<问完了>' },
        ][n - 1],
    );
    await s.say('<三个>');
    await s.shown('<三个做完了>');
    await s.say('<问一个>');
    await s.shown('调用 zz_ask · 等你批准');
    await s.shown('需要批准');
    expect(rawLineWith(s.rawLines(), '调用 zz_ask')).toContain(painted(33, '等你批准'));
    expect(linesWith(s.lines(), '调用了 3 个工具：执行命令 2、其他 1')).toHaveLength(1);

    await s.ctrl('o');
    expect(linesWith(s.lines(), '调用了 3 个工具'), s.frame()).toEqual([]);
    expect(linesWith(s.lines(), '执行 ls')).toHaveLength(1);
    await s.ctrl('o');
    expect(linesWith(s.lines(), '调用了 3 个工具：执行命令 2、其他 1')).toHaveLength(1);

    await s.ctrl('n');
    await s.shown('<问完了>');
    await settle();
    expect(linesWith(s.lines(), '调用 zz_ask · 没批准'), s.frame()).toHaveLength(1);
  });

  it('这一轮还在跑、这一组在最后一段末尾：三行都在；回复之后收成一行', async () => {
    const s = await setup(n =>
      n === 1 ? calls(run('c1', 'ls'), run('c2', 'pwd'), call('c3', PROBE)) : { content: '<做完了>' },
    );
    const held = s.model.hold(2);
    await s.say('<跑三个>');
    await held.entered;
    await settle();
    expect(linesWith(s.lines(), '执行 ls'), s.frame()).toHaveLength(1);
    expect(linesWith(s.lines(), '执行 pwd')).toHaveLength(1);
    expect(linesWith(s.lines(), /调用 zz_probe/)).toHaveLength(1);
    expect(linesWith(s.lines(), '调用了 3 个工具')).toEqual([]);

    held.release();
    await s.shown('<做完了>');
    await settle();
    expect(linesWith(s.lines(), '调用了 3 个工具：执行命令 2、其他 1')).toHaveLength(1);
    expect(linesWith(s.lines(), '执行 ls')).toEqual([]);
  });

  it('两次调用之间夹着思考：三个调用连同思考收成一行；思考的文字展开也不画', async () => {
    const s = await setup(
      n =>
        [
          calls(run('c1', 'ls'), run('c2', 'pwd')),
          { content: null, reasoningContent: '<想一想>', toolCalls: [call('c3', PROBE)] },
          { content: '<做完了>' },
        ][n - 1],
    );
    await s.say('<跑三个>');
    await s.shown('<做完了>');
    await settle();
    expect(linesWith(s.lines(), '调用了 3 个工具：执行命令 2、其他 1'), s.frame()).toHaveLength(1);
    expect(s.frame()).not.toContain('<想一想>');
    await s.ctrl('o');
    expect(linesWith(s.lines(), '执行 ls')).toHaveLength(1);
    expect(s.frame()).not.toContain('<想一想>');
  });

  it('一轮在跑时打字插进这一轮：三个调用仍收成一行，回显排在这一组之后，不把它切开', async () => {
    const s = await setup(
      n => [calls(run('c1', 'ls')), calls(run('c2', 'pwd'), call('c3', PROBE)), { content: '<做完了>' }][n - 1],
    );
    const held = s.model.hold(2);
    await s.say('<跑三个>');
    await held.entered;
    await s.say('<插一句>');
    await s.untilJoined();
    held.release();
    await s.shown('<做完了>');
    await settle();
    const lines = s.lines();
    const group = lines.findIndex(line => line.includes('调用了 3 个工具：执行命令 2、其他 1'));
    const echo = lines.findIndex(line => line.includes('<插一句>'));
    const reply = lines.findIndex(line => line.includes('<做完了>'));
    expect(group, s.frame()).toBeGreaterThanOrEqual(0);
    expect(echo).toBeGreaterThan(group);
    expect(reply).toBeGreaterThan(echo);
    expect(linesWith(lines, '执行 ls')).toEqual([]);
  });

  it('聊天区超过 300 项时最早的被裁掉，在跑的这一轮的条目照常更新', async () => {
    // 会话等第一条消息才建档：这之前的系统消息只写成本地行，不另有会话服务推来的通知条目
    const s = await setup(n => (n === 1 ? calls(call('c1', PROBE, { wait: true })) : { content: '<收尾>' }), {
      rows: 400,
      fresh: true,
    });
    for (let i = 0; i < 305; i++) await s.notify(`<第 ${i} 条>`);
    await settle();
    expect(s.frame()).not.toContain('欢迎使用');
    expect(s.frame()).not.toContain('<第 4 条>');
    expect(s.frame()).toContain('<第 5 条>');
    expect(s.frame()).toContain('<第 304 条>');

    await s.say('<开一轮>');
    await s.shown('调用 zz_probe · 运行中');
    s.releaseProbe();
    await s.shown('<收尾>');
    await settle();
    expect(linesWith(s.lines(), /调用 zz_probe/)).toHaveLength(1);
    expect(linesWith(s.lines(), /调用 zz_probe · \d+\.\d 秒/)).toHaveLength(1);
    expect(s.frame()).not.toContain('<第 5 条>');
    expect(s.frame()).toContain('<第 304 条>');
  });

  it('她的正文流式写出：生成到一半时帧里已有前半段，放行之后整段只有一份', async () => {
    const s = await setup(() => ({ content: '' }));
    const gate = deferred<void>();
    vi.spyOn(s.model, 'chatStream').mockImplementationOnce(async function* () {
      yield { contentDelta: '<前' };
      yield { contentDelta: '半段>' };
      await gate.promise;
      yield { contentDelta: '<后半段>' };
      yield { done: true };
    });
    await s.say('<说吧>');
    await s.shown('<前半段>');
    expect(s.frame()).not.toContain('<后半段>');
    gate.resolve();
    await s.shown('<前半段><后半段>');
    await settle();
    expect(linesWith(s.lines(), '<前半段>'), s.frame()).toHaveLength(1);
  });

  it('一轮自己的条目超过 300 项：最早的被裁掉，还在跑时末尾那一组照样不收；回合收尾之后收成一行', async () => {
    const ROUNDS = 101;
    const s = await setup(n =>
      n <= ROUNDS ? calls(call(`a${n}`, PROBE), call(`b${n}`, PROBE), call(`c${n}`, PROBE)) : { content: '<完>' },
    );
    const held = s.model.hold(ROUNDS + 1);
    await s.say('<开一轮>');
    await held.entered;
    await settle();
    expect(s.frame()).not.toContain('调用了');
    expect(linesWith(s.lines(), /调用 zz_probe · \d+\.\d 秒/).length).toBeGreaterThan(3);
    held.release();
    await s.shown('<完>');
    await settle();
    expect(linesWith(s.lines(), /调用了 \d+ 个工具/), s.frame()).toHaveLength(1);
  });

  it('重新订阅、快照还没回时这一轮收尾：快照之后补发的推送照样接上，工具行写出用时，她的回复只有一份', async () => {
    const s = await setup(n => (n === 1 ? calls(call('c1', PROBE, { wait: true })) : { content: '<收尾>' }));
    await s.say('<开一轮>');
    await s.shown('调用 zz_probe · 运行中');
    const snapshot = s.holdSnapshot();
    await s.resync();
    await snapshot.entered;
    s.releaseProbe();
    await vi.waitFor(() => expect(s.replies).toEqual(['<收尾>']));
    await settle();
    snapshot.release();
    await s.shown('<收尾>');
    await settle();
    expect(s.frame()).toMatch(/调用 zz_probe · \d+\.\d 秒/);
    expect(s.frame()).not.toContain('运行中');
    expect(linesWith(s.lines(), '<收尾>'), s.frame()).toHaveLength(1);
  });

  it('重新订阅时快照里已收尾的历史不画：之前那一轮的回复与工具行各只有一份', async () => {
    const s = await setup(n => [calls(call('c1', PROBE)), { content: '<第一轮>' }, { content: '<第二轮>' }][n - 1]);
    await s.say('<跑一个>');
    await s.shown('<第一轮>');
    await s.resync();
    // 发出之前等重新订阅落定：之后到的第二轮说明快照已经到了
    await s.say('<再来>');
    await s.shown('<第二轮>');
    await settle();
    expect(linesWith(s.lines(), '<第一轮>'), s.frame()).toHaveLength(1);
    expect(linesWith(s.lines(), /调用 zz_probe/)).toHaveLength(1);
  });

  it('未读计数：不在聊天页时她每段有字的回复计一次，工具调用、增量与更新不计', async () => {
    const s = await setup(n =>
      n === 1 ? { content: '<一段>', toolCalls: [call('c1', PROBE)] } : { content: '<二段>' },
    );
    const held = s.model.hold(1);
    await s.say('<开一轮>');
    await held.entered;
    await s.ctrl('l');
    held.release();
    await vi.waitFor(() => expect(s.frame()).toContain('CHAT(2)'));
    await settle();
    expect(s.frame()).toContain('CHAT(2)');
  });

  it('帮助页列出 Ctrl+O', async () => {
    const s = await setup(() => ({ content: '' }));
    await s.ctrl('g');
    expect(s.frame()).toMatch(/Ctrl\+O\s+连续的工具调用：全部展开 \/ 全部收起/);
  });
});
