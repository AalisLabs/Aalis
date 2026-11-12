import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent as agentService, type TokenUsageEvent, type TurnInput } from '../../packages/api-agent/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { workflow } from '../../packages/api-workflow/src/index.js';
import { App, definePlugin, provide, services } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import mediaPlugin from '../../packages/plugin-media/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import subtaskPlugin from '../../packages/plugin-subtask/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import {
  type IncomingMessage,
  type Message,
  type OutgoingMessage,
  type TurnRecord,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { command, hanging, withCommands } from '../fixtures/clearing.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { sessionInfoOf } from '../fixtures/rooms.js';
import { callTool, StepModel, stepModelPlugin } from '../fixtures/step-llm.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 通道层：新消息从不打断在跑的一轮。每个会话同一时刻最多一轮；真人消息插进由真人消息开、还收输入的一轮（每次调用模型之前，
// 贡献组装与 agent:llm:before 之后、调用之前），插不进的排队；一轮结束后队首是真人消息时，队里的真人消息一起开下一轮，
// 前面说明是上一轮进行期间到的；带来源的注入各自成一轮。输入在进入一轮时归档。能停下一轮的只有停止（只停在跑的一轮）、
// 连同排队项的停止（禁言、停机、会话删除、清消息历史），放掉的输入在那一轮落定之后归档（会话删除与清消息历史不归档）；/clear
// 经 agent 先停下并按住会话再跑整条清理，清的期间到的输入清完再处理，不看各家清理中间件登记在 agent 之前还是之后；停在等着
// 别处的工具（wait_subtasks、workflow_run）里的一轮随中止不再等。读历史时夹进工具调用组的别的消息挪到组后，结果没找齐的组与
// 不在任何组里的结果不发给模型。
// 模型是能阻塞某一次调用的替身（step-llm），工具是探针；会话管理是按 id 现造记录的替身（onebot 的房间带出生平台与聊天窗口）；
// 看组内次序的用例换上按时间戳读历史的存储替身（同 Mongo 与 sqlite 的读法）。
// ════════════════════════════════════════════════════════════

const PROBE = 'zz_steer_probe';
const QUEUED_NOTE = '下面几条是你上一轮进行期间到的';
const QUIET_NOTE = '没有需要接的可以不说话';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
/** 没有停下的人时停下标记的那一句 */
const STOPPED_NOTE = '就被停下了';

const WEBUI = { sessionId: 'zz-steer-webui', platform: 'webui', userId: 'console' };
const GROUP_ID = 'onebot:10000:group:20001';
const GROUP = { sessionId: GROUP_ID, platform: 'onebot', userId: '30001', sessionType: 'group', groupId: '20001' };

type Where = Pick<IncomingMessage, 'sessionId' | 'platform' | 'userId' | 'sessionType' | 'groupId'>;

const text = (m: Message) => (typeof m.content === 'string' ? m.content : '');
/** 用例里每条输入的正文是一个尖括号记号，取出它（前面是时间与发送者标注） */
const token = (s: string) => s.match(/<[^<>\s]+>/)?.[0] ?? s;
/**
 * 历史与请求里的一条：输入取记号，工具调用组写 call / result，没有落库回复的一轮的回合记录写结局，停下标记写「停下标记」，回复与
 * 说明取正文
 */
const shape = (m: Message) =>
  m.role === 'user' || m.role === 'notice'
    ? token(text(m))
    : m.role === 'tool'
      ? 'result'
      : m.toolCalls?.length
        ? 'call'
        : m.kind === WellKnownKinds.EventMarker && m.metadata?.[WellKnownMetadataKeys.TurnRecord]
          ? `结局 ${(m.metadata[WellKnownMetadataKeys.TurnRecord] as TurnRecord).outcome}`
          : m.kind === WellKnownKinds.TurnStopped
            ? '停下标记'
            : text(m);
const label = (inputs: readonly TurnInput[]) => inputs.map(i => i.message.content).join('+');
/** 让排着的微任务与 I/O 回调执行完毕：逐条处理之后的入队在这之前落定 */
const settle = () => new Promise(resolve => setImmediate(resolve));

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
});

interface Turn {
  turnId: string;
  sessionId: string;
  inputs: readonly TurnInput[];
  outcome?: string;
}

