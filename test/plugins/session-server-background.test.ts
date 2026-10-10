import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentService, agent } from '../../packages/api-agent/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type SessionSummary, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { backgroundTasks, type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { memoryStorage } from '../fixtures/paper.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 会话服务的后台任务：登记表投影成协议的形状（background/list），background/watch 之后的推送（开始、结束、停止与删除
// 立即推，最后一行按 1 秒合并），取输出与停止，按会话树全部停止（background/stopAll）；摘要里由子树算出的字段
// （background、tokens）与 lastTurn、reason、ancestors，这些字段变了时连同各级父会话推；sessions/list 的 background；
// 工具卡的 taskId 实时与刷新后一致；没有后台任务登记时回 unsupported。
// 登记表是真的工具注册表，agent 是替身；最后一组接真的 agent。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Outcome = HookContextMap['agent:turn:after']['outcome'];

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** 可转后台的测试工具：命令种类的展示，退出码取自结果的 exitCode */
const BG = 'zz_bg';

/** 让排着的微任务与 I/O 回调跑完（setImmediate 不在假计时器里） */
const tick = () => new Promise(resolve => setImmediate(resolve));

interface Run {
  ctx: ToolCallContext;
  finish(result: string): void;
}

/** 登记可转后台的测试工具：每次调用挂着，直到 finish 或这次调用的中止信号 */
function registerBackgroundTool(host: { tools: { use: { register(tool: never): unknown } } }, runs: Run[]): void {
  host.tools.use.register({
    definition: {
      type: 'function',
      function: {
        name: BG,
        description: '可转后台的测试工具',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
    background: {},
    display: { kind: 'command', fields: { command: 'command' }, result: { exitCode: 'exitCode' } },
    handler: (_args: Record<string, unknown>, ctx: ToolCallContext) =>
      new Promise<string>(resolve => {
        runs.push({ ctx, finish: resolve });
        ctx.signal?.addEventListener('abort', () => resolve(JSON.stringify({ error: '已中止' })), { once: true });
      }),
  } as never);
}

/**
 * 会话服务连同会话管理、工具注册表（后台任务登记）、消息归档与内存记忆。agent 是替身：abort 记下停了哪个会话，
 * 并以 aborted 结束这个会话挂着的回合。registry 为假时不装工具注册表（没有后台任务登记）
 */
async function setup({ registry = true }: { registry?: boolean } = {}) {
  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-session-background-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugins.idle();
  const host = app.bind({ provide, events, hooks, tools, backgroundTasks, sessionManager, sessionProtocol });
  host.provide.use(storage, memoryStorage(new Map()));

  const aborted: string[] = [];
  /** 各会话挂着的回合：agent.abort 以 aborted 结束它们 */
  const hanging = new Map<string, Array<() => void>>();
  const agentDouble: AgentService = {
    handleMessage: async () => {},
    abort(sessionId) {
      aborted.push(sessionId);
      const ends = hanging.get(sessionId) ?? [];
      hanging.delete(sessionId);
      for (const end of ends) end();
      return ends.length > 0;
    },
  };
  host.provide.use(agent, agentDouble);
  if (registry) await app.plugin(toolsPlugin, {});
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, sessionServerPlugin.name, ...(registry ? [toolsPlugin.name] : [])]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  const sm = host.sessionManager.use;
  const runs: Run[] = [];
  if (registry) registerBackgroundTool(host, runs);

  let calls = 0;
  /** 在会话里起一次测试工具，带 runInBackground 立即转后台；回任务 id */
  const start = async (sessionId: string, command = 'npm run dev') => {
    calls++;
    const result = await host.tools.use.execute(
      BG,
      { command, runInBackground: true },
      {
        sessionId,
        platform: 'webui',
        userId: 'console',
        enabledGroups: [],
        inbound: {},
        turnId: `zz-turn-${calls}`,
        callId: `zz-call-${calls}`,
      },
    );
    const { taskId } = JSON.parse(result.content) as { taskId: string };
    return taskId;
  };

  let turns = 0;
  /** 在会话里开一轮，一直挂着：finish 以给的结局收尾，agent.abort 以 aborted 收尾 */
  const openTurn = (sessionId: string) => {
    const turnId = `turn-${++turns}`;
    const message: IncomingMessage = { content: '<提问>', sessionId, platform: 'webui', userId: 'console' };
    let end!: (result: { outcome: Outcome; error?: string }) => void;
    const ended = new Promise<{ outcome: Outcome; error?: string }>(resolve => {
      end = resolve;
    });
    hanging.set(sessionId, [...(hanging.get(sessionId) ?? []), () => end({ outcome: 'aborted' })]);
    const done = host.hooks.use.run('agent:input:before', { message, turnId, metadata: {} }, async () => {
      const { outcome, error } = await ended;
      await host.hooks.use.run('agent:turn:after', {
        message,
        reply: '',
        outcome,
        ...(error === undefined ? {} : { error }),
        sessionId,
        turnId,
        metadata: {},
      });
    });
    return {
      done,
      finish: async (outcome: Outcome, error?: string) => {
        end({ outcome, error });
        await done;
      },
    };
  };

  /** 一棵会话树：根 P、子会话 C、孙会话 G，另有一个无关的根 O */
  const tree = async () => {
    const P = await sm.createSession({ name: '父会话' });
    const C = await sm.createSession({ name: '子会话', parentId: P.id });
    const G = await sm.createSession({ name: '孙会话', parentId: C.id });
    const O = await sm.createSession({ name: '别的会话' });
    return { P: P.id, C: C.id, G: G.id, O: O.id };
  };

  return { app, host, sm, runs, aborted, start, openTurn, tree, server: () => host.sessionProtocol.use };
}

/** 一条连接，握过手 */
async function connect(server: Parameters<typeof client>[0]) {
  const c = client(server);
  await c.init();
  return c;
}

/** 最近一条 sessions/changed 里某个会话的摘要 */
function upserted(c: ReturnType<typeof client>, id: string): SessionSummary | undefined {
  return c
    .notifications('sessions/changed')
    .flatMap(change => change.upserts)
    .filter(s => s.id === id)
    .at(-1);
}

describe('background/list 与投影', () => {
  it('列出全部会话的任务：通用字段、按工具声明解析好的 display，不下发参数与结果；结束后带登记里的退出码', async () => {
    const w = await setup();
    const { P, O } = await w.tree();
    const c = await connect(w.server());
    const first = await w.start(P);
    const second = await w.start(O, 'make build');
    w.runs[0].ctx.output?.('启动中\nready on http://localhost:5173\n');
    await tick();

    const { tasks } = await c.call('background/list', {});
    expect(tasks).toEqual([
      {
        id: first,
        sessionId: P,
        kind: 'tool-call',
        label: BG,
        call: { tool: BG, turnId: 'zz-turn-1', callId: 'zz-call-1' },
        status: 'running',
        startedAt: expect.any(Number),
        lastLine: 'ready on http://localhost:5173',
        lastOutputAt: expect.any(Number),
        display: { kind: 'command', command: 'npm run dev' },
      },
      {
        id: second,
        sessionId: O,
        kind: 'tool-call',
        label: BG,
        call: { tool: BG, turnId: 'zz-turn-2', callId: 'zz-call-2' },
        status: 'running',
        startedAt: expect.any(Number),
        display: { kind: 'command', command: 'make build' },
      },
    ]);

    w.runs[1].finish(JSON.stringify({ exitCode: 2, stderr: 'zz-secret-output' }));
    await tick();
    const frames = await c.raw({ jsonrpc: '2.0', id: 'raw', method: 'background/list', params: {} });
    const reply = JSON.stringify(frames.find(frame => frame.id === 'raw'));
    expect(reply, '不下发模型给的参数').not.toContain('runInBackground');
    expect(reply, '不下发工具的结果').not.toContain('zz-secret-output');
    const ended = (await c.call('background/list', {})).tasks.find(task => task.id === second);
    expect(ended).toEqual(
      expect.objectContaining({
        status: 'failed',
        endedAt: expect.any(Number),
        exitCode: 2,
        display: { kind: 'command', command: 'make build' },
      }),
    );
    expect(ended, '原因不重复写退出码').not.toHaveProperty('reason');
  });
});

describe('background/watch 之后的推送', () => {
  it('开始、结束立即推；只有最后一行与最后输出时间变了的在一秒里合并，状态变了时排着的那次并进去', async () => {
    const w = await setup();
    const { P } = await w.tree();
    const c = await connect(w.server());
    await c.call('background/watch', {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pushes = () => c.notifications('background/changed');

    const id = await w.start(P);
    await tick();
    expect(pushes()).toEqual([{ upserts: [expect.objectContaining({ id, status: 'running' })], removes: [] }]);

    w.runs[0].ctx.output?.('第一行\n');
    await tick();
    vi.advanceTimersByTime(400);
    w.runs[0].ctx.output?.('第二行\n');
    await tick();
    expect(pushes(), '不到一秒不推').toHaveLength(1);
    vi.advanceTimersByTime(600);
    await tick();
    expect(pushes()).toHaveLength(2);
    expect(pushes()[1]).toEqual({
      upserts: [expect.objectContaining({ id, status: 'running', lastLine: '第二行' })],
      removes: [],
    });

    w.runs[0].ctx.output?.('第三行\n');
    await tick();
    w.runs[0].finish(JSON.stringify({ exitCode: 0 }));
    await tick();
    expect(pushes()).toHaveLength(3);
    expect(pushes()[2].upserts).toEqual([
      expect.objectContaining({
        id,
        status: 'completed',
        lastLine: '第三行',
        exitCode: 0,
      }),
    ]);
    vi.advanceTimersByTime(1000);
    await tick();
    expect(pushes(), '已并进状态变化的那次，节拍到了不再推').toHaveLength(3);
  });

  it('会话删除时删掉的任务推 removes；没有 watch 的连接收不到', async () => {
    const w = await setup();
    const { P } = await w.tree();
    const watching = await connect(w.server());
    await watching.call('background/watch', {});
    const other = await connect(w.server());
    const id = await w.start(P);
    await tick();
    await w.sm.deleteSession(P);
    await tick();
    expect(watching.notifications('background/changed').at(-1)).toEqual({ upserts: [], removes: [id] });
    expect(other.notifications('background/changed')).toEqual([]);
  });
});

describe('取输出与停止', () => {
  it('background/output 给 after 之后的部分与总字数；background/stop 等落定，推送里是 stopped；不认识的 id 回 not-found', async () => {
    const w = await setup();
    const { P } = await w.tree();
    const c = await connect(w.server());
    await c.call('background/watch', {});
    const id = await w.start(P);
    w.runs[0].ctx.output?.('abc\n');
    w.runs[0].ctx.output?.('de');
    expect(await c.call('background/output', { taskId: id })).toEqual({ text: 'abc\nde', end: 6, truncated: false });
    expect(await c.call('background/output', { taskId: id, after: 4 })).toEqual({
      text: 'de',
      end: 6,
      truncated: false,
    });
    expect((await c.fail('background/output', { taskId: 'bg_none' })).data?.code).toBe('not-found');

    await c.call('background/stop', { taskId: id });
    expect(w.runs[0].ctx.signal?.aborted).toBe(true);
    await tick();
    expect(c.notifications('background/changed').at(-1)?.upserts).toEqual([
      expect.objectContaining({ id, status: 'stopped' }),
    ]);
    expect((await c.fail('background/stop', { taskId: 'bg_none' })).data?.code).toBe('not-found');
  });
});

describe('background/stopAll', () => {
  it('停掉各级子会话的回合与本会话、各级子会话的后台任务；不停本会话自己的回合，不碰别的会话', async () => {
    const w = await setup();
    const { P, C, G, O } = await w.tree();
    const c = await connect(w.server());
    const own = w.openTurn(P);
    const child = w.openTurn(C);
    const inP = await w.start(P);
    const inG = await w.start(G);
    const inO = await w.start(O);
    await tick();

    await c.call('background/stopAll', { sessionId: P });
    await child.done;
    expect(w.aborted).toContain(C);
    expect(w.aborted, '本会话自己的回合留给输入框的停止键').not.toContain(P);
    const status = (id: string) => w.host.backgroundTasks.use.list().find(task => task.id === id)?.status;
    expect([status(inP), status(inG), status(inO)]).toEqual(['stopped', 'stopped', 'running']);
    expect(await Promise.race([own.done.then(() => 'ended'), tick().then(() => 'running')])).toBe('running');
    await own.finish('replied');
    expect((await c.fail('background/stopAll', { sessionId: 'zz-none' })).data?.code).toBe('not-found');
  });
});

describe('摘要里的子树字段', () => {
  it('background 数本会话在跑的任务与各级子会话里有回合或任务在跑的会话；回合与任务进出连同各级父会话推', async () => {
    const w = await setup();
    const { P, C, G } = await w.tree();
    const c = await connect(w.server());
    await c.call('sessions/watch', {});

    const turn = w.openTurn(G);
    await tick();
    expect(upserted(c, G)?.running).toBe(true);
    expect(upserted(c, C)?.background).toBe(1);
    expect(upserted(c, P)?.background).toBe(1);

    await w.start(C);
    await tick();
    expect(upserted(c, C)?.background, 'C 自己的任务加 G 的回合').toBe(2);
    expect(upserted(c, P)?.background, 'C 与 G 各算一个').toBe(2);

    await turn.finish('error', '模型调用失败');
    await tick();
    expect(upserted(c, G)).toMatchObject({
      error: true,
      reason: '模型调用失败',
      lastTurn: { outcome: 'error', endedAt: expect.any(Number) },
      background: 0,
    });
    expect(upserted(c, C)?.background).toBe(1);
    expect(upserted(c, P)?.background).toBe(1);
    w.runs[0].finish('{}');
    await tick();
    expect(upserted(c, P)?.background).toBe(0);
    expect((await c.summary(P)).background).toBe(0);
  });

  it('tokens 是本会话与各级子会话的合计，子会话记账时父会话一起推；ancestors 根在前', async () => {
    const w = await setup();
    const { P, C, G } = await w.tree();
    const c = await connect(w.server());
    await c.call('sessions/watch', {});
    const usage = (sessionId: string, inputTokens: number, outputTokens: number) =>
      w.host.events.use.emit('llm:usage', { provider: 'zz', model: 'zz', sessionId, inputTokens, outputTokens });

    await usage(C, 100, 10);
    await usage(G, 5, 1);
    await tick();
    expect(upserted(c, G)?.tokens).toEqual({ input: 5, output: 1 });
    expect(upserted(c, C)?.tokens).toEqual({ input: 105, output: 11 });
    expect(upserted(c, P)?.tokens).toEqual({ input: 105, output: 11 });

    const page = await c.list({ parentId: C });
    expect(page.sessions.map(s => [s.id, s.ancestors])).toEqual([
      [
        G,
        [
          { id: P, title: '父会话' },
          { id: C, title: '子会话' },
        ],
      ],
    ]);
    const root = await c.summary(P);
    expect(root.ancestors).toBeUndefined();
    expect(root.lastTurn).toBeUndefined();
    expect(root.reason).toBeUndefined();
  });
});

describe('sessions/list 的 background', () => {
  it('只列 background 大于 0 的根会话，含已归档的', async () => {
    const w = await setup();
    const { P, C, O } = await w.tree();
    const archivedRoot = await w.sm.createSession({ name: '归档的' });
    const idle = await w.sm.createSession({ name: '闲着的' });
    const c = await connect(w.server());
    await w.start(C);
    await w.start(archivedRoot.id);
    const own = w.openTurn(O);
    await c.call('session/archive', { sessionId: archivedRoot.id });
    await tick();

    const { sessions } = await c.list({ background: true });
    expect(sessions.map(s => s.id).sort(), '本会话自己的回合不算后台').toEqual([P, archivedRoot.id].sort());
    expect((await c.list()).sessions.map(s => s.id)).toEqual(expect.arrayContaining([P, O, idle.id]));
    expect((await c.list()).sessions.map(s => s.id)).not.toContain(archivedRoot.id);
    await own.finish('replied');
  });
});

describe('没有后台任务登记', () => {
  it('list、output、stop 回 unsupported；watch 照常；stopAll 照样停子会话的回合', async () => {
    const w = await setup({ registry: false });
    const { P, C } = await w.tree();
    const c = await connect(w.server());
    expect(await c.call('background/watch', {})).toEqual({});
    for (const [method, params] of [
      ['background/list', {}],
      ['background/output', { taskId: 'bg_1' }],
      ['background/stop', { taskId: 'bg_1' }],
    ] as const) {
      expect((await c.fail(method, params)).data?.code, method).toBe('unsupported');
    }
    const child = w.openTurn(C);
    await tick();
    expect((await c.summary(P)).background).toBe(1);
    await c.call('background/stopAll', { sessionId: P });
    await child.done;
    expect(w.aborted).toEqual([C]);
  });
});

// ════════════════════════════════════════════════════════════
// 接真的 agent：工具卡的 taskId 实时与刷新后一致
// ════════════════════════════════════════════════════════════

describe('接真的 agent', () => {
  it('转到后台的那次调用，工具卡实时带 taskId，刷新后的历史里同一个，background/list 里找得到', async () => {
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    const home = mkdtempSync(join(tmpdir(), 'aalis-session-background-'));
    homes.push(home);
    provideHostPaths(app, home);
    await registerHubs(app);
    const responses: ChatResponse[] = [
      {
        content: null,
        toolCalls: [
          {
            id: 'model-id',
            type: 'function',
            function: { name: BG, arguments: JSON.stringify({ command: 'npm run dev', runInBackground: true }) },
          },
        ],
      },
      { content: '已经放到后台了' },
    ];
    await app.plugin(createMockLLMPlugin({ responses }));
    await app.plugin(toolsPlugin, {});
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugins.idle();
    const host = app.bind({ provide, tools, backgroundTasks, agent, sessionManager, sessionProtocol });
    host.provide.use(storage, memoryStorage(new Map()));
    const runs: Run[] = [];
    registerBackgroundTool(host, runs);
    await app.plugin(sessionManagerPlugin, {});
    await app.plugin(sessionServerPlugin, {});
    await app.plugins.idle();
    const sm = host.sessionManager.use;
    const s = await sm.createSession({ name: 'S' });
    await sm.updateSessionTitle(s.id, 'S');
    const c = await connect(host.sessionProtocol.use);
    const sub = await c.subscribe(s.id);

    await host.agent.use.handleMessage({
      content: '起开发服务器',
      sessionId: s.id,
      platform: 'webui',
      userId: 'console',
    });
    const live = c.timeline(s.id, sub).find(item => item.kind === 'tool-call');
    const [task] = (await c.call('background/list', {})).tasks;
    expect(live).toMatchObject({ name: BG, status: 'completed', taskId: task.id });
    expect(task).toMatchObject({ sessionId: s.id, status: 'running', call: { callId: live?.itemId } });

    const refreshed = (await c.subscribe(s.id)).snapshot.items.find(item => item.kind === 'tool-call');
    expect(refreshed).toMatchObject({ itemId: live?.itemId, taskId: task.id });
    runs[0].finish('{}');
  });
});
