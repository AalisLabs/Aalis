import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, events, type Logger, lifecycle, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { command, hanging, withCommands } from '../fixtures/clearing.js';
import { registerHubs } from '../fixtures/hubs.js';
import { StepModel, stepModelPlugin } from '../fixtures/step-llm.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 删除会话时停掉这个会话在跑的回合：会话管理把整个删除（删子会话、发 session:deleted、清数据）交给 agent 的 clearing，它先停下
// 这个会话在跑的一轮、放掉排着的，等它收尾，并从这时起按住这个会话到清完，所以清数据一定在回合停下之后。被停的一轮不落库、
// 不外发；别的会话的回合照常执行完毕。新旧两代按会话管理给的代号分：开始删除的同一步换代号，网关在收录之后记下、交给 agent 之前比，
// agent 在 handleMessage 入口记下、交给通道之前（按住期间等着的放开之后）比，只比这两处。删除开始之前已过会话管理收录、删除
// 开始之后才到这两处的是旧的一代，放掉、不归档，房间按下一条重新建档后也不在新的历史里；在触发判定或流控相位里挂过删完时刻、
// 随后被吞掉的不经这两处，照旧影子归档，进了重新建档的房间的历史。删除期间（带子会话的从删子会话起）经网关到的同一会话的消息
// 在收录里等删除做完，是新的一代：照常处理，存档不被这次删除清掉。/clear 清的期间到的照旧清完再处理，清的当中删掉它的子会话
// 也一样。
// ════════════════════════════════════════════════════════════

