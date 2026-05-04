import type {
  Context,
  IncomingMessage,
  OutgoingMessage,
  AgentService,
  GatewayService,
} from '@aalis/core';

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
  logger.info('消息网关已启动 (gateway:inbound / gateway:outbound 钩子链就绪)');

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

  /** 入站处理：运行 `gateway:inbound` 钩子链，默认动作为调用 agent。 */
  async function processInbound(message: IncomingMessage): Promise<void> {
    const agent = ctx.getService<AgentService>('agent');
    const data = { message, metadata: {} as Record<string, unknown>, agent };
    let reachedDefault = false;
    try {
      await ctx.hooks.run('gateway:inbound', data, async () => {
        reachedDefault = true;
        await defaultDispatch(data.message, data.agent);
      });
      // 中间件链未走到默认动作 → 被某一环 swallow（命令命中 / 流控吞掉 / 触发策略未达阈值）
      if (!reachedDefault) {
        logger.debug(
          `[gateway:inbound] 消息未触达 agent (被中间件 swallow): session=${message.sessionId} platform=${message.platform} source=${message.source ?? 'platform'}`,
        );
      }
    } catch (err) {
      logger.warn(`gateway:inbound 处理异常: ${err}`);
    }
  }

  /** 出站派发：运行 `gateway:outbound` 钩子链，默认动作为 emit 到 outbound:message。 */
  async function dispatchOutbound(message: OutgoingMessage): Promise<void> {
    const data = { message, metadata: {} as Record<string, unknown> };
    try {
      await ctx.hooks.run('gateway:outbound', data, async () => {
        await ctx.emit('outbound:message', data.message);
      });
    } catch (err) {
      logger.warn(`gateway:outbound 处理异常: ${err}`);
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
