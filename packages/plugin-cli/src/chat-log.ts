// ════════════════════════════════════════════════════════════
// 终端的聊天区：一张条目表，每项是一段本地行（欢迎行、指路、输入回显、指令回复与系统消息、附件说明、审批结算行），或会话协议的
// 一个时间线条目。条目按 itemId 原地更新，新的接在后面；超过上限从最早的裁。本地行在追加时就排成行，时间线条目的行在重绘时由
// 条目算出。
// 段与行只由时间线条目算，与 WebUI 时间线同一份输入：相邻、turnId 相同的条目成一段；一段是还在跑的这一轮的最后一段时，末尾那一组
// 不收。回合条目不画、不进表，只用来认这一轮还在不在跑：单独记，表裁头时还在跑的一轮不会因为回合条目被裁掉就当成收了尾。本地行
// 不切段，按到达先后插在行与行之间，落在收起的一组内部时排到这一组之后
// ════════════════════════════════════════════════════════════

import { type Entry, type Row, rowsOf } from './fold.js';
import type { TimelineItem } from './session-view.js';

/** 聊天区最多留这么多项 */
const MAX_ENTRIES = 300;

type LogEntry = { lines: string[] } | { item: Entry };

/** 排好的一项：一段本地行，或一行（一个条目，或收起的一组） */
type Part = { lines: string[] } | { row: Row };

/** 有字的回复：未读按它计 */
const isReply = (item: Entry) => item.kind === 'agent-message' && item.text.trim() !== '';

/** 相邻、turnId 相同的条目成一段，逐段交出行；open 是还在跑的回合 */
function rowsIn(items: readonly Entry[], open: ReadonlySet<string>, taskRunning: (taskId: string) => boolean): Row[] {
  const runs: Array<{ turnId?: string; items: Entry[] }> = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (item.turnId !== undefined && last?.turnId === item.turnId) last.items.push(item);
    else runs.push({ turnId: item.turnId, items: [item] });
  }
  /** 每个回合的最后一段 */
  const lastOf = new Map(
    runs.flatMap((run, index): Array<[string, number]> => (run.turnId === undefined ? [] : [[run.turnId, index]])),
  );
  return runs.flatMap((run, index) =>
    rowsOf(
      run.items,
      run.turnId !== undefined && open.has(run.turnId) && lastOf.get(run.turnId) === index,
      taskRunning,
    ),
  );
}

export class ChatLog {
  private readonly entries: LogEntry[] = [];
  private readonly byId = new Map<string, { item: Entry }>();
  /** 还在跑的回合：回合条目还没带结局 */
  private readonly open = new Set<string>();

  /** 追加一段本地行 */
  append(lines: string[]): void {
    this.entries.push({ lines });
    this.trim();
  }

  /**
   * 条目按 itemId 原地更新、新的接在后面；回合条目只记这一轮还在不在跑。交回它是不是刚有了字的回复（未读按它计，同一项的更新
   * 不再计）
   */
  upsert(item: TimelineItem): boolean {
    if (item.kind === 'turn') {
      if (item.outcome === undefined) this.open.add(item.turnId);
      else this.open.delete(item.turnId);
      return false;
    }
    const entry = this.byId.get(item.itemId);
    const fresh = isReply(item) && !(entry && isReply(entry.item));
    if (entry) entry.item = item;
    else {
      const added = { item };
      this.entries.push(added);
      this.byId.set(item.itemId, added);
      this.trim();
    }
    return fresh;
  }

  /** 流式增量接在她的正文后面（聊天区只画她的正文）；交回它是不是刚有了字的回复 */
  delta(itemId: string, text: string): boolean {
    const entry = this.byId.get(itemId);
    if (entry?.item.kind !== 'agent-message') return false;
    const before = isReply(entry.item);
    entry.item = { ...entry.item, text: entry.item.text + text };
    return !before && isReply(entry.item);
  }

  /** 按到达先后排好的各项；taskRunning 是转到后台的调用的任务还在跑 */
  layout(taskRunning: (taskId: string) => boolean): Part[] {
    const position = new Map<string, number>();
    const items: Entry[] = [];
    const locals: Array<{ at: number; lines: string[] }> = [];
    this.entries.forEach((entry, at) => {
      if ('lines' in entry) locals.push({ at, lines: entry.lines });
      else {
        position.set(entry.item.itemId, at);
        items.push(entry.item);
      }
    });
    const parts: Part[] = [];
    let next = 0;
    for (const row of rowsIn(items, this.open, taskRunning)) {
      // 一行从它第一个条目到达的位置算：先到的本地行排在它前面，后到的（含落在收起的一组内部的）排在它后面
      const at = position.get(('group' in row ? row.group[0] : row.item).itemId) as number;
      for (; next < locals.length && locals[next].at < at; next++) parts.push({ lines: locals[next].lines });
      parts.push({ row });
    }
    for (; next < locals.length; next++) parts.push({ lines: locals[next].lines });
    return parts;
  }

  private trim(): void {
    for (const gone of this.entries.splice(0, this.entries.length - MAX_ENTRIES)) {
      if ('item' in gone) this.byId.delete(gone.item.itemId);
    }
  }
}
