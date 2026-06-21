// ----- 会话确认：协调器实现 + onebot/cli 等「仅消息总线」平台的确认传输 -----
//
// 协调器（待确认登记 / 超时 / 解析 Y-YS / 文案）是平台无关的功能，**实现一份**于此，经
// `session-confirm` 服务（契约在 plugin-session-confirm-api）暴露 createChannel，供任何平台复用：
//   - 本插件自用：bus 通道（投递走 gateway 总线）+ '*' fallback handler + inbound:confirm 相位拦截，
//     覆盖 onebot/cli 等仅靠消息总线的会话型平台。
//   - WebUI：注入自己的 WS 投递拿一条通道，保留 WS type:'confirm'（前端「确认模式」信号），在
//     WS-onmessage 调 feed —— 与本插件共用同一协调器实现，零重复。
//
// 纯协议（parseConfirmReply / composeConfirmPrompt）是本插件私有的无状态实现，内联于此——
// 契约包（authority-api）只放类型、不放实现（避免运行时跨包边 + 版本漂移）。

import type { Context } from '@aalis/core';
import type {
  AccessConfirmHandler,
  AccessDecision,
  AccessRequest,
  AuthorityService,
} from '@aalis/plugin-authority-api';
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

/** 把一条确认回复文本解析为决策（纯函数）：Y=本次、YS=本会话（always 不接受会话记忆）、其余=取消。 */
function parseConfirmReply(replyText: string, always: boolean, sessionGrantSeconds: number): boolean | AccessDecision {
  const t = replyText.trim().toLowerCase();
  const yes = t === 'y' || t === 'yes';
  if (always) return yes || t === 'ys' ? { allowed: true } : false;
  if (t === 'ys') return { allowed: true, grant: { scope: 'session', durationSeconds: sessionGrantSeconds } };
  if (yes) return { allowed: true, grant: { scope: 'once' } };
  return false;
}

/** 组合确认提示文案（纯函数，所有平台一致）。 */
function composeConfirmPrompt(request: AccessRequest, always: boolean, sessionGrantSeconds: number): string {
  const label = request.type === 'command' ? '指令' : '工具';
  const nameStr = request.type === 'command' ? `/${request.name}` : request.name;
  return always
    ? `⚠️ ${label} ${nameStr} 是高危操作，每次都需确认。回复 Y 确认执行本次；其他任意输入取消。`
    : `⚠️ ${label} ${nameStr} 是高危操作。回复 Y 仅允许本次；回复 YS 本会话 ${Math.round(sessionGrantSeconds / 60)} 分钟内放行；其他任意输入取消。`;
}

/** 协调器工厂（平台无关）：注入投递，拿回 { handler, feed }。 */
function createChannel(deliver: (request: AccessRequest, text: string) => void): ConfirmChannel {
  interface Waiter {
    request: AccessRequest;
    resolve: (v: boolean | AccessDecision) => void;
    timer: ReturnType<typeof setTimeout>;
    always: boolean;
    /** 发起确认的触发者 userId；仅本人能应答（防群里第三方抢答）。 */
    userId?: string;
  }
  // 每个 session 一条 FIFO 队列：确认是会话内一问一答，但同一回合并行工具可触发多个确认请求，
  // 必须串行排队（队首发提示、应答/超时后出队投递下一个），不能抢占式互相 resolve(false)。
  const queues = new Map<string, Waiter[]>();

  /** 给队首发确认提示并启动其超时计时（首次入队 / 上一个结算出队后调用）。 */
  const present = (sessionId: string): void => {
    const head = queues.get(sessionId)?.[0];
    if (!head) return;
    head.timer = setTimeout(() => {
      // 超时只结算队首：出队、投递、resolve，再推进下一个。
      const q = queues.get(sessionId);
      if (q?.[0]) q.shift();
      if (q && q.length === 0) queues.delete(sessionId);
      deliver(head.request, '⏰ 操作确认已超时，已自动取消。');
      head.resolve(false);
      present(sessionId);
    }, CONFIRM_TIMEOUT_MS);
    head.timer.unref?.(); // 待确认定时器不阻止进程优雅退出
    deliver(head.request, composeConfirmPrompt(head.request, head.always, SESSION_GRANT_SECONDS));
  };

  const handler: AccessConfirmHandler = request =>
    new Promise<boolean | AccessDecision>(resolve => {
      const waiter: Waiter = {
        request,
        resolve,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        always: request.confirm === 'always',
        userId: request.userId,
      };
      const q = queues.get(request.sessionId);
      if (q) {
        q.push(waiter); // 已有未决：排队，等队首结算后再发
      } else {
        queues.set(request.sessionId, [waiter]);
        present(request.sessionId); // 队首：立即发提示
      }
    });

  const feed = (sessionId: string, replyText: string, replyUserId?: string): boolean => {
    const q = queues.get(sessionId);
    const head = q?.[0];
    if (!q || !head) return false;
    // 仅触发者本人能应答：群里 sessionId=群，否则任意成员都能替授权方确认。
    // 私聊/webui 触发者与应答者天然同人；二者皆 undefined 也视为同人（系统注入等无 userId 场景）。
    if (head.userId !== replyUserId) return false;
    clearTimeout(head.timer);
    q.shift();
    if (q.length === 0) queues.delete(sessionId);
    head.resolve(parseConfirmReply(replyText, head.always, SESSION_GRANT_SECONDS));
    present(sessionId); // 推进下一个未决确认
    return true;
  };

  const dispose = (): void => {
    // 卸载/热重载：清所有未决确认的超时定时器并安全拒掉（resolve false），避免 Promise 永挂 + 定时器卡退出。
    for (const q of queues.values()) {
      for (const w of q) {
        clearTimeout(w.timer);
        w.resolve(false);
      }
    }
    queues.clear();
  };

  return { handler, feed, dispose };
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

  ctx.onDispose(() => busChannel.dispose());
}
