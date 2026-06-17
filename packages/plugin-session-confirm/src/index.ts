// ----- 会话内统一确认（轴 B 的交互通道）-----
//
// 把 authority 的高危确认请求（AccessRequest）经 gateway 总线送到任意「会话型」平台，
// 再用最前置的 inbound:confirm 相位拦截用户的 Y/YS 回复并带回结果。
//
// 为什么是独立插件而非塞进 gateway：确认拦截是「相位逻辑」，与 commands/flow/trigger 同类——
// gateway 只提供管线与 hook 点，相位逻辑由参与者插件占据。
//
// 为什么注册 '*' 通配 handler：精确平台 handler（如 WebUI 的 WS 确认）优先；onebot/cli/任何
// 仅靠消息总线的会话型平台落到这里，一套实现覆盖全部，零散落。
//
// 并发要点：agent.handleMessage 会 abort 同 lane 的在途生成。若把「Y」当普通消息派发到
// dispatch，就会 abort 掉正在等待确认的那次生成。故本相位在 dispatch 之前**吞掉**确认回复，
// 使其永不触达 agent —— 确认得以正常回送。

import type { Context } from '@aalis/core';
import type {
  AccessConfirmHandler,
  AccessDecision,
  AccessRequest,
  AuthorityService,
} from '@aalis/plugin-authority-api';
import type { GatewayService } from '@aalis/plugin-gateway-api';
import { INBOUND_PHASE } from '@aalis/plugin-gateway-api';

export const name = '@aalis/plugin-session-confirm';
export const displayName = '会话确认';
export const subsystem = 'authority';
export const inject = {
  required: ['gateway'],
  optional: ['authority'],
};

/** 确认等待超时（毫秒）；超时默认拒（无人在场即安全失败）。 */
const CONFIRM_TIMEOUT_MS = 60_000;
/** YS（本会话放行）的授予时长（秒）。 */
const SESSION_GRANT_SECONDS = 600;

interface Pending {
  resolve: (v: AccessDecision | boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  /** confirm='always'：每次都问，不接受会话记忆。 */
  always: boolean;
}

export async function apply(ctx: Context): Promise<void> {
  /** 每个 session 至多一个待确认请求（确认是会话内串行的一问一答）。 */
  const pending = new Map<string, Pending>();

  const send = (sessionId: string, platform: string, content: string): void => {
    const gateway = ctx.getService<GatewayService>('gateway');
    void gateway?.dispatchOutbound({ content, sessionId, platform, source: 'system' });
  };

  const handler: AccessConfirmHandler = (request: AccessRequest) =>
    new Promise<AccessDecision | boolean>(resolve => {
      // 同 session 旧未决先取消（清 timer + resolve false），防新 set 覆盖致旧 Promise 永挂、
      // 旧 timer 误删新条目（竞态硬化，对齐 webui 既有做法）。
      const stale = pending.get(request.sessionId);
      if (stale) {
        clearTimeout(stale.timer);
        pending.delete(request.sessionId);
        stale.resolve(false);
      }

      const always = request.confirm === 'always';
      const typeLabel = request.type === 'command' ? '指令' : '工具';
      const nameStr = request.type === 'command' ? `/${request.name}` : request.name;
      const prompt = always
        ? `⚠️ ${typeLabel} ${nameStr} 是高危操作，每次都需确认。回复 Y 确认执行本次；其他任意输入取消。`
        : `⚠️ ${typeLabel} ${nameStr} 是高危操作。回复 Y 仅允许本次；回复 YS 本会话 ${SESSION_GRANT_SECONDS / 60} 分钟内放行；其他任意输入取消。`;

      const timer = setTimeout(() => {
        pending.delete(request.sessionId);
        send(request.sessionId, request.platform, '⏰ 操作确认已超时，已自动取消。');
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);

      pending.set(request.sessionId, { resolve, timer, always });
      send(request.sessionId, request.platform, prompt);
    });

  // authority 可能晚于本插件上线 → whenService 在其上线/重启时注册 '*' fallback。
  ctx.whenService<AuthorityService>('authority', authority => {
    if (authority.setConfirmHandler) {
      authority.setConfirmHandler('*', handler);
      ctx.logger.debug('会话确认 fallback handler 已注册 (*)');
    }
  });

  // inbound:confirm 相位（最前）：命中未决确认即解析 Y/YS/否并吞掉，绝不触达 agent（避免 abort 在途生成）。
  ctx.middleware(INBOUND_PHASE.CONFIRM, async (data, next) => {
    const p = pending.get(data.message.sessionId);
    if (!p) return next(); // 无未决确认 → 正常放行后续相位
    clearTimeout(p.timer);
    pending.delete(data.message.sessionId);
    const reply = (data.message.content ?? '').trim().toLowerCase();
    const yes = reply === 'y' || reply === 'yes';
    if (p.always) {
      // always：任意肯定只放行本次，不留会话记忆（authority 侧对 always 亦不建会话授予）。
      p.resolve(yes || reply === 'ys' ? { allowed: true } : false);
    } else if (reply === 'ys') {
      p.resolve({ allowed: true, grant: { scope: 'session', durationSeconds: SESSION_GRANT_SECONDS } });
    } else if (yes) {
      p.resolve({ allowed: true, grant: { scope: 'once' } });
    } else {
      p.resolve(false);
    }
    return; // swallow —— 该回复已被确认流程消费，不作为新消息处理
  });
}