async function boot(
  opts: {
    decide?: (request: ChatModelRequest, n: number) => ChatResponse;
    /** 会话管理的替身：会话记录按 id 现造，代号由 deleteSession 换 */
    sessions?: boolean;
    /** 装在 agent 之前的插件 */
    before?: (app: App) => Promise<void>;
    /** 装在 agent 之后的插件 */
    after?: (app: App) => Promise<void>;
    /** 各会话启用的工具分组（不在分组里的探针总能用） */
    toolGroups?: string[];
  } = {},
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const model = new StepModel(opts.decide ?? ((_request, n) => ({ content: `回${n}` })));
  const host = app.bind({ provide, events, hooks, agent: agentService, memory, tools, services });
  const generations = new Map<string, number>();
  if (opts.sessions) {
    host.provide.use(sessionManager, {
      getSession: (id: string) => sessionInfoOf(id),
      recordInbound: async () => {},
      generationOf: (id: string) => generations.get(id) ?? 0,
    } as unknown as SessionManagerService);
  }
  await app.plugin(stepModelPlugin(model));
  await app.plugin(toolsPlugin, { enabledToolGroups: opts.toolGroups ?? [] });
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await opts.before?.(app);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await opts.after?.(app);
  await app.plugins.idle();
  for (const name of [toolsPlugin.name, agentPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }

  const turns: Turn[] = [];
  /** 各轮开始与结束的先后 */
  const order: string[] = [];
  host.hooks.use.middleware('agent:turn:before', async (data, next) => {
    turns.push({ turnId: data.turnId, sessionId: data.sessionId, inputs: data.inputs });
    order.push(`开 ${label(data.inputs)}`);
    await next();
  });
  host.hooks.use.middleware('agent:turn:after', async (data, next) => {
    const turn = turns.find(t => t.turnId === data.turnId);
    if (turn) turn.outcome = data.outcome;
    order.push(`结 ${label(data.inputs)}`);
    await next();
  });
  const outbound: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => void outbound.push(message));
  /** 各会话此刻排着与待插入的输入 */
  const waiting = new Map<string, readonly IncomingMessage[]>();
  host.events.use.on('agent:queue', state => void waiting.set(state.sessionId, state.waiting));
  const agent = host.agent.use;
  return {
    app,
    host,
    model,
    agent,
    turns,
    order,
    outbound,
    /** 各轮的输入与结局 */
    outcomes: () => turns.map(t => [label(t.inputs), t.outcome]),
    /** 等到这个会话有 count 条排着或待插入的输入（逐条处理慢的输入用它等入队） */
    untilWaiting: (sessionId: string, count: number) =>
      vi.waitFor(() => expect(waiting.get(sessionId)?.length).toBe(count)),
    /** 登记探针工具 */
    tool(handler: (ctx: ToolCallContext) => Promise<string>) {
      host.tools.use.register({
        definition: {
          type: 'function',
          function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
        },
        handler: (_args, ctx) => handler(ctx),
      });
    },
    say: (where: Where, content: string, extra: Partial<IncomingMessage> = {}) =>
      agent.handleMessage({ content, ...where, ...extra }),
    /** 这个会话的宿主通知（带来源的注入） */
    notice: (sessionId: string, content: string, id = '1') =>
      agent.handleMessage({
        content,
        sessionId,
        platform: 'webui',
        source: `bg:${id}`,
        hostNotice: { kind: 'background', id },
      }),
    /** 会话管理的替身删会话（不经 clearing）：开始删除时换这个会话的代号，再发 session:deleted */
    async deleteSession(sessionId: string) {
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
      await host.events.use.emit('session:deleted', sessionId);
    },
    history: (sessionId: string) => host.memory.use.getHistory(sessionId, 100),
  };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/**
 * 换上包着内存后端的存储：onSave 在每次写入之前跑（可以阻塞它），读历史按时间戳、同一毫秒按写入先后排（同 Mongo 与 sqlite 的
 * 读法；内存后端本身按写入先后存，排序是稳定的）
 */
function tapMemory(s: Booted, onSave: (message: Message) => Promise<void>) {
  const inner = s.host.services.use.get(memory) as MemoryService;
  const tapped = new Proxy(inner, {
    get(target, key) {
      if (key === 'saveMessage') {
        return async (sessionId: string, message: Message) => {
          await onSave(message);
          return target.saveMessage(sessionId, message);
        };
      }
      if (key === 'getHistory') {
        return async (sessionId: string, limit = 50) => {
          const all = await target.getHistory(sessionId, Infinity);
          all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
          return all.slice(Math.max(0, all.length - limit));
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  s.host.provide.use(memory, tapped, { priority: 1000 });
}

/** 按时间戳读历史的存储，阻塞工具调用组的第二条写入（第一条结果），时钟停在组内：组的调用是 T0、结果是 T0+1，之后的写入都在 T0 */
function holdGroupWrite(s: Booted) {
  const entered = deferred();
  const release = deferred();
  let hang = true;
  tapMemory(s, async message => {
    if (!hang || message.role !== 'tool') return;
    hang = false;
    vi.useFakeTimers({ toFake: ['Date'], now: (message.timestamp ?? Date.now()) - 1 });
    entered.resolve();
    await release.promise;
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

/** 停在工具里的探针：第 n 次调用进来时落定 entered，放行之后回 result */
function heldTool(result = '<工具结果>') {
  const entered = deferred();
  const release = deferred();
  const contexts: ToolCallContext[] = [];
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    contexts,
    handler: async (ctx: ToolCallContext) => {
      contexts.push(ctx);
      if (contexts.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  };
}

describe.each([
  ['WebUI 会话', WEBUI, false],
  ['onebot 群会话', GROUP, true],
] as const)('会话一视同仁：%s', (_kind, where, sessions) => {
  it('不打断：唯一一次模型调用期间先后到的 B、C 排着，这一轮照常回；之后合成一轮、各一条，前面说明是上一轮进行期间到的', async () => {
    const s = await boot({ sessions });
    const held = s.model.hold(1);
    const a = s.say(where, '<甲>');
    await held.entered;
    const b = s.say(where, '<乙>');
    const c = s.say(where, '<丙>');
    await settle();
    held.release();
    await Promise.all([a, b, c]);

    expect(s.outcomes()).toEqual([
      ['<甲>', 'replied'],
      ['<乙>+<丙>', 'replied'],
    ]);
    expect(s.outbound.map(m => m.content)).toEqual(['回1', '回2']);
    const second = s.model.requests[1].messages;
    const note = second.findIndex(m => m.role === 'system' && text(m).includes(QUEUED_NOTE));
    expect(note, '由排着的真人消息开的一轮写明它们是上一轮进行期间到的').toBeGreaterThan(0);
    const inputs = second.slice(note + 1).filter(m => m.metadata?.injector !== 'focus-guidance');
    expect(inputs.map(shape)).toEqual(['<乙>', '<丙>']);
    expect((await s.history(where.sessionId)).map(shape)).toEqual(['<甲>', '回1', '<乙>', '<丙>', '回2']);
  });

  it('叠加·第一次调用之前：A 卡在贡献构建里时到的 B（带图）插进第一次调用，图经 media 规范化过，整轮一条回复', async () => {
    const entered = deferred();
    const build = deferred();
    const s = await boot({
      sessions,
      after: async app => {
        const root = app.bind({ provide });
        root.provide.use(processService, {} as never);
        root.provide.use(storage, {} as never);
        await app.plugin(mediaPlugin, { vision: { delivery: 'describe', recognizeOnArrival: false } });
        await app.plugin(
          definePlugin({
            name: 'zz-slow-contribution',
            uses: { contributions },
            apply: ({ contributions }) => {
              contributions.use.contribute('agent:prompt', {
                id: 'slow',
                anchor: 'turn-context',
                build: async () => {
                  entered.resolve();
                  await build.promise;
                  return null;
                },
              });
            },
          }),
        );
      },
    });
    expect(s.app.plugins.getPlugin(mediaPlugin.name)?.state).toBe('active');
    const a = s.say(where, '<甲>');
    await entered.promise;
    const b = s.say(where, '<乙>', { attachments: [{ kind: 'image', data: PNG }] });
    await s.untilWaiting(where.sessionId, 1);
    build.resolve();
    await Promise.all([a, b]);

    expect(s.model.requests).toHaveLength(1);
    const users = s.model.requests[0].messages.filter(m => m.role === 'user');
    expect(users.map(shape)).toEqual(['<甲>', '<乙>']);
    expect(users[1].images, '插进来之后重跑的 agent:llm:before 里经 media 规范化（describe 交付清空）').toEqual([]);
    expect(s.outcomes()).toEqual([['<甲>+<乙>', 'replied']]);
    expect(s.outbound.map(m => m.content)).toEqual(['回1']);
  });

  it('叠加·工具之后：A 卡在工具里时 A 再发的一条（带文件）插在工具结果之后，过了逐条处理；历史里排在工具调用组之后，组完整', async () => {
    const s = await boot({ sessions, decide: (_r, n) => (n === 1 ? callTool(PROBE) : { content: `回${n}` }) });
    const tool = heldTool();
    s.tool(tool.handler);
    // 逐条输入的两个消费方：读文件的预处理器（写进附件描述），与按正文记录的中间件（关系分、技能触发同一个钩子）
    const seen: string[] = [];
    s.host.hooks.use.middleware('agent:input:before', async (data, next) => {
      seen.push(token(data.message.content));
      await next();
    });
    s.agent.registerPreprocessor?.('zz-file-reader', async (message, next) => {
      const file = message.attachments?.find(att => att.kind === 'file');
      if (file) message._attachmentDescriptions = [`[文件: ${file.name}]\n<文件正文>`];
      await next();
    });

    const a = s.say(where, '<甲>');
    await tool.entered;
    const b = s.say(where, '<乙>', { attachments: [{ kind: 'file', data: 'data:/files/x.txt', name: 'x.txt' }] });
    await settle();
    tool.release();
    await Promise.all([a, b]);

    expect(s.outcomes()).toEqual([['<甲>+<乙>', 'replied']]);
    expect(seen).toEqual(['<甲>', '<乙>']);
    const second = s.model.requests[1].messages;
    const result = second.findIndex(m => m.role === 'tool');
    const joined = second.findIndex(m => m.role === 'user' && text(m).includes('<乙>'));
    expect(joined, '插进来的排在工具结果之后').toBeGreaterThan(result);
    expect(text(second[joined])).toContain('<文件正文>');
    expect((await s.history(where.sessionId)).map(shape)).toEqual(['<甲>', 'call', 'result', '<乙>', '回2']);
  });
});

describe('插入与排队', () => {
  it('工具调用组落库期间（组的第二条写入挂起，时钟停在组内）到达的输入：按时间戳读历史的存储把它排进组中间，下一轮读历史时挪到组后，组完整', async () => {
    const s = await boot({ decide: (_r, n) => (n === 1 ? callTool(PROBE) : { content: `回${n}` }) });
    s.tool(async () => '<工具结果>');
    const write = holdGroupWrite(s);
    const a = s.say(WEBUI, '<甲>');
    await write.entered;
    const b = s.say(WEBUI, '<乙>');
    await settle();
    write.release();
    await Promise.all([a, b]);
    vi.useRealTimers();

    // 组的结果按 T0+1 记时间戳，之后的写入停在 T0：按时间戳读，插进来的输入与回复都排在调用与结果之间
    expect((await s.history(WEBUI.sessionId)).map(shape)).toEqual(['<甲>', 'call', '<乙>', '回2', 'result']);
    await s.say(WEBUI, '<丙>');
    expect(s.model.requests[2].messages.filter(m => m.role !== 'system').map(shape)).toEqual([
      '<甲>',
      'call',
      'result',
      '<乙>',
      '回2',
      '<丙>',
    ]);
  });

  it('读历史：结果没找齐的工具调用组连同找到的结果、不在任何组里的结果都不发给模型，别的照发', async () => {
    const s = await boot();
    const call = (id: string) => ({ id, type: 'function' as const, function: { name: PROBE, arguments: '{}' } });
    const stored: Message[] = [
      { role: 'user', content: '<甲>', timestamp: 1 },
      { role: 'assistant', content: null, toolCalls: [call('call-1'), call('call-2')], timestamp: 2 },
      { role: 'tool', content: '<找到的结果>', toolCallId: 'call-1', timestamp: 3 },
      { role: 'tool', content: '<组外的结果>', toolCallId: 'call-gone', timestamp: 4 },
      { role: 'assistant', content: '<答>', timestamp: 5 },
    ];
    for (const message of stored) await s.host.memory.use.saveMessage(WEBUI.sessionId, message);
    await s.say(WEBUI, '<乙>');

    expect(s.model.requests[0].messages.filter(m => m.role !== 'system').map(shape)).toEqual(['<甲>', '<答>', '<乙>']);
  });

  it('时间标注取归档时刻：归档之后过了一分钟才组装，标注仍写归档那一分钟，下一轮历史里同一条的标注不变', async () => {
    const s = await boot();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 24, 10, 0, 30) });
    let archived = false;
    tapMemory(s, async message => {
      // 这一轮的输入带着归档时刻写下，之后的组装在下一分钟
      if (archived || message.role !== 'user') return;
      archived = true;
      vi.setSystemTime(Date.now() + 61_000);
    });
    await s.say(WEBUI, '<甲>');
    await s.say(WEBUI, '<乙>');
    vi.useRealTimers();

    const [first, second] = s.model.requests.map(request => request.messages.filter(m => m.role === 'user'));
    expect(text(first[0])).toContain('(10/24 10:00) ');
    expect(text(second[0]), '之后进历史时是同一个标注').toBe(text(first[0]));
  });

  it('注入各自成一轮：真人回合在跑时到的定时任务、宿主通知、编排节点各自在它之后单独一轮；注入回合在跑时到的真人消息排在它之后', async () => {
    const s = await boot();
    const first = s.model.hold(1);
    const second = s.model.hold(2);
    const { sessionId } = WEBUI;
    const a = s.say(WEBUI, '<甲>');
    await first.entered;
    const injected = [
      s.agent.handleMessage({ content: '<定时>', sessionId, platform: 'webui', source: 'scheduler' }),
      s.notice(sessionId, '<通知一>', '1'),
      s.agent.handleMessage({
        content: '<编排>',
        sessionId,
        platform: 'workflow',
        source: 'workflow:zz:a',
        triggerType: 'proactive',
      }),
      s.notice(sessionId, '<通知二>', '2'),
    ];
    await settle();
    first.release();
    await second.entered;
    const human = s.say(WEBUI, '<乙>');
    await settle();
    second.release();
    await Promise.all([a, ...injected, human]);

    expect(s.order).toEqual(
      ['<甲>', '<定时>', '<通知一>', '<编排>', '<通知二>', '<乙>'].flatMap(input => [`开 ${input}`, `结 ${input}`]),
    );
  });

  it('排着的注入不进先开的一轮：队里依次是真人 B、宿主通知 X 时，B 那一轮的请求里没有 X；之后的历史里 X 排在 B 那一轮的回复之后', async () => {
    const s = await boot();
    const held = s.model.hold(1);
    const a = s.say(WEBUI, '<甲>');
    await held.entered;
    const b = s.say(WEBUI, '<乙>');
    const x = s.notice(WEBUI.sessionId, '<通知>');
    await settle();
    held.release();
    await Promise.all([a, b, x]);

    expect(s.model.requests[1].messages.some(m => text(m).includes('<通知>'))).toBe(false);
    expect((await s.history(WEBUI.sessionId)).map(shape)).toEqual(['<甲>', '回1', '<乙>', '回2', '<通知>', '回3']);
  });

  it('参与者：B 的话叠进 A 的回合之后，之后的工具调用参与者为 A、B，之前已执行的不变', async () => {
    const s = await boot({ decide: (_r, n) => (n <= 2 ? callTool(PROBE) : { content: `回${n}` }) });
    const tool = heldTool();
    s.tool(tool.handler);
    const where = { sessionId: 'zz-steer-room', platform: 'test' };
    const a = s.say({ ...where, userId: 'u1' }, '<甲>');
    await tool.entered;
    const b = s.say({ ...where, userId: 'u2' }, '<乙>');
    await settle();
    tool.release();
    await Promise.all([a, b]);

    expect(tool.contexts.map(ctx => ctx.participants)).toEqual([
      [{ platform: 'test', userId: 'u1' }],
      [
        { platform: 'test', userId: 'u1' },
        { platform: 'test', userId: 'u2' },
      ],
    ]);
  });

  it('historyMessages 按追加计入插进来的输入', async () => {
    const s = await boot({ decide: (_r, n) => (n === 1 ? callTool(PROBE) : { content: `回${n}` }) });
    const tool = heldTool();
    s.tool(tool.handler);
    const usages: TokenUsageEvent[] = [];
    s.host.events.use.on('token:usage', usage => void usages.push(usage));
    const a = s.say(WEBUI, '<甲>');
    await tool.entered;
    const b = s.say(WEBUI, '<乙>');
    await settle();
    tool.release();
    await Promise.all([a, b]);

    expect(usages).toHaveLength(2);
    expect(usages[1].historyMessages, '工具调用组两条，加插进来的一条').toBe(usages[0].historyMessages + 3);
  });

  it('agent:queue：输入排队、待插入时发，进了一轮时再发，列表按入队先后', async () => {
    const s = await boot();
    const waits: string[][] = [];
    s.host.events.use.on('agent:queue', ({ sessionId, waiting }) => {
      if (sessionId === WEBUI.sessionId) waits.push(waiting.map(message => message.content));
    });
    const held = s.model.hold(1);
    const a = s.say(WEBUI, '<甲>');
    await held.entered;
    const b = s.say(WEBUI, '<乙>');
    await settle();
    const x = s.notice(WEBUI.sessionId, '<通知>');
    await settle();
    held.release();
    await Promise.all([a, b, x]);

    expect(waits).toEqual([['<乙>'], ['<乙>', '<通知>'], ['<通知>'], []]);
  });

  it('说明文字：多方房间里一批全是没点名的插话时，末尾写可以不说话；私聊与批里有点名的不写', async () => {
    const s = await boot({ sessions: true });
    /** 在这个会话里开一轮、停在模型调用里，这期间到的几条（发送者与触发方式）排着，回第二次请求里的说明 */
    const noteOf = async (where: Where, later: Array<Partial<IncomingMessage>>) => {
      const n = s.model.requests.length;
      const held = s.model.hold(n + 1);
      const a = s.say(where, '<开>', { triggerType: 'direct' });
      await held.entered;
      const rest = later.map((extra, i) => s.say(where, `<后${i}>`, extra));
      await settle();
      held.release();
      await Promise.all([a, ...rest]);
      return s.model.requests[n + 1].messages.find(m => m.role === 'system' && text(m).includes(QUEUED_NOTE));
    };
    const interval = (userId: string) => ({ userId, triggerType: 'interval' as const });

    const group = await noteOf(GROUP, [interval('30002'), interval('30003')]);
    expect(text(group as Message)).toContain(QUIET_NOTE);
    const mixed = await noteOf(GROUP, [interval('30002'), { userId: '30003', triggerType: 'direct' }]);
    expect(text(mixed as Message)).not.toContain(QUIET_NOTE);
    const priv = await noteOf(
      { sessionId: 'onebot:10000:private:30001', platform: 'onebot', userId: '30001', sessionType: 'private' },
      [interval('30001')],
    );
    expect(text(priv as Message)).toContain(QUEUED_NOTE);
    expect(text(priv as Message)).not.toContain(QUIET_NOTE);
  });

  it('焦点指引：多方按根会话记下的，owner 从 WebUI 往群里发的话开的一轮、之后插进群友点名的话时，焦点指引列出那条点名', async () => {
    const s = await boot({
      sessions: true,
      decide: (_r, n) => (n === 1 ? callTool(PROBE) : { content: `回${n}` }),
    });
    const tool = heldTool();
    s.tool(tool.handler);
    const a = s.say({ sessionId: GROUP_ID, platform: 'webui', userId: 'console' }, '<甲>');
    await tool.entered;
    const b = s.say(GROUP, '<乙>', { userId: '30002', nickname: '<小明>', triggerType: 'direct' });
    await settle();
    tool.release();
    await Promise.all([a, b]);

    const focusOf = (messages: Message[]) => messages.filter(m => m.metadata?.injector === 'focus-guidance').map(text);
    const [first, second] = s.model.requests.map(request => request.messages);
    expect(focusOf(first), '没经触发判定的按点名算').toEqual([expect.stringContaining('console')]);
    const latest = focusOf(second).at(-1);
    expect(latest).toContain('console');
    expect(latest).toContain('30002');
    expect(latest, '焦点指引是系统消息，不放群友自己设的名字').not.toContain('<小明>');
  });

  it('多方房间里插进点名的输入：焦点指引不改旧的那块，在插进来的之前另加一块，下一次请求以上一次请求为前缀', async () => {
    const s = await boot({
      sessions: true,
      decide: (_r, n) => (n === 1 ? callTool(PROBE) : { content: `回${n}` }),
    });
    const tool = heldTool();
    s.tool(tool.handler);
    const a = s.say(GROUP, '<甲>', { triggerType: 'immediate' });
    await tool.entered;
    const b = s.say(GROUP, '<乙>', { userId: '30002', triggerType: 'immediate' });
    await settle();
    tool.release();
    await Promise.all([a, b]);

    const [first, second] = s.model.requests.map(request => request.messages);
    expect(first.some(m => m.metadata?.injector === 'focus-guidance')).toBe(true);
    expect(second.slice(0, first.length)).toEqual(first);
    const focusOrShape = (m: Message) => (m.metadata?.injector === 'focus-guidance' ? 'focus' : shape(m));
    expect(second.slice(first.length).map(focusOrShape)).toEqual(['call', 'result', 'focus', '<乙>']);
  });

  it('带来源的注入不算点名：群里定时任务开的一轮没有焦点指引', async () => {
    const s = await boot({ sessions: true });
    await s.agent.handleMessage({ content: '<定时>', sessionId: GROUP_ID, platform: 'onebot', source: 'scheduler' });

    expect(s.outcomes()).toEqual([['<定时>', 'replied']]);
    expect(s.model.requests[0].messages.some(m => m.metadata?.injector === 'focus-guidance')).toBe(false);
  });
});

describe('能停下一轮的', () => {
  it('停止：abort(会话) 停掉在跑的一轮，不落库回复、不外发，结局为 aborted；待插入与排队的照常开下一轮；turnId 对不上时返回 false', async () => {
    const s = await boot();
    const held = s.model.hold(1);
    const a = s.say(WEBUI, '<甲>');
    await held.entered;
    const b = s.say(WEBUI, '<乙>');
    const x = s.notice(WEBUI.sessionId, '<通知>');
    await settle();
    expect(s.agent.abort(WEBUI.sessionId, { turnId: 'not-this-turn' })).toBe(false);
    expect(s.agent.abort(WEBUI.sessionId)).toBe(true);
    await Promise.all([a, b, x]);

    expect(s.outcomes()).toEqual([
      ['<甲>', 'aborted'],
      ['<乙>', 'replied'],
      ['<通知>', 'replied'],
    ]);
    expect(s.outbound.map(m => m.content)).toEqual(['回2', '回3']);
    // 停下的一轮没有落库回复：先落给下一轮的模型看的停下标记，再落回合记录；没有停下的人，标记里不写是谁
    const sent = s.model.requests[1].messages;
    const at = sent.map(shape).indexOf('<甲>');
    expect(sent.slice(at, at + 2).map(shape)).toEqual(['<甲>', '停下标记']);
    expect(sent[at + 1].content).toContain(STOPPED_NOTE);
    expect((await s.history(WEBUI.sessionId)).map(shape)).toEqual([
      '<甲>',
      '停下标记',
      '结局 aborted',
      '<乙>',
      '回2',
      '<通知>',
      '回3',
    ]);
    expect(s.agent.abort(WEBUI.sessionId), '没有在跑的一轮').toBe(false);
  });

  it('停止：在 agent:llm:before 期间停下，已在待插入的与停下之后才到的真人消息都不进被停的那一轮，照常开下一轮', async () => {
    const s = await boot();
    const entered = deferred();
    const gate = deferred();
    let first = true;
    s.host.hooks.use.middleware('agent:llm:before', async (_data, next) => {
      if (first) {
        first = false;
        entered.resolve();
        await gate.promise;
      }
      await next();
    });
    const a = s.say(WEBUI, '<甲>');
    await entered.promise;
    const b = s.say(WEBUI, '<乙>');
    await settle();
    expect(s.agent.abort(WEBUI.sessionId)).toBe(true);
    const c = s.say(WEBUI, '<丙>');
    await settle();
    gate.resolve();
    await Promise.all([a, b, c]);

    expect(s.outcomes()).toEqual([
      ['<甲>', 'aborted'],
      ['<乙>+<丙>', 'replied'],
    ]);
  });

  it('停止：停在 wait_subtasks 里的一轮不再等子任务，工具回已中止，排着的消息马上开轮', async () => {
    const child = 'zz-steer-child';
    const s = await boot({
      decide: (_r, n) => (n === 1 ? callTool('wait_subtasks', { subtask_ids: [child] }) : { content: `回${n}` }),
      after: app => app.plugin(subtaskPlugin, {}).then(() => undefined),
      toolGroups: ['subtask'],
    });
    // 会话管理的替身：子任务是这个会话的直接子会话、一直在跑
    s.host.provide.use(
      sessionManager,
      {
        getSession: (id: string) => sessionInfoOf(id, id === child ? WEBUI.sessionId : undefined),
        listSessions: () => [],
        recordInbound: async () => {},
        generationOf: () => 0,
      } as unknown as SessionManagerService,
      { priority: 1000 },
    );
    // 没装权限插件：放行这一次调用（只看等待，不看权限）
    s.host.tools.use.setExecutionGuard(async () => ({ ok: true }));
    await stopInTool(s, 'wait_subtasks');
  });

  it('停止：停在 workflow_run 里的一轮不再等这次运行，工具回已中止，排着的消息马上开轮；运行不取消', async () => {
    const s = await boot({
      decide: (_r, n) => (n === 1 ? callTool('workflow_run', { id: 'zz-steer-wait' }) : { content: `回${n}` }),
      after: async app => {
        app.bind({ provide }).provide.use(storage, memoryStorage(new Map()));
        await app.plugin(cronEnginePlugin, {});
        await app.plugin(workflowPlugin, {});
      },
      toolGroups: ['workflow'],
    });
    const service = s.app.bind({ workflow }).workflow.use;
    await service.defineWorkflow(
      { id: 'zz-steer-wait', trigger: { type: 'manual' }, nodes: [{ id: 'w', type: 'wait', seconds: 600 }] },
      { persist: false },
    );
    // 没装权限插件：放行这一次调用（只看等待，不看权限）
    s.host.tools.use.setExecutionGuard(async () => ({ ok: true }));
    await stopInTool(s, 'workflow_run');
    expect(service.listRuns(1).map(run => run.status)).toEqual(['running']);
  });

  it('连同排队项：abort(会话, { queued: true }) 停掉在跑的一轮，排队与待插入的不开轮、handleMessage 都返回，在那一轮落定之后归档、不带回合 id', async () => {
    const s = await boot();
    const waits: string[][] = [];
    s.host.events.use.on('agent:queue', ({ waiting }) => void waits.push(waiting.map(message => message.content)));
    const held = s.model.hold(1);
    const a = s.say(WEBUI, '<甲>');
    await held.entered;
    const b = s.say(WEBUI, '<乙>');
    const x = s.notice(WEBUI.sessionId, '<通知>');
    await settle();
    expect(s.agent.abort(WEBUI.sessionId, { queued: true })).toBe(true);
    await Promise.all([a, b, x]);

    expect(s.outcomes()).toEqual([['<甲>', 'aborted']]);
    expect(waits.at(-1), '放掉之后没有排着的').toEqual([]);
    const turnId = s.turns[0].turnId;
    expect((await s.history(WEBUI.sessionId)).map(m => [shape(m), m.metadata?.turnId])).toEqual([
      ['<甲>', turnId],
      ['停下标记', turnId],
      ['结局 aborted', turnId],
      ['<乙>', undefined],
      ['<通知>', undefined],
    ]);
  });

  it('禁言：点名她之后、生成期间 setMuted(>0)，这一轮不外发、不落库回复，结局为 aborted，排着的不开轮；setMuted(0) 不停', async () => {
    const s = await boot({
      after: async app => {
        app.bind({ provide }).provide.use(storage, memoryStorage(new Map()));
        await app.plugin(flowControlPlugin, {});
      },
    });
    const flow = s.app.bind({ flowControl }).flowControl.use;
    const held = s.model.hold(1);
    const a = s.say(GROUP_FREE, '<甲>', { triggerType: 'immediate' });
    await held.entered;
    const b = s.say(GROUP_FREE, '<乙>', { triggerType: 'immediate' });
    const x = s.notice(GROUP_FREE.sessionId, '<通知>');
    await settle();
    flow.setMuted(GROUP_FREE.sessionId, 60, 'test');
    await Promise.all([a, b, x]);
    expect(s.outcomes()).toEqual([['<甲>', 'aborted']]);
    expect(s.outbound).toEqual([]);
    expect((await s.history(GROUP_FREE.sessionId)).map(shape)).toEqual([
      '<甲>',
      '停下标记',
      '结局 aborted',
      '<乙>',
      '<通知>',
    ]);

    flow.setMuted(GROUP_FREE.sessionId, 0);
    const next = s.model.hold(2);
    const c = s.say(GROUP_FREE, '<丙>', { triggerType: 'immediate' });
    await next.entered;
    flow.setMuted(GROUP_FREE.sessionId, 0);
    next.release();
    await c;
    expect(s.outcomes().at(-1)).toEqual(['<丙>', 'replied']);
    const stopped = s.model.requests[1].messages.find(m => m.kind === WellKnownKinds.TurnStopped);
    expect(stopped?.content, '禁言停下的一轮不写是谁').toContain(STOPPED_NOTE);
  });

  it('停机：app.stop 时在跑的一轮以 aborted 收尾，排着的 handleMessage 都落定、不开轮、已归档；放掉之后才完成逐条处理的那条同样不开轮', async () => {
    const late = deferred();
    const s = await boot({ after: app => app.plugin(slowPreprocessor('<丁>', late.promise)).then(() => undefined) });
    const inner = s.host.services.use.get(memory) as MemoryService;
    s.host.hooks.use.middleware('agent:turn:after', async (data, next) => {
      await next();
      // 停机已经放掉了排着的输入：这时才让还在逐条处理的那条往下走
      if (data.outcome === 'aborted') late.resolve();
    });
    const held = s.model.hold(1);
    const a = s.say(WEBUI, '<甲>');
    await held.entered;
    const b = s.say(WEBUI, '<乙>');
    const x = s.notice(WEBUI.sessionId, '<通知>');
    const d = s.say(WEBUI, '<丁>');
    await settle();
    apps.splice(apps.indexOf(s.app), 1);
    await s.app.stop();
    await Promise.all([a, b, x, d]);

    expect(s.outcomes()).toEqual([['<甲>', 'aborted']]);
    const archived = (await inner.getHistory(WEBUI.sessionId, 100)).map(shape);
    expect(archived.slice(0, 5)).toEqual(['<甲>', '停下标记', '结局 aborted', '<乙>', '<通知>']);
  });

  it('会话删除（会话管理换代号再发 session:deleted，不经 clearing）：在跑的一轮停下、排队项放掉不归档，删除等它落定；删除之前进来、之后才完成逐条处理的那条不开轮、不归档；之后同一 id 再来的消息照常开轮', async () => {
    const late = deferred();
    const s = await boot({
      sessions: true,
      after: app => app.plugin(slowPreprocessor('<丁>', late.promise)).then(() => undefined),
    });
    const held = s.model.hold(1);
    const a = s.say(WEBUI, '<甲>');
    await held.entered;
    const b = s.say(WEBUI, '<乙>');
    const x = s.notice(WEBUI.sessionId, '<通知>');
    const d = s.say(WEBUI, '<丁>');
    await settle();
    await s.deleteSession(WEBUI.sessionId);
    expect(s.outcomes(), '删除等在跑的一轮落定').toEqual([['<甲>', 'aborted']]);
    late.resolve();
    await Promise.all([a, b, x, d]);
    await s.say(WEBUI, '<戊>');

    expect(s.outcomes()).toEqual([
      ['<甲>', 'aborted'],
      ['<戊>', 'replied'],
    ]);
    expect((await s.history(WEBUI.sessionId)).map(shape)).toEqual(['<甲>', '停下标记', '结局 aborted', '<戊>', '回2']);
  });

  it.each([
    ['/clear', '这个会话', WEBUI],
    ['/clear all', '别的会话', { ...WEBUI, sessionId: 'zz-steer-other' }],
  ] as const)('清消息历史的 %s 先停下%s在跑的一轮（aborted），排着与待插入的不开轮、不归档，等它落定再跑清理链（登记在 agent 之前的一家也在这之后）；带 -t vector 的不停也不碰', async (line, _whose, where) => {
    /** 登记在 agent 之前的一家清理：记下它跑的那一刻最近一轮的结局 */
    const seen: Array<string | undefined> = [];
    let latest = (): string | undefined => undefined;
    const recorder = definePlugin({
      name: 'zz-clear-recorder',
      uses: { hooks },
      apply: ({ hooks }) => {
        hooks.use.middleware('memory:clear', async (_data, next) => {
          seen.push(latest());
          await next();
        });
      },
    });
    const s = await boot({
      before: app => app.plugin(recorder).then(() => undefined),
      after: async app => {
        await withCommands(app);
        await app.plugin(vectorType);
      },
    });
    latest = () => s.turns.at(-1)?.outcome;
    const held = s.model.hold(1);
    const a = s.say(where, '<甲>');
    await held.entered;
    const b = s.say(where, '<乙>');
    const x = s.notice(where.sessionId, '<通知>');
    await settle();
    await command(s.app, WEBUI.sessionId, line);
    expect(seen, '清理链跑之前这一轮已经停下并落定').toEqual(['aborted']);
    await Promise.all([a, b, x]);
    expect(s.outcomes()).toEqual([['<甲>', 'aborted']]);
    expect(await s.history(where.sessionId)).toEqual([]);

    const next = s.model.hold(2);
    const c = s.say(where, '<丙>');
    await next.entered;
    await command(s.app, WEBUI.sessionId, `${line} -t vector`);
    expect(seen, '不清消息历史的不停').toEqual(['aborted', undefined]);
    next.release();
    await c;
    expect(s.outcomes().at(-1)).toEqual(['<丙>', 'replied']);
  });

  it.each([
    '/clear',
    '/clear all',
  ])('%s，先清再调 next 的一家清理登记在 agent 之前：清的期间到的输入等清完再处理，不开轮、不被清掉，清完照常开轮', async line => {
    const cleaner = hanging('memory:clear');
    const s = await boot({ before: cleaner.install, after: withCommands });
    await s.say(WEBUI, '<甲>');
    const clear = command(s.app, WEBUI.sessionId, line);
    await cleaner.entered;
    const b = s.say(WEBUI, '<乙>');
    await settle();
    expect(s.turns, '清的期间没开新的一轮').toHaveLength(1);
    cleaner.release();
    await clear;
    await b;

    expect(s.outcomes()).toEqual([
      ['<甲>', 'replied'],
      ['<乙>', 'replied'],
    ]);
    expect((await s.history(WEBUI.sessionId)).map(shape)).toEqual(['<乙>', '回2']);
  });
});

/** 登记一个不清消息历史的清理类型 vector（/clear -t vector 才认得） */
const vectorType = definePlugin({
  name: 'zz-vector-type',
  uses: { contributions },
  apply: ({ contributions }) => void contributions.use.contribute('memory:clear-type', { id: 'vector', label: '向量' }),
});

/**
 * 开轮的那次调用里调 name 这个一直等着的工具：它开始之后真人消息排着，停止键停下这一轮，期望工具马上回已中止、这一轮随即落定，
 * 排着的那条马上开轮（不等工具自己的时限）
 */
async function stopInTool(s: Booted, name: string) {
  const started = deferred();
  s.host.events.use.on('tool:execute', event => {
    if (event.toolName === name && event.phase === 'start') started.resolve();
  });
  const a = s.say(WEBUI, '<甲>');
  // 开始之后让它过守卫、进处理函数
  await started.promise;
  await settle();
  const b = s.say(WEBUI, '<乙>');
  await s.untilWaiting(WEBUI.sessionId, 1);
  expect(s.agent.abort(WEBUI.sessionId)).toBe(true);
  await vi.waitFor(() =>
    expect(s.outcomes()).toEqual([
      ['<甲>', 'aborted'],
      ['<乙>', 'replied'],
    ]),
  );
  await Promise.all([a, b]);
  const result = (await s.history(WEBUI.sessionId)).find(m => m.role === 'tool');
  expect(JSON.parse(text(result as Message))).toEqual({ error: '调用已中止，不再等' });
}

describe('回合记录', () => {
  it('一轮只写一条：回复带着记录落库之后 agent:turn:after 的中间件抛错，不再补一条出错的记录', async () => {
    const s = await boot();
    let thrown = false;
    s.host.hooks.use.middleware('agent:turn:after', async (_data, next) => {
      await next();
      if (thrown) return;
      thrown = true;
      throw new Error('<下游出错>');
    });
    await s.say(WEBUI, '<甲>');
    const records = (await s.history(WEBUI.sessionId)).flatMap(m => {
      const record = m.metadata?.[WellKnownMetadataKeys.TurnRecord] as TurnRecord | undefined;
      return record ? [[shape(m), record.outcome]] : [];
    });
    expect(records).toEqual([['回1', 'replied']]);
  });
});

/** 不在流控生效范围里的会话：流控只管禁言 */
const GROUP_FREE = { sessionId: 'zz-steer-muted', platform: 'test', userId: 'u1' };

/** 逐条处理里阻塞某一条输入的预处理器：正文是 content 的那条等 gate 落定才往下 */
function slowPreprocessor(content: string, gate: Promise<void>) {
  return definePlugin({
    name: 'zz-slow-preprocessor',
    uses: { agent: agentService },
    apply: ({ agent }) => {
      agent.use.registerPreprocessor('zz-slow', async (message, next) => {
        if (message.content === content) await gate;
        await next();
      });
    },
  });
}
