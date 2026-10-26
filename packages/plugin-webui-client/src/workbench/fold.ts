import { tr } from '../language';
import type { SessionItem } from '../protocol/session-client';
import { t } from '../texts';
import type { TimelineItem } from './live-session';

// 时间线收起工具调用的规则（见 Timeline.tsx 头注），不带 React 与样式。终端用的是同一份（plugin-cli 的 src/fold.ts，按那个包的
// MIT 发布），两份由 test/architecture/tool-call-fold-parity.test.ts 钉住

type Item<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;
type ToolCallItem = Item<'tool-call'>;
type Display = NonNullable<ToolCallItem['display']>;
export type Process = ToolCallItem | Item<'reasoning'>;
/** 一段里的条目：回合条目不在段里 */
type Entry = Exclude<TimelineItem, Item<'turn'>>;

/** 一段里的一项：一个条目，或收成一行的一组工具调用与夹着的思考 */
type Row = { item: Entry } | { group: Process[] };

/** 连续这么多个工具调用收成一行 */
const COLLAPSE_FROM = 3;

/** 认得的展示：种类按加法扩展，服务端比客户端新时会发来认不出的种类，当没声明 */
export function displayOf({ display }: ToolCallItem): Display | undefined {
  return display?.kind === 'command' || display?.kind === 'file-change' ? display : undefined;
}

/** 等 owner 批准：收起会把审批卡藏起来 */
export const awaitingApproval = (item: ToolCallItem) => item.approvalId !== undefined && item.settlement === undefined;

/** 收起会藏掉要看的东西；taskRunning 是转到后台的调用的任务还在跑 */
const holding = (call: ToolCallItem, taskRunning: (taskId: string) => boolean) =>
  awaitingApproval(call) ||
  call.status === 'failed' ||
  call.status === 'generating' ||
  call.status === 'running' ||
  (call.taskId !== undefined && taskRunning(call.taskId));

export function rowsOf(items: readonly Entry[], live: boolean, taskRunning: (taskId: string) => boolean): Row[] {
  const rows: Row[] = [];
  let run: Process[] = [];
  const flush = (atEnd: boolean) => {
    const calls = run.filter(item => item.kind === 'tool-call');
    const held = calls.some(call => holding(call, taskRunning));
    if (calls.length >= COLLAPSE_FROM && !held && !(live && atEnd)) rows.push({ group: run });
    else rows.push(...run.map(item => ({ item })));
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'tool-call' || item.kind === 'reasoning') run.push(item);
    else {
      flush(false);
      rows.push({ item });
    }
  }
  flush(true);
  return rows;
}

const KIND_COUNTS = {
  command: 'callKindCommand',
  'file-change': 'callKindFileChange',
  generic: 'callKindOther',
} as const;
export const kindOf = (call: ToolCallItem) => displayOf(call)?.kind ?? 'generic';

export function groupSummary(calls: readonly ToolCallItem[]): string {
  const counts = new Map<keyof typeof KIND_COUNTS, number>();
  for (const call of calls) counts.set(kindOf(call), (counts.get(kindOf(call)) ?? 0) + 1);
  const count = calls.length;
  if (counts.size > 1) {
    return tr('callsMixed', { count, kinds: [...counts].map(([kind, n]) => t(KIND_COUNTS[kind], { count: n })) });
  }
  const [kind] = counts.keys();
  if (kind === 'command') return tr('callsCommands', { count });
  if (kind === 'file-change') return tr('callsFileChanges', { count });
  return tr('callsTools', { count });
}
