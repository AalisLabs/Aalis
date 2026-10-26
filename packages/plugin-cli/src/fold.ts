// ════════════════════════════════════════════════════════════
// 终端聊天区里工具调用的画法：收起的规则，与工具调用的一行。
// 收起规则与 plugin-webui-client 的 workbench/fold.ts 是同一份（同名），终端这份按本包的 MIT 发布，两份由
// test/architecture/tool-call-fold-parity.test.ts 钉住；收起是界面的取舍，不进会话协议。规则：一段里连续到 COLLAPSE_FROM 个的
// 工具调用（夹着的思考一起）收成一行，按展示种类计数；其中有等审批、失败或还在跑的（含转到后台、后台任务还在跑的），或者是还在
// 跑的这一轮最后一段末尾那一组，不收，免得藏掉要看的东西。
// 工具调用的一行前半写做了什么（同 WebUI 工具卡的那一行，来自参数的文字经审批契约的清洗；终端按行画，换行与制表符也写成转义），
// 后半写状态，完成的写用时（与 WebUI 工具卡同一写法）
// ════════════════════════════════════════════════════════════

import { clipForCard, sanitizeForCard } from '@aalis/api-approval';
import { normalizeLanguages, resolveSource, type TextRef } from '@aalis/schema-i18n';
import type { TimelineItem } from './session-view.js';
import { t } from './texts.js';

type Item<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>;
export type ToolCallItem = Item<'tool-call'>;
type Display = NonNullable<ToolCallItem['display']>;
type Process = ToolCallItem | Item<'reasoning'>;
/** 一段里的条目：回合条目不在段里 */
export type Entry = Exclude<TimelineItem, Item<'turn'>>;

/** 一段里的一项：一个条目，或收成一行的一组工具调用与夹着的思考 */
export type Row = { item: Entry } | { group: Process[] };

/** 连续这么多个工具调用收成一行 */
const COLLAPSE_FROM = 3;

/** 认得的展示：种类按加法扩展，会话服务比终端新时会发来认不出的种类，当没声明 */
function displayOf({ display }: ToolCallItem): Display | undefined {
  return display?.kind === 'command' || display?.kind === 'file-change' ? display : undefined;
}

/** 等 owner 批准 */
const awaitingApproval = (call: ToolCallItem) => call.approvalId !== undefined && call.settlement === undefined;

/** 收起会藏掉要看的东西；taskRunning 是转到后台的调用的任务还在跑 */
const holding = (call: ToolCallItem, taskRunning: (taskId: string) => boolean) =>
  awaitingApproval(call) ||
  call.status === 'failed' ||
  call.status === 'generating' ||
  call.status === 'running' ||
  (call.taskId !== undefined && taskRunning(call.taskId));

/** 一段的各行；live 是这一段是还在跑的这一轮的最后一段 */
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
const kindOf = (call: ToolCallItem) => displayOf(call)?.kind ?? 'generic';

/** 收起的一行：几个调用，各是什么种类 */
export function groupSummary(calls: readonly ToolCallItem[]): TextRef {
  const counts = new Map<keyof typeof KIND_COUNTS, number>();
  for (const call of calls) counts.set(kindOf(call), (counts.get(kindOf(call)) ?? 0) + 1);
  const count = calls.length;
  if (counts.size > 1) {
    return t('callsMixed', { count, kinds: [...counts].map(([kind, n]) => t(KIND_COUNTS[kind], { count: n })) });
  }
  const [kind] = counts.keys();
  if (kind === 'command') return t('callsCommands', { count });
  if (kind === 'file-change') return t('callsFileChanges', { count });
  return t('callsTools', { count });
}

/** 一行里命令最多显示这么多个字 */
const SUMMARY_LIMIT = 60;

/** 写到十分之一秒的数字格式，按语言 */
const tenths = new Map<string, Intl.NumberFormat>();

/** 用时：一分钟以内写到十分之一秒，数字按聊天区实际用的语言写，同 WebUI */
function durationOf(ms: number, language: string): TextRef {
  if (ms < 60_000) {
    let format = tenths.get(language);
    if (!format) {
      format = new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      tenths.set(language, format);
    }
    return t('durationSeconds', { seconds: format.format(ms / 1000) });
  }
  const seconds = Math.round(ms / 1000);
  return t('durationMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

/** 一行里的文字：审批契约的清洗保留换行与制表符，终端的一行装不下它们，同样写成 `\x0A` 的样子 */
const inline = (text: string) => text.replace(/[\n\t]/g, char => (char === '\n' ? '\\x0A' : '\\x09'));

/** 工具调用的状态：等审批的与失败的要醒目；完成的写用时，转到后台、任务还在跑的写明（这一组因此不收） */
function statusOf(
  call: ToolCallItem,
  taskRunning: (taskId: string) => boolean,
  language: string,
): { text: TextRef; tone?: 'attention' | 'danger' } | undefined {
  if (awaitingApproval(call)) return { text: t('waitingApproval'), tone: 'attention' };
  switch (call.status) {
    case 'generating':
      return { text: t('generating') };
    case 'running':
      return { text: t('running') };
    case 'failed': {
      const display = displayOf(call);
      const code = display?.kind === 'command' ? display.exitCode : undefined;
      return { text: code ? t('exitCode', { code }) : t('failed'), tone: 'danger' };
    }
    case 'aborted':
      return { text: t('stopped') };
    case 'denied':
      return { text: t('denied') };
    case 'completed':
      if (call.taskId !== undefined && taskRunning(call.taskId)) return { text: t('backgroundRunning') };
      return call.durationMs === undefined ? undefined : { text: durationOf(call.durationMs, language) };
  }
}

/**
 * 聊天区实际用的语言：字典键 language 渲染出的译文，即本插件的字典此刻选中的那种（同 WebUI 的 pageLanguage）；用时里的数字按它写，
 * 与句子里的同类参数一致。译文不是合法的语言标签时按原文的语言
 */
export const languageOf = (render: (text: TextRef) => string): string =>
  normalizeLanguages([render(t('language'))])[0] ?? resolveSource(t('language'));

/** 工具调用的一行：做了什么（执行的命令、改的文件或工具名）与状态；language 是聊天区实际用的语言（{@link languageOf}） */
export function toolLine(call: ToolCallItem, taskRunning: (taskId: string) => boolean, language: string) {
  const display = displayOf(call);
  let summary: TextRef;
  if (display?.kind === 'command') {
    const { head, omitted, tail } = clipForCard(display.command.split('\n')[0], SUMMARY_LIMIT);
    summary =
      omitted === 0
        ? t('toolRun', { command: inline(head) })
        : t('toolRunClipped', { head: inline(head), count: omitted, tail: inline(tail) });
  } else if (display?.kind === 'file-change') {
    const path = inline(sanitizeForCard(display.path));
    summary = display.removed === undefined ? t('toolWrite', { path }) : t('toolEdit', { path });
  } else summary = t('toolCall', { tool: inline(sanitizeForCard(call.name)) });
  return { summary, status: statusOf(call, taskRunning, language) };
}
