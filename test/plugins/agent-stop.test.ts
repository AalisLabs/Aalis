import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnInput } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import {
  type IncomingMessage,
  type OutgoingMessage,
  selfInitiatedActor,
} from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { callTool, StepModel, stepModelPlugin } from '../fixtures/step-llm.js';

// ════════════════════════════════════════════════════════════
// /stop（plugin-agent 登记）：停下本会话在跑的一轮，做法同停止键，排着的照常开下一轮。这一轮的参与者（进了这一轮的各条输入
// 按 originTurnOf 算：真人的话是发言者，续做是起它的那一轮的参与者，定时任务是建它的人）与 owner 能停，不看等级；排队中、
// 待插入的不算，没有账号的不算任何人。同一份实现，终端、QQ 私聊与群里一样。
// 经真实的网关、指令与权限插件（owner 是配置里的 QQ 号与本机的 console），模型是能挂住某一次调用的替身。
// ════════════════════════════════════════════════════════════

const STOPPED = '已停下这一轮';
const IDLE = '没有在跑的一轮';
const DENIED = '只有这一轮里说过话的人和 owner 能停';
const PROBE = 'zz_stop_probe';

const OWNER_QQ = { platform: 'onebot', userId: '99999' };
const A = { platform: 'onebot', userId: '30001' };
const B = { platform: 'onebot', userId: '30002' };
const C = { platform: 'onebot', userId: '30003' };
const GROUP = { sessionId: 'onebot:10000:group:20001', sessionType: 'group', groupId: '20001' };
const CLI = { sessionId: 'cli-default', platform: 'cli', userId: 'console' };
const DM = { sessionId: `onebot:10000:private:${A.userId}`, sessionType: 'private', ...A };

type Where = Pick<IncomingMessage, 'sessionId' | 'platform' | 'userId' | 'sessionType' | 'groupId'>;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const label = (inputs: readonly TurnInput[]) => inputs.map(i => i.message.content).join('+');

/** decide 按这是第几次调用模型作答 */
async function boot(decide: (n: number) => ChatResponse = n => ({ content: `回${n}` })) {
  const { app } = hostedApp({ owners: [OWNER_QQ] });
  apps.push(app);
  await registerHubs(app);
  const model = new StepModel((_request, n) => decide(n));
  await app.plugin(stepModelPlugin(model));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin);
  await app.plugin(commandsPlugin);
  await app.plugin(authorityPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  for (const p of [gatewayPlugin, commandsPlugin, authorityPlugin, agentPlugin]) {
    expect(app.plugins.getPlugin(p.name)?.state, `${p.name} 未激活`).toBe('active');
  }
  const host = app.bind({ events, hooks, tools, gateway });
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
  });
  const turns: Array<{ turnId: string; inputs: readonly TurnInput[]; outcome?: string }> = [];
  host.hooks.use.middleware('agent:turn:before', async (data, next) => {
    turns.push({ turnId: data.turnId, inputs: data.inputs });
    await next();
  });
  host.hooks.use.middleware('agent:turn:after', async (data, next) => {
    const turn = turns.find(t => t.turnId === data.turnId);
    if (turn) turn.outcome = data.outcome;
    await next();
  });
  const outbound: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => void outbound.push(message));
  const waiting = new Map<string, number>();
  host.events.use.on('agent:queue', state => void waiting.set(state.sessionId, state.waiting.length));
  /** 经网关入站一条：等它落定（指令执行完并回了话，或它所在的一轮结束） */
  const say = (where: Where, content: string, extra: Partial<IncomingMessage> = {}) =>
    host.gateway.use.ingressMessage({ content, ...where, ...extra } as IncomingMessage);
  return {
    model,
    say,
    outcomes: () => turns.map(t => [label(t.inputs), t.outcome]),
    /** 指令回到这个会话的话 */
    replies: (sessionId: string) =>
      outbound.filter(m => m.sessionId === sessionId && m.source === 'command').map(m => m.content),
    untilWaiting: (sessionId: string, count: number) => vi.waitFor(() => expect(waiting.get(sessionId)).toBe(count)),
  };
}

