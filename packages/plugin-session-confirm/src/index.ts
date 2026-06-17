// ----- 会话内统一确认：onebot/cli 等「仅消息总线」平台的确认传输 -----
//
// 确认「协议」（Y/YS 解析 + 提示文案）由 authority-api 的纯函数 parseConfirmReply / composeConfirmPrompt
// 共享，保证所有平台一致；本插件只负责这类平台特定的两件事（与 api 的契约分离）：
//   - 投递：经 gateway 总线 dispatchOutbound 发提示；
//   - 拦截点：最前置的 inbound:confirm 相位，命中未决确认即吞掉回复，绝不触达 agent.handleMessage
//     （否则会 abort 正在等待确认的在途生成）。
//
// WebUI 自带 WS 传输（流式友好），用同一组协议纯函数但在 WS-onmessage 拦截，故不在此处。
// 注册 '*' 通配 handler：精确平台 handler（如 webui）优先，其余会话型平台落到这里。

import type { Context } from '@aalis/core';
import type { AccessConfirmHandler, AccessDecision, AuthorityService } from '@aalis/plugin-authority-api';
import { composeConfirmPrompt, parseConfirmReply } from '@aalis/plugin-authority-api';
import type { GatewayService } from '@aalis/plugin-gateway-api';
import { INBOUND_PHASE } from '@aalis/plugin-gateway-api';

export const name = '@aalis/plugin-session-confirm';
export const displayName = '会话确认';
export const subsystem = 'authority';
export const inject = {
  required: ['gateway'],
  optional: ['authority'],
};

const CONFIRM_TIMEOUT_MS = 60_000;
const SESSION_GRANT_SECONDS = 600;

export async function apply(ctx: Context): Promise<void> {
  /** 每个 session 至多一个未决确认（确认是会话内串行的一问一答）。 */
  const pending = new Map<
    string,
    { resolve: (v: boolean | AccessDecision) => void; timer: ReturnType<typeof setTimeout>; always: boolean }
  >();

  const send = (sessionId: string, platform: string, text: string): void => {
    const gateway = ctx.getService<GatewayService>('gateway');
    void gateway?.dispatchOutbound({ content: text, sessionId, platform, source: 'system' });
  };

  const handler: AccessConfirmHandler = request =>
    new Promise<boolean | AccessDecision>(resolve => {
      const stale = pending.get(request.sessionId);
      if (stale) {
        clearTimeout(stale.timer);
        pending.delete(request.sessionId);
        stale.resolve(false);
      }
      const always = request.confirm === 'always';
      const timer = setTimeout(() => {
        pending.delete(request.sessionId);
        send(request.sessionId, request.platform, '⏰ 操作确认已超时，已自动取消。');
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);
      pending.set(request.sessionId, { resolve, timer, always });
      send(request.sessionId, request.platform, composeConfirmPrompt(request, always, SESSION_GRANT_SECONDS));
    });

  ctx.whenService<AuthorityService>('authority', authority => {
    if (authority.setConfirmHandler) {
      authority.setConfirmHandler('*', handler);
      ctx.logger.debug('会话确认 fallback handler 已注册 (*)');
    }
  });

  // inbound:confirm 相位（最前）：命中未决确认即解析并吞掉，避免触达 agent（防 abort 在途生成）。
  ctx.middleware(INBOUND_PHASE.CONFIRM, async (data, next) => {
    const p = pending.get(data.message.sessionId);
    if (!p) return next();
    clearTimeout(p.timer);
    pending.delete(data.message.sessionId);
    p.resolve(parseConfirmReply(data.message.content ?? '', p.always, SESSION_GRANT_SECONDS));
    return; // swallow —— 该回复已被确认流程消费，不作为新消息处理
  });
}
