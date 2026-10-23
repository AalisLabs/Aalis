import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import type { ToolCallContext } from '../../packages/api-tools/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { memoryStorage } from '../fixtures/paper.js';
import { answerOf, cardOf, closeParticipantApps, participantsApp } from '../fixtures/participants.js';
import { callTool, StepModel, stepModelPlugin } from '../fixtures/step-llm.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 通道层接上多条输入之后的参与者与逐动作审批（真的 agent、工具注册表、权限插件、会话管理与会话服务；模型是能挂住某一次调用的
// 替身）：叠进来的人从下一批工具起算参与者，已执行的不追溯；在等的审批不因新消息撤销，等它结了这批工具之后才插进去；owner 的
// 各个身份合成一个参与者，取最先进来的那一个，只有 owner 能批的审批推不推她的 IM 私聊按它判。
// ════════════════════════════════════════════════════════════

const BOT = '10000';
const ROOM = `onebot:${BOT}:group:20001`;
const PRIVATE = `onebot:${BOT}:private:99999`;
const OWNER_QQ = { platform: 'onebot', userId: '99999' };
const OWNER_WEBUI = { platform: 'webui', userId: 'console' };
const L0 = { platform: 'onebot', userId: '30000' };

/** 门槛 1 的探针；声明了确认的探针 */
const SENSITIVE = 'zz_steer_sensitive';
const CONFIRM = 'zz_steer_confirm';

type Identity = { platform: string; userId: string };

afterEach(closeParticipantApps);