describe.each([
  ['终端会话', CLI],
  ['QQ 私聊', DM],
] as const)('/stop：%s', (_kind, where) => {
  it('停下在跑的一轮，待插入的照常开下一轮；/stop 本身不进这一轮；没有在跑的回那一句', async () => {
    const s = await boot();
    const held = s.model.hold(1);
    const a = s.say(where, '<甲>');
    await held.entered;
    const b = s.say(where, '<乙>');
    await s.untilWaiting(where.sessionId, 1);
    await s.say(where, '/stop');
    expect(s.replies(where.sessionId)).toEqual([STOPPED]);
    await Promise.all([a, b]);
    expect(s.outcomes()).toEqual([
      ['<甲>', 'aborted'],
      ['<乙>', 'replied'],
    ]);

    await s.say(where, '/stop');
    expect(s.replies(where.sessionId)).toEqual([STOPPED, IDLE]);
  });
});

describe('/stop 的判据：群里', () => {
  /**
   * A 的插话开一轮，第一次调用模型时 B 的话到了、还在待插入；这次调用回探针，B 的话插进第二次调用。两次调用都挂住，返回时停在
   * 第一次（waiting）或第二次（joined）上
   */
  async function groupTurn(phase: 'waiting' | 'joined') {
    const s = await boot(n => (n === 1 ? callTool(PROBE) : { content: `回${n}` }));
    const first = s.model.hold(1);
    const second = s.model.hold(2);
    const a = s.say({ ...GROUP, ...A }, '<甲>', { triggerType: 'interval' });
    await first.entered;
    const b = s.say({ ...GROUP, ...B }, '<乙>', { triggerType: 'interval' });
    await s.untilWaiting(GROUP.sessionId, 1);
    if (phase === 'joined') {
      first.release();
      await second.entered;
    }
    return {
      s,
      done: async () => {
        first.release();
        second.release();
        await Promise.all([a, b]);
      },
    };
  }

  it('不在这一轮里的群友被拒，话还在待插入、没进这一轮的同样被拒；这一轮照常跑完', async () => {
    const { s, done } = await groupTurn('waiting');
    await s.say({ ...GROUP, ...C }, '/stop');
    await s.say({ ...GROUP, ...B }, '/stop');
    expect(s.replies(GROUP.sessionId)).toEqual([DENIED, DENIED]);
    await done();
    expect(s.outcomes()).toEqual([['<甲>+<乙>', 'replied']]);
  });

  it.each([
    ['插话开这一轮的群友', { ...GROUP, ...A }],
    ['插进这一轮的群友', { ...GROUP, ...B }],
    ['不在这一轮里的 owner', { ...GROUP, ...OWNER_QQ }],
    ['从 WebUI 往群里说话的 owner', { ...GROUP, platform: 'webui', userId: 'console' }],
  ] as const)('%s能停', async (_who, where) => {
    const { s, done } = await groupTurn('joined');
    await s.say(where, '/stop');
    expect(s.replies(GROUP.sessionId)).toEqual([STOPPED]);
    await done();
    expect(s.outcomes()).toEqual([['<甲>+<乙>', 'aborted']]);
  });
});

describe('/stop 的判据：注入开的一轮', () => {
  it.each([
    [
      '他起的后台任务的结束通知开的一轮（续做）',
      {
        source: 'bg:bg_x_1',
        hostNotice: { kind: 'background', id: 'bg_x_1' },
        fromTurn: { platform: A.platform, userId: A.userId, participants: [A] },
      },
    ],
    ['他建的定时任务开的一轮', { source: 'scheduler', actor: A }],
  ] as const)('%s：这一轮按他算，他在 QQ 私聊里能停', async (_kind, injected) => {
    const s = await boot();
    const held = s.model.hold(1);
    const turn = s.say({ sessionId: DM.sessionId, platform: A.platform }, '<续>', injected);
    await held.entered;
    await s.say(DM, '/stop');
    expect(s.replies(DM.sessionId)).toEqual([STOPPED]);
    await turn;
    expect(s.outcomes()).toEqual([['<续>', 'aborted']]);
  });

  it.each([
    ['不带 actor', {}],
    ['带无主体的 actor', { actor: selfInitiatedActor('webui') }],
  ])('没有账号的注入发的 /stop 停不了没有主体的一轮（%s）：这一轮照常回完', async (_kind, actor) => {
    const s = await boot();
    const where = { sessionId: 'zz-stop-internal', platform: 'webui' };
    const injected = { source: 'scheduler', ownerApproved: true, ...actor };
    const held = s.model.hold(1);
    const turn = s.say(where, '<定时>', injected);
    await held.entered;
    await s.say(where, '/stop', injected);
    held.release();
    await turn;
    expect(s.outcomes()).toEqual([['<定时>', 'replied']]);
  });
});
