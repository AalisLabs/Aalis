import { expect, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { definePlugin, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import type { IncomingMessage, Message } from '../../packages/schema-message/src/index.js';
import { deferred } from '../helpers/deferred.js';
import { fieldsPlugin, SCHEMA, startSettings } from './session-settings.js';
import { type RequestDraft, toolContext } from './tool-call.js';

// ════════════════════════════════════════════════════════════
// 子任务插件的测试台：真的会话管理与会话设置（startSettings）装上子任务插件；工具服务的替身记下登记的工具（含风险与确认的
// 声明），按名字调处理器；zz-agent 是声明 SCHEMA 那几项的 agent 替身（模型一项的全局层是本插件偏好），agent 服务的替身实现
// assignModel：与 agent 同一做法，经 zz-agent 的读取器写本会话层，可让它抛错；clearing 直接跑清理（会话管理删子会话时经它清
// 数据），没有回合要停。记下派发与追问的入站消息，派发那一刻读一次子会话
// 的设置。回合按 agent 的顺序在 agent:turn:before 的 next 里跑完、发 agent:turn:after。网关的替身收下追问，等用例让它落定：
// 跑完追问开的那一轮（在送达它的那次调用的异步上下文里跑，与 agent 一样），或不开轮就落定（在网关相位被挡下、被放掉）。
// ════════════════════════════════════════════════════════════

type Handler = RegisteredTool['handler'];
type Outcome = HookContextMap['agent:turn:after']['outcome'];

export interface SubtaskHubOptions {
  doc?: Partial<AalisConfig>;
  /** 子任务插件的配置（写进文档） */
  config?: Record<string, unknown>;
  /** 不装会话设置 */
  withoutSettings?: boolean;
  /** 不装 agent 服务的替身 */
  withoutAgent?: boolean;
  /** assignModel 抛错 */
  assignFails?: boolean;
  plugins?: PluginDefinition[];
  stored?: Record<string, Record<string, unknown>>;
}

export async function startSubtaskHub(opts: SubtaskHubOptions = {}) {
  const registered = new Map<string, Omit<RegisteredTool, 'pluginName'>>();
  const toolsPlugin = definePlugin({
    name: 'zz-tools',
    provides: [tools],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(tools, {
        register(tool: Omit<RegisteredTool, 'pluginName'>) {
          registered.set(tool.definition.function.name, tool);
          return () => void registered.delete(tool.definition.function.name);
        },
        registerGroup: () => () => {},
      } as never);
    },
  });
  const agentFields = fieldsPlugin('zz-agent', SCHEMA);
  /** 依次记下 assign（指定模型）与 dispatch（派发），看先后 */
  const order: string[] = [];
  const agentPlugin = definePlugin({
    name: 'zz-agent-service',
    provides: [agent],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(agent, {
        async assignModel(sessionId: string, model: { provider: string; model: string }) {
          order.push(`assign ${sessionId}`);
          if (opts.assignFails) throw new Error('<写不进>');
          await agentFields.reader().set(sessionId, 'llm', model);
        },
        async clearing(_sessionIds: readonly string[] | undefined, clear: () => Promise<unknown>) {
          await clear();
        },
      } as never);
    },
  });
  /** 网关收下、还没落定的追问：用例交给它这一条怎么落定（跑一轮或直接落定） */
  const ingressed: Array<{ message: IncomingMessage; settle: (run: () => Promise<unknown>) => void }> = [];
  const gatewayPlugin = definePlugin({
    name: 'zz-gateway',
    provides: [gateway],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(gateway, {
        async ingressMessage(message: IncomingMessage) {
          record(message);
          const next = deferred<() => Promise<unknown>>();
          ingressed.push({ message, settle: next.resolve });
          await (await next.promise)();
        },
        dispatchOutbound: async () => {},
      });
    },
  });
  const started = await startSettings({
    doc: { ...opts.doc, plugins: { ...opts.doc?.plugins, [subtask.name]: opts.config ?? {} } },
    settings: !opts.withoutSettings,
    first: [toolsPlugin, gatewayPlugin],
    plugins: [...(opts.withoutAgent ? [] : [agentPlugin]), ...(opts.plugins ?? []), subtask],
    fields: opts.withoutSettings ? [] : [agentFields.definition],
    stored: opts.stored,
  });
  const host = started.app.bind({ hooks });
  /** 派发与追问的入站消息，各带派发那一刻读到的子会话设置 */
  const dispatched: Array<{ message: IncomingMessage; settings?: Record<string, unknown> }> = [];
  const record = (message: IncomingMessage) => {
    order.push(`dispatch ${message.sessionId}`);
    dispatched.push({
      message,
      settings: opts.withoutSettings ? undefined : { ...agentFields.reader().get(message.sessionId) },
    });
  };
  started.host.events.use.on('inbound:message', record);

  /** 在 ctx 里调一个工具，回原样的结果文本 */
  const raw = async (name: string, args: Record<string, unknown>, ctx: RequestDraft) => {
    const tool = registered.get(name);
    if (!tool) throw new Error(`工具 ${name} 未登记`);
    const out = await (tool.handler as Handler)(args, toolContext(ctx));
    return typeof out === 'string' ? out : out.content;
  };
  const call = async (name: string, args: Record<string, unknown>, ctx: RequestDraft) =>
    JSON.parse(await raw(name, args, ctx));

  let turns = 0;
  /**
   * 一个会话跑一轮：按 agent 的顺序，整轮在 agent:turn:before 的 next 里，结束时发 agent:turn:after。during 在这一轮结束前跑；
   * reply 是结局为 replied 时的回复。返回这一轮的默认动作有没有执行（被中间件拦下时为 false）
   */
  const turn = async (
    sessionId: string,
    outcome: Outcome = 'replied',
    {
      source = 'subtask',
      error,
      during,
      reply = '<结果>',
    }: { source?: string; error?: string; during?: () => Promise<unknown>; reply?: string } = {},
  ) => {
    const message = { content: '<任务>', sessionId, platform: 'webui', source };
    const turnId = `t${++turns}`;
    let ran = false;
    await host.hooks.use.run(
      'agent:turn:before',
      { turnId, sessionId: message.sessionId, inputs: [{ message }] },
      async () => {
        ran = true;
        await during?.();
        await host.hooks.use.run('agent:turn:after', {
          inputs: [{ message }],
          reply: outcome === 'replied' ? reply : '',
          outcome,
          ...(error === undefined ? {} : { error }),
          sessionId,
          turnId,
        });
      },
    );
    return ran;
  };

  /** 网关最早收下、还没落定的那条追问 */
  const pending = async () => {
    await vi.waitFor(() => expect(ingressed.length).toBeGreaterThan(0));
    return ingressed.shift() as (typeof ingressed)[number];
  };
  /** 最早那条追问开一轮（在送达它的那次调用里跑完），跑完它才落定；返回这一轮的默认动作有没有执行 */
  const followUp = async (
    outcome: Outcome = 'replied',
    options: { error?: string; during?: () => Promise<unknown> } = {},
  ) => {
    const { message, settle } = await pending();
    const ran = deferred<boolean>();
    settle(() => turn(message.sessionId, outcome, options).then(ran.resolve, ran.reject));
    return ran.promise;
  };
  /** 最早那条追问不开轮就落定（在网关相位被挡下或被放掉） */
  const dropFollowUp = async () => (await pending()).settle(async () => {});

  /** 父会话一次模型调用前插入的子任务提醒（没有时为 undefined） */
  const reminder = async (sessionId: string, dryRun = false) => {
    const messages: Message[] = [
      { role: 'system', content: '<人设>' },
      { role: 'user', content: '<提问>' },
    ];
    await host.hooks.use.run('agent:llm:before', {
      messages,
      tools: [],
      acceptsImages: false,
      sessionId,
      dryRun,
    });
    return messages.find(m => m.metadata?.injector === 'subtask/parent-status')?.content as string | undefined;
  };

  return {
    ...started,
    hooks: host.hooks,
    registered,
    agentFields,
    order,
    dispatched,
    raw,
    call,
    turn,
    followUp,
    dropFollowUp,
    reminder,
  };
}

export type SubtaskHub = Awaited<ReturnType<typeof startSubtaskHub>>;
