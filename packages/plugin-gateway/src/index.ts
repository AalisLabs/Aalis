import type { Context, IncomingMessage, OutgoingMessage } from '@aalis/core';
import type { AgentService } from '@aalis/plugin-agent-api';
import type { InboundPhaseData } from '@aalis/plugin-gateway-api';
import type { GatewayService } from '@aalis/plugin-gateway-api';
import type {} from '@aalis/plugin-agent-default';
import { INBOUND_PHASE, INBOUND_PHASE_ORDER } from '@aalis/plugin-gateway-api';

// ----- 元数据 -----

export const name = '@aalis/plugin-gateway';
export const displayName = '消息流网关';
export const provides = ['gateway'];

// gateway 不强依赖 agent —— 没有 agent 时仍可处理出站、运行钩子链。
export const inject = {
  optional: ['agent'],
};

// ----- 入口 -----

export function apply(ctx: Context): void {
  const logger = ctx.logger.child('gateway');
  logger.info(
    `消息网关已启动 (入站相位: ${INBOUND_PHASE_ORDER.join(' → ')}, 出站: outbound:dispatch)`,
  );

  /** 调用 agent 处理消息；agent 不可用时给出兜底回复（沿用旧 core 行为）。 */
  async function defaultDispatch(message: IncomingMessage, agent: AgentService | undefined): Promise<void> {
    if (agent) {
      await agent.handleMessage(message);
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
    const agent = ctx.getService<AgentService>('agent');
    const data: InboundPhaseData = { message, metadata: {}, agent };

    try {
      // 前三相位：任一相位被 swallow 即停止后续调度
      for (const phase of [INBOUND_PHASE.COMMAND, INBOUND_PHASE.FLOW, INBOUND_PHASE.TRIGGER] as const) {
        const t0 = performance.now();
        const reachedEnd = await ctx.hooks.run(phase, data);
        ctx.emit('gateway:phase:done', { phase, reachedEnd, durationMs: performance.now() - t0, sessionId: message.sessionId, platform: message.platform });
        if (!reachedEnd) {
          logger.debug(
            `[${phase}] 消息被 swallow，未触达 agent: session=${message.sessionId} platform=${message.platform} source=${message.source ?? 'platform'}`,
          );
          return;
        }
      }

      // 第四相位：dispatch —— 默认动作为调用 agent
      const t0 = performance.now();
      const reachedEnd = await ctx.hooks.run(INBOUND_PHASE.DISPATCH, data, async () => {
        await defaultDispatch(data.message, data.agent);
      });
      ctx.emit('gateway:phase:done', { phase: INBOUND_PHASE.DISPATCH, reachedEnd, durationMs: performance.now() - t0, sessionId: message.sessionId, platform: message.platform });
    } catch (err) {
      logger.warn(`入站处理异常: ${err}`);
    }
  }

  /** 出站派发：运行 `outbound:dispatch` 钩子链，默认动作为 emit 到 outbound:message。 */
  async function dispatchOutbound(message: OutgoingMessage): Promise<void> {
    const data = { message, metadata: {} as Record<string, unknown> };
    try {
      await ctx.hooks.run('outbound:dispatch', data, async () => {
        await ctx.emit('outbound:message', data.message);
      });
    } catch (err) {
      logger.warn(`outbound:dispatch 处理异常: ${err}`);
    }
  }

  // 监听 inbound:message —— 替代 core/app.ts 中已被移除的默认路由。
  // ctx.on 返回的 dispose 已自动挂到子上下文的 disposables，插件卸载时会清理。
  ctx.on('inbound:message', (msg) => {
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

  ctx.provide('gateway', service);
}
