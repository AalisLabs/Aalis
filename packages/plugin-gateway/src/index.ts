import { type AgentService, agent } from '@aalis/api-agent';
import type { GatewayService, InboundPhaseData } from '@aalis/api-gateway';
import { gateway, INBOUND_PHASE, INBOUND_PHASE_ORDER } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { type BoundOf, definePlugin, events, logger, optional, provide } from '@aalis/core';
import type { IncomingMessage, OutgoingMessage } from '@aalis/schema-message';

// ----- 入口 -----

// gateway 不强依赖 agent —— 没有 agent 时仍可处理出站、运行钩子链。
const uses = { events, hooks, logger, provide, agent: optional(agent) };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-gateway',
  displayName: '消息流网关',
  subsystem: 'core',
  provides: [gateway],
  uses,
  apply: runGateway,
});

function runGateway({ events, hooks, logger, provide, agent }: Caps): void {
  logger.info(`消息网关已启动 (入站相位: ${INBOUND_PHASE_ORDER.join(' → ')}, 出站: outbound:dispatch)`);

  /** 调用 agent 处理消息；agent 不可用时给出兜底回复。 */
  async function defaultDispatch(message: IncomingMessage, agentService: AgentService | undefined): Promise<void> {
    if (agentService) {
      await agentService.handleMessage(message);
      return;
    }
    logger.warn('Agent 服务不可用，消息将不会被处理');
    await dispatchOutbound({
      content: '[系统] Agent 服务不可用，请检查插件配置。',
      sessionId: message.sessionId,
      platform: message.platform,
      source: 'system',
    });
  }

  /**
   * 入站处理：按 INBOUND_PHASE_ORDER 顺序运行四个命名相位。
   *
   * 相位规则（hooks.run 返回 false 即被某 handler swallow，整个管道立即停止）：
   *   1. inbound:command  — plugin-commands 在此拦截命令；命中则不进入后续相位
   *   2. inbound:flow     — plugin-flow-control 在此做禁言/冷却/限速闸门
   *   3. inbound:trigger  — plugin-trigger-policy 在此判定是否触发 agent
   *   4. inbound:dispatch — 默认动作：调用 agent.handleMessage（plugin-gateway 提供）
   *
   * 任一中前三相位被 swallow 即视为"消息已被中间件处理"，不进入 dispatch。
   */
  async function processInbound(message: IncomingMessage): Promise<void> {
    // 每条消息重新取当前胜者：agent 换人后下一条消息即跟上
    const data: InboundPhaseData = { message, metadata: {}, agent: agent.current };

    try {
      // 前置相位 = INBOUND_PHASE_ORDER 中除终相 DISPATCH 外的全部（单一真相：新增相位只改 gateway-api）。
      // 任一相位被 swallow 即停止后续调度（confirm 在最前，拦截会话内确认回复）。
      const preDispatch = INBOUND_PHASE_ORDER.filter(p => p !== INBOUND_PHASE.DISPATCH);
      for (const phase of preDispatch) {
        const t0 = performance.now();
        const reachedEnd = await hooks.run(phase, data);
        events.emit('gateway:phase:done', {
          phase,
          reachedEnd,
          durationMs: performance.now() - t0,
          sessionId: message.sessionId,
          platform: message.platform,
        });
        if (!reachedEnd) {
          logger.debug(
            `[${phase}] 消息被 swallow，未触达 agent: session=${message.sessionId} platform=${message.platform} source=${message.source ?? 'platform'}`,
          );
          return;
        }
      }

      // 终相：dispatch —— 默认动作为调用 agent
      const t0 = performance.now();
      const reachedEnd = await hooks.run(INBOUND_PHASE.DISPATCH, data, async () => {
        await defaultDispatch(data.message, data.agent);
      });
      events.emit('gateway:phase:done', {
        phase: INBOUND_PHASE.DISPATCH,
        reachedEnd,
        durationMs: performance.now() - t0,
        sessionId: message.sessionId,
        platform: message.platform,
      });
    } catch (err) {
      logger.warn(`入站处理异常: ${err}`);
    }
  }

  /** 出站派发：运行 `outbound:dispatch` 钩子链，默认动作为 emit 到 outbound:message。 */
  async function dispatchOutbound(message: OutgoingMessage): Promise<void> {
    const data = { message, metadata: {} as Record<string, unknown> };
    try {
      await hooks.run('outbound:dispatch', data, async () => {
        await events.emit('outbound:message', data.message);
      });
    } catch (err) {
      logger.warn(`outbound:dispatch 处理异常: ${err}`);
    }
  }

  // 入站入口：core 不做默认路由，消息全部由这里消费；退订随这次激活撤回。
  events.on('inbound:message', msg => {
    void processInbound(msg);
  });

  const service: GatewayService = {
    async ingressMessage(message) {
      // 直接走内部处理路径，避免事件总线递归带来的歧义。
      await processInbound(message);
    },
    async dispatchOutbound(message) {
      await dispatchOutbound(message);
    },
  };

  provide(gateway, service);
}