async function setup(decide: (n: number) => ChatResponse) {
  const model = new StepModel((_request, n) => decide(n));
  const s = await participantsApp({
    config: { owners: [OWNER_QQ] },
    files: memoryStorage(new Map()),
    rooms: [ROOM, PRIVATE],
    after: [stepModelPlugin(model), messageArchivePlugin, agentPlugin],
  });
  const host = s.app.bind({ agent: agentService, hooks, messageArchive });
  /** 每次执行时的工具调用上下文；第一次执行停住，直到放行 */
  const contexts: ToolCallContext[] = [];
  const entered = deferred();
  const release = deferred();
  for (const [name, extra] of [
    [SENSITIVE, { risk: 'sensitive' }],
    [CONFIRM, { confirm: 'session' }],
  ] as const) {
    s.host.tools.use.register({
      ...extra,
      definition: {
        type: 'function',
        function: { name, description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async (_args, ctx) => {
        contexts.push(ctx);
        if (contexts.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return 'ran';
      },
    });
  }
  /** who 在 sessionId 里说一句；群里的带触发方式 */
  const say = (sessionId: string, who: Identity, content: string, extra: Partial<IncomingMessage> = {}) =>
    host.agent.use.handleMessage({
      content,
      sessionId,
      ...who,
      ...(sessionId === ROOM ? { sessionType: 'group', groupId: '20001', selfId: BOT } : {}),
      ...extra,
    });
  return {
    ...s,
    host,
    model,
    contexts,
    say,
    toolEntered: entered.promise,
    releaseTool: () => release.resolve(),
  };
}

/** 让排着的微任务与 I/O 回调跑完：逐条处理之后的入队在这之前落定 */
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('叠进来的人从下一批工具起算参与者', () => {
  it('owner 点名开轮、0 级群友被频率触发挑中的一句叠进来之后，门槛 1 的工具产生参与者审批（群友按他本人算），owner 在 WebUI 批了才执行；叠进来之前的调用不问', async () => {
    const s = await setup(n => (n <= 2 ? callTool(SENSITIVE) : { content: '好了' }));
    const a = s.say(ROOM, OWNER_QQ, '<甲>', { triggerType: 'direct' });
    await s.toolEntered;
    expect(s.webuiCards(), '只有 owner 时门槛 1 的工具不问').toEqual([]);
    const b = s.say(ROOM, L0, '<乙>', { triggerType: 'interval' });
    await settle();
    s.releaseTool();
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(1));
    const [card] = s.webuiCards();
    expect(card.origin.participants, '插话按说话的人算').toEqual([OWNER_QQ, L0]);
    expect(s.contexts, '批之前不执行').toHaveLength(1);
    await s.conn?.call('approval/respond', answerOf(card, 'approve'));
    await Promise.all([a, b]);
    expect(s.contexts.map(ctx => ctx.participants)).toEqual([[OWNER_QQ], [OWNER_QQ]]);
  });

  it('owner 从 WebUI 与终端各说一句算一个参与者；被触发器吞掉、这一轮读历史之前归档的群友的话是历史，不算参与者', async () => {
    const s = await setup(n => (n <= 2 ? callTool(SENSITIVE) : { content: '好了' }));
    // 这一轮读历史之前，群友没点名的一句被触发判定吞掉并归档（影子归档）
    s.host.hooks.use.middleware('agent:turn:before', async (data, next) => {
      if (data.sessionId === ROOM) {
        await s.host.messageArchive.use.archiveIncoming({
          content: '<旁>',
          sessionId: ROOM,
          ...L0,
          sessionType: 'group',
          groupId: '20001',
        });
      }
      await next();
    });
    const a = s.say(ROOM, OWNER_WEBUI, '<甲>');
    await s.toolEntered;
    const b = s.say(ROOM, { platform: 'cli', userId: 'console' }, '<乙>');
    await settle();
    s.releaseTool();
    await Promise.all([a, b]);
    expect(s.contexts.map(ctx => ctx.participants)).toEqual([[OWNER_WEBUI], [OWNER_WEBUI]]);
    expect(s.webuiCards()).toEqual([]);
  });
});

describe('审批等待中来新消息', () => {
  it('owner 在等审批时，群友触发了的消息与 owner 的新消息都不撤销审批，排到这批工具之后插进去；在等的那张批过按 owner 执行，下一批工具才按两人判', async () => {
    const s = await setup(n => (n === 1 ? callTool(CONFIRM) : n === 2 ? callTool(SENSITIVE) : { content: '好了' }));
    const a = s.say(ROOM, OWNER_QQ, '<甲>', { triggerType: 'direct' });
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(1));
    const [card] = s.webuiCards();
    const b = s.say(ROOM, L0, '<乙>', { triggerType: 'direct' });
    const c = s.say(ROOM, OWNER_QQ, '<丙>', { triggerType: 'direct' });
    await settle();
    expect(s.conn?.notifications('approval/settled'), '新消息不撤销在等的审批').toEqual([]);
    await s.conn?.call('approval/respond', answerOf(card, 'approve'));
    await s.toolEntered;
    s.releaseTool();
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(2));
    const next = s.webuiCards()[1];
    expect(next.origin.participants, '下一批工具按两人判').toEqual([OWNER_QQ, L0]);
    await s.conn?.call('approval/respond', answerOf(next, 'approve'));
    await Promise.all([a, b, c]);
    expect(s.contexts.map(ctx => ctx.participants)).toEqual([[OWNER_QQ], [OWNER_QQ]]);
    const second = s.model.requests[1].messages;
    const result = second.findIndex(m => m.role === 'tool');
    expect(second.slice(result + 1).filter(m => m.role === 'user').length, '两条都排在工具结果之后').toBe(2);
  });
});

describe('owner 身份合一与 IM 私聊推送', () => {
  it.each([
    ['WebUI 开轮、她从 QQ 私聊说的一句叠进来：只有 owner 能批的审批推到 WebUI，不推 IM 私聊', OWNER_WEBUI, OWNER_QQ, 0],
    ['QQ 私聊开轮、WebUI 的一句叠进来：推 IM 私聊', OWNER_QQ, OWNER_WEBUI, 1],
  ] as const)('%s', async (_name, first, second, pushed) => {
    const s = await setup(n => (n === 1 ? callTool(SENSITIVE) : n === 2 ? callTool(CONFIRM) : { content: '好了' }));
    const im = s.attend(OWNER_QQ, { selfId: BOT });
    const a = s.say(PRIVATE, first, '<甲>');
    await s.toolEntered;
    const b = s.say(PRIVATE, second, '<乙>');
    await settle();
    s.releaseTool();
    await vi.waitFor(() => expect(s.webuiCards()).toHaveLength(1));
    if (pushed) await cardOf(im);
    expect(im.requested).toHaveLength(pushed);
    await s.conn?.call('approval/respond', answerOf(s.webuiCards()[0], 'approve'));
    await Promise.all([a, b]);
    expect(s.contexts).toHaveLength(2);
  });
});
