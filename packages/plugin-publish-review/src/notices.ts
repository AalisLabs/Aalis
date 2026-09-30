import { AsyncLocalStorage } from 'node:async_hooks';
import type {} from '@aalis/api-agent';
import type { GatewayService } from '@aalis/api-gateway';
import type { HookContextMap, Hooks } from '@aalis/api-hooks';
import type { PublishOrigin } from '@aalis/api-publish';
import { wrapUntrustedContent } from '@aalis/api-tools';
import type { Events, Logger, ServiceRef } from '@aalis/core';
import { selfInitiatedActor } from '@aalis/schema-message';

/** 待发正文由 ReviewStore 持久化；确认到出站总线，不冒充平台送达回执。 */
export class ReviewNotices {
  #open = false;
  #closed = false;
  constructor(
    private readonly events: Events,
    private readonly logger: Logger,
    private readonly gateway: ServiceRef<GatewayService>,
    private readonly hooks: Hooks,
  ) {}
  open(): void {
    this.#open = true;
  }
  close(): void {
    this.#closed = true;
  }
  async enqueue(origin: PublishOrigin, content: string, id: string, title?: string): Promise<void> {
    if (!this.#open || this.#closed) throw new Error('作品通知尚未开放');
    if (!origin.notify) return;
    const gateway = this.gateway.current;
    if (!gateway) throw new Error('作品通知等待消息网关');
    const { sessionId, platform } = origin.notify;
    // 仅观察这次可等待调用内的出站：同房其他通知/真人回合不能代它确认。
    // 用异步调用归属而非消息对象引用，中间件复制或改写信封仍可识别。
    const scope = new AsyncLocalStorage<boolean>();
    let dispatched = false;
    let fallback = false;
    let outcome: HookContextMap['agent:turn:after']['outcome'] | undefined;
    const offOutbound = this.events.on('outbound:message', message => {
      if (
        scope.getStore() &&
        message.content.trim().length > 0 &&
        message.sessionId === sessionId &&
        (message.platform === undefined || message.platform === platform) &&
        message.hostNotice?.kind === 'publish-review' &&
        message.hostNotice.id === id &&
        (message.source === 'agent' || (fallback && message.source === 'system'))
      )
        dispatched = true;
    });
    const offTurn = this.hooks.middleware('agent:turn:after', async (data, next) => {
      if (scope.getStore() && data.sessionId === sessionId && data.message.source === `publish:${id}`) {
        outcome = data.outcome;
      }
      await next();
    });
    const offDispatch = this.hooks.middleware('outbound:dispatch', async (data, next) => {
      if (
        this.#closed &&
        scope.getStore() &&
        data.message.sessionId === sessionId &&
        data.message.hostNotice?.kind === 'publish-review' &&
        data.message.hostNotice.id === id
      )
        return;
      await next();
    });
    try {
      await scope.run(true, async () => {
        await gateway.ingressMessage({
          content,
          sessionId,
          platform,
          source: `publish:${id}`,
          actor: selfInitiatedActor(platform),
          hostNotice: {
            kind: 'publish-review',
            id,
            reportOnly: true,
            ...(title ? { untrusted: wrapUntrustedContent(title, '作品标题') } : {}),
          },
        });
        // 只兜底已走完整入站流程的静默回合，不绕过禁言、取消或停机。
        // 正文由宿主根据账本生成，绝不发送格式校验失败的模型原文。
        if (!dispatched && (outcome === 'silent' || outcome === 'error') && !this.#closed) {
          this.logger.warn(`作品 ${id} 的转述回合${outcome === 'silent' ? '静默' : '失败'}，改派发宿主结果通知`);
          fallback = true;
          await gateway.dispatchOutbound({
            content: `[作品通知] ${content}`,
            sessionId,
            platform,
            source: 'system',
            hostNotice: { kind: 'publish-review', id },
          });
        }
      });
      if (!dispatched) throw new Error('作品通知未进入出站总线');
    } catch (error) {
      // 已出站后后置观察者抛错不能让通知重发；平台投递失败由平台侧处理。
      if (dispatched) return;
      this.logger.warn(`作品 ${id} 的通知尚未派发，保留待发状态`);
      throw error;
    } finally {
      offTurn();
      offOutbound();
      offDispatch();
      scope.disable();
    }
  }
}
