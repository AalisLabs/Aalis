// ============================================================
// sent-messages.ts — 机器人自身近期发出消息的记录
//
// 支撑「撤回自己发的消息」：sendMessage 时记录每条发出消息的 message_id，
// 工具层据此撤回（delete_msg）。QQ 通常只允许撤回 ~2 分钟内的消息，故只需短时窗 + 每会话条数上限。
// 纯逻辑、now 由调用方注入，便于单测。
// ============================================================

interface SentMessageRecord {
  messageId: string;
  /** 记录时间（毫秒） */
  ts: number;
  /** 内容预览（去标签、截断），便于撤回时回显「撤回了哪条」 */
  preview: string;
}

/** 从 OneBot send_msg 响应中提取 message_id（缺失/空返回 ''） */
export function extractSentMessageId(data: unknown): string {
  if (data && typeof data === 'object') {
    const mid = (data as Record<string, unknown>).message_id;
    if (mid != null && mid !== '') return String(mid);
  }
  return '';
}

function toPreview(content: string): string {
  return content
    .replace(/<[^>]+>/g, '')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/**
 * 每会话维护一个「近期发出消息」环形缓冲。按会话隔离，超量按条数裁剪、整体按时窗过期。
 */
export class SentMessageTracker {
  private store = new Map<string, SentMessageRecord[]>();

  constructor(
    private readonly perSession = 20,
    private readonly retentionMs = 30 * 60 * 1000,
  ) {}

  /** 记录一条刚发出的消息。messageId 为空则忽略。 */
  record(sessionId: string, messageId: string, content: string, now: number): void {
    if (!messageId) return;
    let list = this.store.get(sessionId);
    if (!list) {
      list = [];
      this.store.set(sessionId, list);
    }
    list.push({ messageId, ts: now, preview: toPreview(content) });
    if (list.length > this.perSession) list.splice(0, list.length - this.perSession);
    this.prune(now);
  }

  /** 返回该会话最近 limit 条（新→旧，过期项剔除）。 */
  recent(sessionId: string, limit: number, now: number): SentMessageRecord[] {
    const list = (this.store.get(sessionId) ?? []).filter(e => now - e.ts <= this.retentionMs);
    return list.slice(-Math.max(1, limit)).reverse();
  }

  /** 撤回成功后移除一条，使「撤回最近一条」可重复地往前走。 */
  forget(sessionId: string, messageId: string): void {
    const list = this.store.get(sessionId);
    if (!list) return;
    const idx = list.findIndex(e => e.messageId === messageId);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.store.delete(sessionId);
  }

  /** 丢弃整体已过期（最新一条都超时）或空的会话，避免 Map 无限增长。 */
  private prune(now: number): void {
    for (const [sid, l] of this.store) {
      if (l.length === 0 || now - l[l.length - 1].ts > this.retentionMs) this.store.delete(sid);
    }
  }
}
