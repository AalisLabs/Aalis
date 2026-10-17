// ============================================================
// help.ts — 指令帮助的渲染（纯函数，便于单测）
//
// 两段式：概览回答「有哪些能用」，详情回答「这条怎么用」。哪些指令看得见由注册表按调用者的等级定。一条回复要用的说明与
// 版式文字整份交给 localize 渲染一次（按调用者所在会话的语言），渲染之后再取摘要、拼成整条回复，回复是这种语言的字符串。
//
// 输出是各平台通用的纯文本：QQ 与终端原样显示，WebUI 的时间线里是纯文本通知。所以只用一行一条的 `- ` 列表（取值缩进两格
// 成子列表），段落之间空一行；不用加粗、反引号与代码围栏，也不用空格对列（比例字体下对不齐）。占位写成 `<名字>`，不带类型。
// ============================================================

import type { Command, OptionSpec, PositionalArgSpec } from '@aalis/api-commands';
import type { Localized, TextRef } from '@aalis/schema-i18n';
import { t } from './texts.js';

/** 把值里的文字对象按调用者所在会话的语言渲染成字符串：一条回复只调一次 */
export type Localize = <T>(value: T) => Localized<T>;

/** 句子边界按 Unicode 的通用规则，与读者的语言无关 */
const SENTENCES = new Intl.Segmenter('und', { granularity: 'sentence' });
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** 句子切分不在分号处断句，分号另算句末（换行处它已断句） */
const CLAUSE_END = /[;；]/;
/**
 * 占两列的字：中日韩文字（按 Script_Extensions 认，长音符 ー 与中点 ・ 这类各文字共用的符号在内）、中日韩标点、竖排与兼容
 * 形式、全角形式；Script_Extensions 也带上的拉丁区中点 ·、修饰符与组合符，谚文的中声与终声，半角片假名与半角谚文占一列
 */
const WIDE =
  /^(?![\u00A0-\u036F\u1160-\u11FF\uFF61-\uFFDC])[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Hang}\p{scx=Bopo}\u3000-\u303F\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]/u;
/** 按 emoji 显示的字素同样占两列：默认按 emoji 显示的，以及带 VS16（U+FE0F）或键帽（U+20E3）的文本字符 */
const EMOJI = /\p{Emoji_Presentation}|\uFE0F|\u20E3/u;
/** 摘要的上限（按显示宽度计）：第一句过长时截断，免得一行撑满 */
const BRIEF_COLUMNS = 48;

/**
 * 摘要：约定描述的第一句就是摘要，句末标点不留；第一句超过 48 列时截断，去掉截断处尾部的标点（闭括号与后引号除外）与空白，
 * 省略号紧跟文字
 */
export function brief(description: string): string {
  const [sentence] = SENTENCES.segment(description.trim());
  const first = (sentence?.segment ?? '').split(CLAUSE_END)[0].replace(/[\s\p{Sentence_Terminal}]+$/u, '');
  let width = 0;
  let kept = '';
  for (const { segment } of GRAPHEMES.segment(first)) {
    width += WIDE.test(segment) || EMOJI.test(segment) ? 2 : 1;
    if (width > BRIEF_COLUMNS) return `${kept.replace(/(?:(?![\p{Pe}\p{Pf}])[\s\p{P}])+$/u, '')}…`;
    kept += segment;
  }
  return first;
}

/** 列表里的一条指令：概览与详情的子指令共用 */
export interface Entry {
  cmd: Command;
  /** 调用者看得见的直接子指令数 */
  children: number;
}

const spelled = (name: string, prefix: string) => `${prefix}${name.replace(/\./g, ' ')}`;

/** 列表里的一条指令要渲染的文字：说明（自动分组没有）与子指令数 */
const entryTexts = ({ cmd, children }: Entry) => ({
  description: cmd.isGroup ? '' : cmd.description,
  children: children > 0 ? t('children', { count: children }) : '',
});

