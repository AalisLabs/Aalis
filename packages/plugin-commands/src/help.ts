// ============================================================
// help.ts — 指令帮助的渲染（纯函数，便于单测）
//
// 两段式：概览回答「有哪些能用」，详情回答「这条怎么用」。哪些指令看得见由注册表按调用者的等级定。
//
// 输出是各平台通用的纯文本：QQ 与终端原样显示，WebUI 按 Markdown 渲染。所以只用两边读起来都对的写法——
// 一行一条的 `- ` 列表（取值缩进两格成子列表），段落之间空一行；不用加粗、反引号与代码围栏，也不用空格对列
// （比例字体下对不齐）。占位写成 `<名字>`，不带冒号：`<名字:类型>` 在 Markdown 里会被当成自动链接。
// ============================================================

import type { Command, OptionSpec, PositionalArgSpec } from '@aalis/api-commands';

/** 第一句的结束：句号、分号、问号、叹号或换行 */
const SENTENCE_END = /[。；！？\n]/;
/** 摘要的上限（按字计）：第一句过长时截断，免得一行撑满 */
const BRIEF_MAX = 24;

/** 摘要：约定描述的第一句就是摘要；第一句过长时截断，省略号紧跟文字 */
export function brief(description: string): string {
  const text = description.trim();
  const end = text.search(SENTENCE_END);
  const first = [...(end < 0 ? text : text.slice(0, end)).trimEnd()];
  if (first.length <= BRIEF_MAX) return first.join('');
  return `${first
    .slice(0, BRIEF_MAX)
    .join('')
    .replace(/[\s，,、：:·/\-—（(]+$/, '')}…`;
}

/** 列表里的一条指令：概览与详情的子指令共用 */
export interface Entry {
  cmd: Command;
  /** 调用者看得见的直接子指令数 */
  children: number;
}

const spelled = (name: string, prefix: string) => `${prefix}${name.replace(/\./g, ' ')}`;

/** `- /指令 — 摘要 · n 个子指令`；自动分组没有描述，只报子指令数 */
function entryLine({ cmd, children }: Entry, prefix: string): string {
  const notes = [cmd.isGroup ? '' : brief(cmd.description), children > 0 ? `${children} 个子指令` : ''].filter(Boolean);
  return `- ${spelled(cmd.name, prefix)}${notes.length > 0 ? ` — ${notes.join(' · ')}` : ''}`;
}

const argText = (arg: PositionalArgSpec) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`);

/** 一个选项一行，取值各占一行缩在下面 */
function optionLines(option: OptionSpec): string[] {
  const flags = new Set([`--${option.name}`, ...option.aliases.map(a => (a.length === 1 ? `-${a}` : `--${a}`))]);
  const placeholder = option.valueName ?? option.name;
  const value = option.type === 'boolean' ? '' : option.valueOptional ? ` [${placeholder}]` : ` <${placeholder}>`;
  return [
    `- ${[...flags].join(', ')}${value}${option.description ? `：${option.description}` : ''}`,
    ...(option.choices ?? []).map(c => `  - ${c.value}${c.description ? `：${c.description}` : ''}`),
  ];
}

/** 一段：标题加一行一条；没有条目时整段不出 */
const section = (title: string, lines: string[]) => (lines.length > 0 ? [title, ...lines].join('\n') : '');

export function renderOverview(entries: Entry[], prefix: string): string {
  return [
    `可用指令（${entries.length} 条）：`,
    ...entries.map(e => entryLine(e, prefix)),
    '',
    `详情：${prefix}help 指令名，或在指令后加 -h`,
  ].join('\n');
}

/** 详情：标题（带完整描述）、用法、示例、参数、选项、子指令、别名，各段之间空一行 */
export function renderDetail(cmd: Command, children: Entry[], prefix: string): string {
  const head = spelled(cmd.name, prefix);
  const usage = [
    head,
    children.length > 0 && !cmd.handler ? '<子指令>' : '',
    ...cmd.positionalArgs.map(argText),
    cmd.options.length > 0 ? '[选项]' : '',
  ];
  const described = cmd.positionalArgs.filter(a => a.description);
  return [
    cmd.isGroup || !cmd.description ? head : `${head} — ${cmd.description}`,
    `用法：${usage.filter(Boolean).join(' ')}`,
    section(
      '示例：',
      (cmd.examples ?? []).map(e => `- ${e}`),
    ),
    section(
      '参数：',
      described.map(a => `- ${argText(a)}：${a.description}`),
    ),
    section('选项：', cmd.options.flatMap(optionLines)),
    section(
      '子指令：',
      children.map(e => entryLine(e, prefix)),
    ),
    cmd.aliases.length > 0 ? `别名：${cmd.aliases.map(a => spelled(a, prefix)).join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