/** 流出第一块后停住，直到 release 或请求被中止（与真实服务商一样响应中止信号） */
function heldModel(started: () => void) {
  let release!: () => void;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  const plugin = definePlugin({
    name: 'zz-held-llm',
    provides: [llm],
    uses: { provide, lifecycle },
    apply(caps) {
      const handle: LLMModel = {
        id: 'held',
        providerId: caps.lifecycle.use.id,
        contextLength: 8192,
        maxOutputTokens: 1024,
        capabilities: ['chat', 'streaming'],
        async chat() {
          return { content: 'ok' };
        },
        async *chatStream(request) {
          yield { contentDelta: `回复 ${request.messages.length}` };
          started();
          await new Promise<void>((resolve, reject) => {
            void released.then(resolve);
            request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
          yield { done: true };
        },
      };
      caps.provide.use(llm, handle, { entryId: `${caps.lifecycle.use.id}/held` });
    },
  });
  return { plugin, release: () => release() };
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 装在 agent 之后的插件 */
type After = (app: App) => Promise<unknown>;

/** 只有会话管理与 agent 的一套：模型立即作答，记下各轮的输入与结局；给了 logger 时日志交给它 */
async function bootDirect({ logger, after }: { logger?: Logger; after?: After } = {}) {
  const model = new StepModel((_request, n) => ({ content: `回${n}` }));
  const app = new App({ name: 'T', logLevel: logger ? 'info' : 'error', logger });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(stepModelPlugin(model));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await after?.(app);
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, agentPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent: agentService, events, hooks, memory, sessionManager });
  const outcomes: string[][] = [];
  host.hooks.use.middleware('agent:turn:after', async (data, next) => {
    outcomes.push([data.inputs.map(input => input.message.content).join('+'), data.outcome]);
    await next();
  });
  const doomed = await host.sessionManager.use.createSession({ name: '要删的' });
  // 直接交给 agent：网关这一刻交出的一条，agent 在入口记下代号
  const say = (content: string) =>
    host.agent.use.handleMessage({ content, sessionId: doomed.id, platform: 'webui', userId: 'u1' });
  const historyOf = async () => (await host.memory.use.getHistory(doomed.id, Infinity)).map(m => [m.role, m.content]);
  return { app, model, host, outcomes, doomed, say, historyOf };
}

/** bootGateway 里的群：第一条原生入站由会话管理建档 */
const GROUP = 'onebot:10000:group:20001';

/** 会话管理、网关与 agent 的一套：onebot 的群经网关入站；记下各轮的输入与结局 */
async function bootGateway({ after }: { after?: After } = {}) {
  const model = new StepModel((_request, n) => ({ content: `回${n}` }));
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  for (const plugin of [stepModelPlugin(model), memoryInMemoryPlugin, sessionManagerPlugin, gatewayPlugin]) {
    await app.plugin(plugin, {});
  }
  await app.plugin(agentPlugin, {});
  await after?.(app);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, gatewayPlugin.name, agentPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const host = app.bind({ archive: messageArchive, events, hooks, gateway, memory, sessionManager });
  const outcomes: string[][] = [];
  host.hooks.use.middleware('agent:turn:after', async (data, next) => {
    outcomes.push([data.inputs.map(input => input.message.content).join('+'), data.outcome]);
    await next();
  });
  const ingress = (content: string) =>
    host.gateway.use.ingressMessage({
      content,
      sessionId: GROUP,
      platform: 'onebot',
      userId: '30001',
      sessionType: 'group',
      selfId: '10000',
      groupId: '20001',
    });
  /**
   * 在入站相位（缺省指令相位）阻塞正文为 content 的那一条：它已过会话管理收录、还没交给 agent。entered 在阻塞时落定，release
   * 之后放行
   */
  const holdInPhase = (content: string, phase: 'inbound:command' | 'inbound:dispatch' = 'inbound:command') => {
    const entered = deferred();
    const gate = deferred();
    host.hooks.use.middleware(phase, async (data, next) => {
      if (data.message.content === content) {
        entered.resolve();
        await gate.promise;
      }
      await next();
    });
    return { entered: entered.promise, release: () => gate.resolve() };
  };
  const historyOf = async () => (await host.memory.use.getHistory(GROUP, Infinity)).map(m => [m.role, m.content]);
  return { model, host, sm: host.sessionManager.use, outcomes, ingress, holdInPhase, historyOf };
}

/** 让排着的微任务与 I/O 回调执行完毕 */
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('删除会话时停掉它在跑的回合', () => {
  it('删除等这个会话的回合停下再清数据；被停的一轮不落库、不外发，别的会话的回合照常执行完毕', async () => {
    let inflight = 0;
    let wake!: () => void;
    const bothStarted = new Promise<void>(resolve => {
      wake = resolve;
    });
    const held = heldModel(() => {
      if (++inflight === 2) wake();
    });
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugin(held.plugin);
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(sessionManagerPlugin);
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugins.idle();
    for (const name of [sessionManagerPlugin.name, agentPlugin.name]) {
      expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
    }
    const host = app.bind({ agent: agentService, events, memory, sessionManager });
    const sm = host.sessionManager.use;
    const doomed = await sm.createSession({ name: '要删的' });
    const kept = await sm.createSession({ name: '留下的' });
    const sent: string[] = [];
    host.events.use.on('outbound:message', message => void sent.push(message.sessionId));

    const ask = (sessionId: string) =>
      host.agent.use.handleMessage({ content: '在吗', sessionId, platform: 'webui', userId: 'u1' });
    let doomedSettled = false;
    const doomedTurn = ask(doomed.id).finally(() => {
      doomedSettled = true;
    });
    const keptTurn = ask(kept.id);
    await bothStarted;

    await sm.deleteSession(doomed.id);
    expect(doomedSettled, '删除要等这个会话的回合收尾').toBe(true);
    held.release();
    await Promise.all([doomedTurn, keptTurn]);

    expect(sent, '被停的一轮不外发，别的会话照常').toEqual([kept.id]);
    const history = await host.memory.use.getHistory(doomed.id, Infinity);
    expect(
      history.filter(message => message.role === 'assistant'),
      '被停的一轮不落库',
    ).toEqual([]);
    expect((await host.memory.use.getHistory(kept.id, Infinity)).some(m => m.role === 'assistant')).toBe(true);
  });

  it.each([
    ['停下旧的一轮', 'agent:turn:after'],
    ['清数据', 'memory:clear'],
  ] as const)('删除期间（%s时）经网关到的同一房间的消息是新的一代：等删除做完再处理，房间按它重新建档，照常回复，存档不被这次删除清掉', async (_label, on) => {
    const { model, host, sm, outcomes, ingress, historyOf } = await bootGateway();
    // 删除的这一段里阻塞，新的一条在这时到达：停下旧的一轮之后、它落定之前，或清数据时。在收录里等着的它要到删除做完才放行，
    // 收录之后才记下代号
    const entered = deferred();
    const gate = deferred();
    const hang = async () => {
      entered.resolve();
      await gate.promise;
    };
    if (on === 'agent:turn:after')
      host.hooks.use.middleware('agent:turn:after', async (data, next) => {
        if (data.outcome === 'aborted') await hang();
        await next();
      });
    else
      host.hooks.use.middleware('memory:clear', async (_data, next) => {
        await hang();
        await next();
      });

    const held = model.hold(1);
    const a = ingress('<甲>');
    await held.entered;
    const first = sm.getSession(GROUP);
    expect(first?.originChat?.multiParty, '第一条入站把这个群建了档').toBe(true);
    const deleting = sm.deleteSession(GROUP);
    await entered.promise;
    const b = ingress('<乙>');
    await settle();
    gate.resolve();
    await Promise.all([a, b, deleting]);

    expect(outcomes).toEqual([
      ['<甲>', 'aborted'],
      ['<乙>', 'replied'],
    ]);
    const second = sm.getSession(GROUP);
    expect(second, '删除做完之后按新的一条重新建档').not.toBe(first);
    expect(second).toMatchObject({ kind: 'room', originPlatform: 'onebot', originChat: { multiParty: true } });
    expect(await historyOf()).toEqual([
      ['user', expect.stringContaining('<乙>')],
      ['assistant', '回2'],
    ]);
  });

  it('删正在跑的会话：回合结束那一行日志的停止原因写「会话删除」，不写成清消息历史', async () => {
    const lines: string[] = [];
    const capture: Logger = {
      debug() {},
      info: message => void lines.push(message),
      warn() {},
      error() {},
      child: () => capture,
    };
    const { model, host, doomed, say } = await bootDirect({ logger: capture });
    const held = model.hold(1);
    const first = say('<甲>');
    await held.entered;
    await host.sessionManager.use.deleteSession(doomed.id);
    await first;
    expect(lines.filter(line => line.startsWith('回合结束 ')).map(line => /原因=(\S+)/.exec(line)?.[1])).toEqual([
      '会话删除',
    ]);
  });

  it.each([
    ['指令相位', '删完之后、下一条到达之前', 'inbound:command', false],
    ['指令相位', '房间按下一条重新建档之后', 'inbound:command', true],
    ['派发相位（交给 agent 之前的中间件）', '删完之后、下一条到达之前', 'inbound:dispatch', false],
  ] as const)('删除开始之前已过会话管理、在%s里挂过删完时刻的一条是旧的一代（%s放行）：放掉、不回复、不归档，新房间的历史里没有它', async (_where, _when, phase, later) => {
    const { model, sm, outcomes, ingress, holdInPhase, historyOf } = await bootGateway();
    // 这一条的收录把这个群建了档，之后挂在入站相位里
    const slow = holdInPhase('<慢>', phase);
    const late = ingress('<慢>');
    await slow.entered;
    await sm.deleteSession(GROUP);
    expect(sm.getSession(GROUP), '删完时会话已不在表里').toBeUndefined();
    if (later) await ingress('<丙>');
    slow.release();
    await late;
    if (!later) await ingress('<丙>');

    expect(outcomes).toEqual([['<丙>', 'replied']]);
    expect(model.requests, '慢的那条不开轮').toHaveLength(1);
    expect(sm.getSession(GROUP), '下一条把这个群重新建了档').toBeDefined();
    expect(await historyOf()).toEqual([
      ['user', expect.stringContaining('<丙>')],
      ['assistant', '回1'],
    ]);
  });

  it('删除开始之前已过会话管理、在触发判定相位里挂过删完时刻、随后被吞掉的一条：不经代号比对，照旧影子归档，进了按下一条重新建档的房间的历史', async () => {
    const { host, sm, outcomes, ingress, historyOf } = await bootGateway();
    const entered = deferred();
    const gate = deferred();
    host.hooks.use.middleware('inbound:trigger', async (data, next) => {
      if (data.message.content !== '<慢>') {
        await next();
        return;
      }
      entered.resolve();
      await gate.promise;
      // 像触发判定与流控吞掉时那样：影子归档，不调 next
      await host.archive.use.archiveIncoming(data.message);
    });
    const late = ingress('<慢>');
    await entered.promise;
    await sm.deleteSession(GROUP);
    gate.resolve();
    await late;
    await ingress('<丙>');

    expect(outcomes).toEqual([['<丙>', 'replied']]);
    expect(await historyOf()).toEqual([
      ['user', expect.stringContaining('<慢>')],
      ['user', expect.stringContaining('<丙>')],
      ['assistant', '回1'],
    ]);
  });

  it('删带子会话的会话：删子会话之前就停下它在跑的一轮；删子会话期间到它的消息在收录里等删除做完，是新的一代，房间按它重新建档，照常回复，不被这次删除清掉', async () => {
    const hang = hanging('session:deleted');
    const { model, sm, outcomes, ingress, historyOf } = await bootGateway({ after: hang.install });
    const held = model.hold(1);
    const first = ingress('<甲>');
    await held.entered;
    await sm.createChildSession(GROUP, { name: '<子>' });
    const deleting = sm.deleteSession(GROUP);
    // 先删子会话：挂在它的 session:deleted 上
    await hang.entered;
    expect(outcomes, '删子会话之前就停下了').toEqual([['<甲>', 'aborted']]);
    const during = ingress('<删子会话期间>');
    await settle();
    expect(model.requests, '删的期间不开轮').toHaveLength(1);
    expect(sm.getSession(GROUP), '删除做完之前不按它重新建档').toBeUndefined();
    hang.release();
    await Promise.all([first, deleting, during]);

    expect(outcomes).toEqual([
      ['<甲>', 'aborted'],
      ['<删子会话期间>', 'replied'],
    ]);
    expect(sm.getSession(GROUP), '删除做完之后按这一条重新建档').toBeDefined();
    expect(await historyOf()).toEqual([
      ['user', expect.stringContaining('<删子会话期间>')],
      ['assistant', '回2'],
    ]);
  });

  it('预处理慢的一条：删除开始之前进了 agent、删完之后才交给通道，是旧的一代，放掉、不归档', async () => {
    const { model, host, outcomes, doomed, say, historyOf } = await bootDirect();
    const entered = deferred();
    const gate = deferred();
    host.hooks.use.middleware('agent:input:before', async (_data, next) => {
      entered.resolve();
      await gate.promise;
      await next();
    });
    const message = say('<慢>');
    await entered.promise;
    await host.sessionManager.use.deleteSession(doomed.id);
    gate.resolve();
    await message;

    expect(outcomes).toEqual([]);
    expect(model.requests, '慢的那条不开轮').toHaveLength(0);
    expect(await historyOf()).toEqual([]);
  });

  it('清数据的一家抛错、删除没做完：删除开始之前已过会话管理、这期间才交给 agent 的那条照样是旧的一代，放掉、不归档；之后的照常处理', async () => {
    const { model, host, sm, outcomes, ingress, holdInPhase, historyOf } = await bootGateway();
    const entered = deferred();
    const gate = deferred();
    host.hooks.use.middleware('memory:clear', async () => {
      entered.resolve();
      await gate.promise;
      throw new Error('<清理出错>');
    });
    const slow = holdInPhase('<迟到>');
    const late = ingress('<迟到>');
    await slow.entered;
    const deleting = sm.deleteSession(GROUP);
    await entered.promise;
    slow.release();
    await settle();
    gate.resolve();
    await expect(deleting).rejects.toThrow('<清理出错>');
    await late;
    await ingress('<之后>');

    expect(outcomes).toEqual([['<之后>', 'replied']]);
    expect(model.requests, '迟到的那条不开轮').toHaveLength(1);
    expect(await historyOf()).toEqual([
      ['user', expect.stringContaining('<之后>')],
      ['assistant', '回1'],
    ]);
  });

  it('/clear 清的当中删掉子会话：清的期间到父会话的消息照旧清完再处理，不算子会话删除的旧一代', async () => {
    const hang = hanging('session:deleted');
    const after = async (app: App) => {
      await withCommands(app);
      await hang.install(app);
    };
    const { app, model, host, outcomes, doomed: parent, say, historyOf } = await bootDirect({ after });
    const child = await host.sessionManager.use.createChildSession(parent.id, { name: '子' });
    await say('<甲>');
    const clear = command(app, parent.id, '/clear');
    await hang.entered;
    const message = say('<乙>');
    await settle();
    expect(model.requests, '清的期间不开轮').toHaveLength(1);
    hang.release();
    await Promise.all([clear, message]);

    expect(host.sessionManager.use.getSession(child.id), '清消息历史连带删掉了子会话').toBeUndefined();
    expect(outcomes).toEqual([
      ['<甲>', 'replied'],
      ['<乙>', 'replied'],
    ]);
    expect(await historyOf()).toEqual([
      ['user', expect.stringContaining('<乙>')],
      ['assistant', '回2'],
    ]);
  });

  it('/clear all 按住全部会话期间进了 agent 的一条，它的子会话在清的当中被连带删掉：放开之后再比代号，放掉、不开轮', async () => {
    const cleaner = hanging('memory:clear');
    const after = async (app: App) => {
      await withCommands(app);
      await cleaner.install(app);
    };
    const { app, model, host, outcomes, doomed: parent } = await bootDirect({ after });
    const child = await host.sessionManager.use.createChildSession(parent.id, { name: '子' });
    const clear = command(app, parent.id, '/clear all');
    await cleaner.entered;
    // 按住期间进 agent：入口记下的是删除之前的代号，在按住里等着
    const message = host.agent.use.handleMessage({
      content: '<子会话的一条>',
      sessionId: child.id,
      platform: 'webui',
      userId: 'u1',
    });
    await settle();
    cleaner.release();
    await Promise.all([clear, message]);

    expect(host.sessionManager.use.getSession(child.id), '清空连带删掉了子会话').toBeUndefined();
    expect(outcomes).toEqual([]);
    expect(model.requests, '删掉的子会话里不开轮').toHaveLength(0);
  });
});