/** `- /指令 — 摘要 · n 个子指令`：说明渲染之后取摘要 */
function entryLine(name: string, texts: Localized<ReturnType<typeof entryTexts>>, prefix: string): string {
  const notes = [brief(texts.description), texts.children].filter(Boolean);
  return `- ${spelled(name, prefix)}${notes.length > 0 ? ` — ${notes.join(' · ')}` : ''}`;
}

const argText = (arg: PositionalArgSpec) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`);

/** 带说明的一项写成「项：说明」 */
const described = (item: string, description: string | TextRef | undefined) =>
  description ? t('described', { item, description }) : item;

/** 一个选项一行，取值各占一行缩在下面 */
function optionLines(option: OptionSpec): (string | TextRef)[] {
  const flags = new Set([`--${option.name}`, ...option.aliases.map(a => (a.length === 1 ? `-${a}` : `--${a}`))]);
  const placeholder = option.valueName ?? option.name;
  const value = option.type === 'boolean' ? '' : option.valueOptional ? ` [${placeholder}]` : ` <${placeholder}>`;
  return [
    described(`- ${[...flags].join(', ')}${value}`, option.description),
    ...(option.choices ?? []).map(c => described(`  - ${c.value}`, c.description)),
  ];
}

/** 用法里以空格相连的一串：占位词（<子指令>、[选项]）是文字对象，嵌套着交出，与整条回复同一次渲染 */
const spaced = (words: readonly (string | TextRef)[]) => words.reduce((head, tail) => t('spaced', { head, tail }));

/** 一段：标题加一行一条；没有条目时整段不出 */
const section = (title: string, lines: string[]) => (lines.length > 0 ? [title, ...lines].join('\n') : '');

export function renderOverview(entries: Entry[], prefix: string, localize: Localize): string {
  const texts = localize({
    title: t('overview', { count: entries.length }),
    entries: entries.map(entryTexts),
    hint: t('overviewHint', { prefix }),
  });
  const lines = texts.entries.map((e, i) => entryLine(entries[i].cmd.name, e, prefix));
  return [texts.title, ...lines, '', texts.hint].join('\n');
}

/**
 * 详情：标题（带完整描述）、用法、示例、参数、选项、子指令、别名，各段之间空一行。给了 error 时（选项写错附上用法）报错在
 * 最前面
 */
export function renderDetail(
  cmd: Command,
  children: Entry[],
  prefix: string,
  localize: Localize,
  error?: TextRef,
): string {
  const head = spelled(cmd.name, prefix);
  const usage = spaced([
    head,
    ...(children.length > 0 && !cmd.handler ? [t('subcommandSlot')] : []),
    ...cmd.positionalArgs.map(argText),
    ...(cmd.options.length > 0 ? [t('optionsSlot')] : []),
  ]);
  const texts = localize({
    error: error ?? '',
    description: cmd.isGroup ? '' : cmd.description,
    usage: t('usage', { usage }),
    examples: t('examples'),
    arguments: t('arguments'),
    argumentLines: cmd.positionalArgs.filter(a => a.description).map(a => described(`- ${argText(a)}`, a.description)),
    options: t('options'),
    optionLines: cmd.options.flatMap(optionLines),
    subcommands: t('subcommands'),
    children: children.map(entryTexts),
    aliases: cmd.aliases.length > 0 ? t('aliases', { names: cmd.aliases.map(a => spelled(a, prefix)) }) : '',
  });
  return [
    texts.error,
    texts.description ? `${head} — ${texts.description}` : head,
    texts.usage,
    section(
      texts.examples,
      (cmd.examples ?? []).map(e => `- ${e}`),
    ),
    section(texts.arguments, texts.argumentLines),
    section(texts.options, texts.optionLines),
    section(
      texts.subcommands,
      texts.children.map((e, i) => entryLine(children[i].cmd.name, e, prefix)),
    ),
    texts.aliases,
  ]
    .filter(Boolean)
    .join('\n\n');
}
