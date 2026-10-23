import { type AgentService, agent } from '@aalis/api-agent';
import { authority } from '@aalis/api-authority';
import type { GatewayService, InboundPhase, InboundPhaseData } from '@aalis/api-gateway';
import { chatScopeOf, gateway, INBOUND_PHASE, INBOUND_PHASE_ORDER } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { i18n, localizeFor } from '@aalis/api-i18n';
import { getPlatformAdapters, platform, sessionTypesOf } from '@aalis/api-platform';
import { roomClass, sessionManager } from '@aalis/api-session-manager';
import { type BoundOf, definePlugin, events, logger, optional, provide } from '@aalis/core';
import { toSource } from '@aalis/schema-i18n';
import { arrivalTag, type IncomingMessage, type OutgoingMessage } from '@aalis/schema-message';
import { t } from './texts.js';

// ----- 入口 -----

// gateway 不强依赖 agent —— 没有 agent 时仍可处理出站、运行钩子链。
// 会话管理在场时入站相位之前先等它收录这条消息的会话；会话管理与 authority 还用来判房间类别（结构性放行），authority 缺席时
// 没有人是 owner。没有 source 的入站按这个平台适配器的类型声明算聊天窗口（data.chat），平台服务缺席时按没声明类型算。
// 出站消息带文字对象时按会话的语言渲染进 content；i18n 缺席或渲染抛错时按原文
const uses = {
  events,
  hooks,
  logger,
  provide,
  agent: optional(agent),
  sessionManager: optional(sessionManager),
  authority: optional(authority),
  i18n: optional(i18n),
  platform: optional(platform),
};
type Caps = BoundOf<typeof uses>;

/**
 * 结构性放行跳过的相位：受众只有 owner 的会话（房间类别 owner-only）没有「要不要开口」的问题，也没有刷屏要限，
 * 指令相位之后直接派发
 */
const OWNER_ONLY_SKIPPED: ReadonlySet<InboundPhase> = new Set([INBOUND_PHASE.TRIGGER, INBOUND_PHASE.FLOW]);

export default definePlugin({
  name: '@aalis/plugin-gateway',
  displayName: t('displayName'),
  subsystem: 'core',
  provides: [gateway],
  uses,
  apply: runGateway,
});

