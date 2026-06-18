// ----- 会话确认：协调器实现 + onebot/cli 等「仅消息总线」平台的确认传输 -----
//
// 协调器（待确认登记 / 超时 / 解析 Y-YS / 文案）是平台无关的功能，**实现一份**于此，经
// `session-confirm` 服务（契约在 plugin-session-confirm-api）暴露 createChannel，供任何平台复用：
//   - 本插件自用：bus 通道（投递走 gateway 总线）+ '*' fallback handler + inbound:confirm 相位拦截，
//     覆盖 onebot/cli 等仅靠消息总线的会话型平台。
//   - WebUI：注入自己的 WS 投递拿一条通道，保留 WS type:'confirm'（前端「确认模式」信号），在
//     WS-onmessage 调 feed —— 与本插件共用同一协调器实现，零重复。
//
// 纯协议（parseConfirmReply / composeConfirmPrompt）是无状态契约，留在 authority-api。

import type { Context } from '@aalis/core';
import type {
  AccessConfirmHandler,
  AccessDecision,
  AccessRequest,
  AuthorityService,
} from '@aalis/plugin-authority-api';
import { composeConfirmPrompt, parseConfirmReply } from '@aalis/plugin-authority-api';
import type { GatewayService } from '@aalis/plugin-gateway-api';
import { INBOUND_PHASE } from '@aalis/plugin-gateway-api';
import type { ConfirmChannel, SessionConfirmService } from '@aalis/plugin-session-confirm-api';

export const name = '@aalis/plugin-session-confirm';
export const displayName = '会话确认';
export const subsystem = 'authority';
export const provides = ['session-confirm'];
export const inject = {
  required: ['gateway'],
  optional: ['authority'],
};

/** 确认等待超时（毫秒）；超时默认拒（无人在场即安全失败）。 */
const CONFIRM_TIMEOUT_MS = 60_000;
/** YS（本会话放行）授予时长（秒）。 */
const SESSION_GRANT_SECONDS = 600;

/** 协调器工厂（平台无关）：注入投递，拿回 { handler, feed }。 */
function createChannel(deliver: (request: AccessRequest, text: string) => void): ConfirmChannel {
  /** 每个 session 至多一个未决确认（确认是会话内串行的一问一答）。 */
  const pending = new Map<
    string,
    {
      resolve: (v: boolean | AccessDecision) => void;
      timer: ReturnType<typeof setTimeout>;
      always: boolean;
      /** 发起确认的触发者 userId；仅本人能应答（防群里第三方抢答）。 */
      userId?: string;
    }
  >();

  const handler: AccessConfirmHandler = request =>
    new Promise<boolean | AccessDecision>(resolve => {
      // 同 session 旧未决先取消（清 timer + resolve false），防覆盖致旧 Promise 永挂 / 旧 timer 误删新条目。
      const stale = pending.get(request.sessionId);
      if (stale) {
        clearTimeout(stale.timer);
        pending.delete(request.sessionId);
        stale.resolve(false);
      }
      const always = request.confirm === 'always';
      const timer = setTimeout(() => {
        pending.delete(request.sessionId);
        deliver(request, '⏰ 操作确认已超时，已自动取消。');
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);
      pending.set(request.sessionId, { resolve, timer, always, userId: request.userId });
      deliver(request, composeConfirmPrompt(request, always, SESSION_GRANT_SECONDS));
    });

  const feed = (sessionId: string, replyText: string, replyUserId?: string): boolean => {
    const p = pending.get(sessionId);
    if (!p) return false;
    // 仅触发者本人能应答：群里 sessionId=群，否则任意成员都能替授权方确认（评审 C1）。
    // 私聊/webui 触发者与应答者天然同人；二者皆 undefined 也视为同人（系统注入等无 userId 场景）。
    if (p.userId !== replyUserId) return false;
    clearTimeout(p.timer);
    pending.delete(sessionId);
    p.resolve(parseConfirmReply(replyText, p.always, SESSION_GRANT_SECONDS));
    return true;
  };

  return { handler, feed };
}

export async function apply(ctx: Context): Promise<void> {
  const service: SessionConfirmService = { createChannel };
  ctx.provide('session-confirm', service);

  // 自用 bus 通道：覆盖 onebot/cli 等仅靠消息总线的会话型平台。
  const busChannel = createChannel((request, text) => {
    const gateway = ctx.getService<GatewayService>('gateway');
    void gateway?.dispatchOutbound({
      content: text,
      sessionId: request.sessionId,
      platform: request.platform,
      source: 'system',
    });
  });

  // authority 可能晚于本插件上线 → whenService 在其上线/重启时注册 '*' fallback（精确平台 handler 优先）。
  ctx.whenService<AuthorityService>('authority', authority => {
    if (authority.setConfirmHandler) {
      authority.setConfirmHandler('*', busChannel.handler);
      ctx.logger.debug('会话确认 fallback handler 已注册 (*)');
    }
  });

  // inbound:confirm 相位（最前）：命中未决确认即喂入解析并吞掉，避免触达 agent（防 abort 在途生成）。
  ctx.middleware(INBOUND_PHASE.CONFIRM, async (data, next) => {
    if (busChannel.feed(data.message.sessionId, data.message.content ?? '', data.message.userId)) return; // 吞掉确认回复
    return next();
  });
}
