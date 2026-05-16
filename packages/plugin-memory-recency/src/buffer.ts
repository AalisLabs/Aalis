/**
 * 进程内"近期消息"环形缓冲区。
 *
 * 维护按 timestamp 升序的条目数组，超过 capacity 时从头部（最旧）淘汰。
 * 写入路径有两条：
 * - 实时：监听 inbound:message:archived / outbound:message 事件追加（一般 ts 单调递增）
 * - 预热：启动时从 memory.getHistory 拉历史塞入（ts 可能乱序，需要二分插入）
 */

export interface RecentEntry {
  /** 毫秒时间戳；缺失置为 0（会被排在最前面被优先淘汰） */
  timestamp: number;
  /** 平台标识（onebot / webui / cli / ...） */
  platform: string;
  /** 真实 sessionId */
  sessionId: string;
  role: 'user' | 'assistant';
  /** 已烘焙后的 content（可能已含 [昵称(ID)] 前缀，由 message-archive 决定） */
  content: string;
  senderName?: string;
  groupName?: string;
  groupId?: string;
}

export class RecencyBuffer {
  private buf: RecentEntry[] = [];
  /** 用于幂等：${sessionId}|${ts}|${role}|${content.length} */
  private seen = new Set<string>();

  constructor(private capacity: number) {}

  private keyOf(e: RecentEntry): string {
    return `${e.sessionId}|${e.timestamp}|${e.role}|${e.content.length}`;
  }

  /** 追加；同 key 视为重复，丢弃。返回是否真的写入。 */
  push(e: RecentEntry): boolean {
    const key = this.keyOf(e);
    if (this.seen.has(key)) return false;
    this.seen.add(key);

    if (this.buf.length === 0 || e.timestamp >= this.buf[this.buf.length - 1].timestamp) {
      this.buf.push(e);
    } else {
      let lo = 0;
      let hi = this.buf.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.buf[mid].timestamp <= e.timestamp) lo = mid + 1;
        else hi = mid;
      }
      this.buf.splice(lo, 0, e);
    }

    if (this.buf.length > this.capacity) {
      const removed = this.buf.splice(0, this.buf.length - this.capacity);
      for (const r of removed) this.seen.delete(this.keyOf(r));
    }
    return true;
  }

  /**
   * 按过滤器倒序取最近 N 条（结果按时间升序返回，方便阅读）。
   * sinceTs 为下界（含），命中第一条 < sinceTs 即停止扫描。
   */
  query(filter: (e: RecentEntry) => boolean, limit: number, sinceTs?: number): RecentEntry[] {
    if (limit <= 0) return [];
    const out: RecentEntry[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.buf[i];
      if (sinceTs !== undefined && e.timestamp < sinceTs) break;
      if (filter(e)) out.push(e);
    }
    return out.reverse();
  }

  size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf.length = 0;
    this.seen.clear();
  }

  /** 仅供测试：返回内部数组的浅拷贝 */
  snapshot(): RecentEntry[] {
    return [...this.buf];
  }
}