function runGateway({ events, hooks, logger, provide, agent, sessionManager, authority, i18n, platform }: Caps): void {
  logger.use.info(`消息网关已启动 (入站相位: ${INBOUND_PHASE_ORDER.join(' → ')}, 出站: outbound:dispatch)`);

  /** 会话的房间类别是不是 owner-only（子会话取根会话的）；会话管理缺席时判不出，按否 */
  function isOwnerOnly(sessionId: string): boolean {
    const lookup = (id: string) => (sessionManager.present ? sessionManager.use.getSession(id) : undefined);
    return (
      roomClass(lookup(sessionId), lookup, (p, u) => authority.present && authority.use.isOwner(p, u)) === 'owner-only'
    );
  }

  /** 入站所在的聊天窗口：带 source 的内部注入没有 */
  function chatOf(message: IncomingMessage): InboundPhaseData['chat'] {
    if (message.source) return undefined;
    const adapter = getPlatformAdapters(platform).find(a => a.platform === message.platform);
    return chatScopeOf(message, sessionTypesOf(adapter));
  }

  /** 到达序号：每条入站在所有相位之前加一（只给日志关联，重载后从头计） */
  let arrivals = 0;

  /** 调用 agent 处理消息；agent 不可用时给出兜底回复。 */
  async function defaultDispatch(message: IncomingMessage, agentService: AgentService | undefined): Promise<void> {
    if (agentService) {
      await agentService.handleMessage(message);
      return;
    }
    logger.use.warn('Agent 服务不可用，消息将不会被处理');
    const text = t('agentUnavailable');
    await dispatchOutbound({
      content: toSource(text),
      text,
      sessionId: message.sessionId,
      platform: message.platform,
      source: 'system',
    });
  }

  /**
   * 入站处理：按 INBOUND_PHASE_ORDER 顺序运行四个命名相位。
   *
   * 相位规则（hooks.run 返回 false 即被某 handler swallow，整个管道立即停止）：
   *   1. inbound:command  — plugin-commands 在此拦截命令与意图确认的回复；命中则不进入后续相位
   *   2. inbound:trigger  — 生效的触发插件（trigger 服务胜者，如 plugin-trigger-policy）在此判定要不要开口
   *   3. inbound:flow     — plugin-flow-control 在此做禁言/冷却/限速闸门
   *   4. inbound:dispatch — 默认动作：调用 agent.handleMessage（plugin-gateway 提供）
   *
   * 前三相位任一被 swallow 即视为"消息已被中间件处理"，不进入 dispatch。
   * 房间类别为 owner-only 的会话跳过 trigger 与 flow（结构性放行），这两个相位不运行、不发 gateway:phase:done。
   * 会话管理在场时先等它收录（recordInbound）：新房间的第一条消息进入相位时会话已建档、带聊天窗口，各读取方按记下的字段取。
   * 没有 source 的入站带上聊天窗口（data.chat），回复策略据它判生效范围。所有相位之前先打到达序号（这次运行内递增），
   * 判定、吞噬、开轮与回合结束各行据它串起这一条
   */
  async function processInbound(message: IncomingMessage): Promise<void> {
    message.arrival = ++arrivals;
    // 每条消息重新取当前胜者：agent 换人后下一条消息即跟上
    const data: InboundPhaseData = {
      message,
      metadata: {},
      agent: agent.present ? agent.use : undefined,
      chat: chatOf(message),
    };

    try {
      if (sessionManager.present) await sessionManager.use.recordInbound(message);
      // 前置相位 = INBOUND_PHASE_ORDER 中除终相 DISPATCH 外的全部（单一真相：新增相位只改 gateway-api）。
      // 任一相位被 swallow 即停止后续调度。
      const preDispatch = INBOUND_PHASE_ORDER.filter(p => p !== INBOUND_PHASE.DISPATCH);
      // 房间类别到第一个可跳过的相位才判，只判一次（指令相位之后；会话在相位之前已收录）
      let ownerOnly: boolean | undefined;
      for (const phase of preDispatch) {
        if (OWNER_ONLY_SKIPPED.has(phase)) {
          ownerOnly ??= isOwnerOnly(data.message.sessionId);
          if (ownerOnly) continue;
        }
        const t0 = performance.now();
        const reachedEnd = await hooks.use.run(phase, data);
        events.use.emit('gateway:phase:done', {
          phase,
          reachedEnd,
          durationMs: performance.now() - t0,
          sessionId: message.sessionId,
          platform: message.platform,
        });
        if (!reachedEnd) {
          logger.use.debug(
            `[${phase}] 消息被 swallow${arrivalTag(message)}，未触达 agent: session=${message.sessionId} platform=${message.platform} source=${message.source ?? 'platform'}`,
          );
          return;
        }
      }

      // 终相：dispatch —— 默认动作为调用 agent
      const t0 = performance.now();
      const reachedEnd = await hooks.use.run(INBOUND_PHASE.DISPATCH, data, async () => {
        await defaultDispatch(data.message, data.agent);
      });
      events.use.emit('gateway:phase:done', {
        phase: INBOUND_PHASE.DISPATCH,
        reachedEnd,
        durationMs: performance.now() - t0,
        sessionId: message.sessionId,
        platform: message.platform,
      });
    } catch (err) {
      logger.use.warn(`入站处理异常: ${err}`);
    }
  }

  /** i18n 渲染出站文字抛错时告警过了：之后再出错不再告警 */
  let renderWarned = false;
  const onRenderError = (err: unknown) => {
    if (renderWarned) return;
    renderWarned = true;
    logger.use.warn('按会话的语言渲染出站消息出错，按原文发出（之后再出错不再告警）:', err);
  };

  /**
   * 出站派发：带文字对象的消息先按所在会话（{ sessionId, platform }）的语言把它渲染进 content（就地改写，发起方之后等的
   * delivery 写在同一个对象上；i18n 缺席或渲染抛错时按原文），再运行 `outbound:dispatch` 钩子链，默认动作为 emit 到
   * outbound:message。
   */
  async function dispatchOutbound(message: OutgoingMessage): Promise<void> {
    const data = { message, metadata: {} as Record<string, unknown> };
    try {
      if (message.text) {
        const reader = { sessionId: message.sessionId, platform: message.platform };
        message.content = localizeFor(i18n, message.text, reader, { onError: onRenderError });
      }
      await hooks.use.run('outbound:dispatch', data, async () => {
        await events.use.emit('outbound:message', data.message);
      });
    } catch (err) {
      logger.use.warn(`outbound:dispatch 处理异常: ${err}`);
    }
  }

  // 入站入口：core 不做默认路由，消息全部由这里消费；退订随这次激活撤回。
  events.use.on('inbound:message', msg => {
    void processInbound(msg);
  });

  const service: GatewayService = {
    async ingressMessage(message) {
      // 直接走内部处理路径，避免事件总线递归带来的歧义；这条输入落定（所在的一轮结束、被放掉或在相位里被挡下）时返回
      await processInbound(message);
    },
    async dispatchOutbound(message) {
      await dispatchOutbound(message);
    },
  };

  provide.use(gateway, service);
}
