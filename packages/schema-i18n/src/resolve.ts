// 按读者语言链把一个文字对象渲染成字符串（纯函数，出口与前端共用）
import { catalogEntry, entryText } from './catalog.js';
import { escapeMarkdown, formatMessage } from './format.js';
import { pickLanguage } from './locale.js';
import { incompatibleParams, type Message, paramKinds, parseMessage } from './message.js';
import { fingerprint, type PackIndex } from './packs.js';
import type { TextRef } from './text-ref.js';

export interface ResolveOptions {
  /** 语言包索引（indexPacks 建），补字典没有的语言 */
  readonly packs?: PackIndex;
  /** date 与 time 用的时区，缺省用进程时区 */
  readonly timeZone?: string;
  /** 字符串参数按 Markdown 转义：Markdown 正文一类出口用，免得昵称、文件名里的 `[文字](链接)` 成了宿主给的链接 */
  readonly escape?: 'markdown';
}

/** 参数里的文字对象最多嵌套几层：再深的用那一层的 source，伪造的深层嵌套不放大、环不挂死 */
const MAX_NESTING = 8;

/**
 * 按读者的语言链渲染文字对象。可用语言 = 原文语言 ∪ 字典自带译文的语言 ∪ 语言包补的语言（只补缺，原文指纹相符才算），
 * 解析失败与参数和原文不兼容的译文不算。选法见 pickLanguage：读者链里文字相同的 → 语言相同、文字不同的 → en → 原文；
 * 命中原文语言就用原文。ns 不在目录、键不存在、原文解析失败、渲染失败时用 `text.source`（转义模式下整句转义）。
 * 参数里的文字对象用同一条链递归
 */
export function resolveText(text: TextRef, chain: readonly string[], options: ResolveOptions = {}): string {
  return resolve(text, chain, options, 0);
}

/**
 * 只按原文语言渲染文字对象：出口在 i18n 服务缺席时用（日志与交给模型的用 toSource）。参数里的文字对象同样取各自的原文，
 * 回落规则同 {@link resolveText}
 */
export function resolveSource(text: TextRef, options: Pick<ResolveOptions, 'timeZone' | 'escape'> = {}): string {
  return resolve(text, undefined, options, 0);
}

/** chain 为 undefined 时只取原文 */
function resolve(text: TextRef, chain: readonly string[] | undefined, options: ResolveOptions, depth: number): string {
  const fallback = () => (options.escape === 'markdown' ? escapeMarkdown(text.source) : text.source);
  const entry = depth > MAX_NESTING ? undefined : catalogEntry(text.i18n);
  const template = entry && entryText(entry.source, text.key);
  const source = template === undefined ? undefined : parseMessage(template);
  if (entry === undefined || template === undefined || source === undefined) return fallback();
  const languages = [entry.language];
  const messages: Message[] = [source];
  if (chain !== undefined) {
    const expected = paramKinds(source);
    const offer = (language: string, translation: string) => {
      const message = parseMessage(translation);
      if (message === undefined || incompatibleParams(expected, message).length > 0) return;
      languages.push(language);
      messages.push(message);
    };
    for (const [language, table] of Object.entries(entry.locales)) {
      const translation = entryText(table, text.key);
      if (translation !== undefined) offer(language, translation);
    }
    const packed = options.packs?.get(text.i18n)?.get(text.key);
    if (packed) {
      const from = fingerprint(template);
      for (const candidate of packed) {
        if (candidate.from !== from || languages.includes(candidate.language)) continue;
        offer(candidate.language, candidate.text);
      }
    }
  }
  const chosen = chain === undefined ? 0 : (pickLanguage(chain, languages) ?? 0);
  const rendered = formatMessage(messages[chosen], text.params ?? {}, {
    language: languages[chosen],
    timeZone: options.timeZone,
    escape: options.escape,
    nested: nested => resolve(nested, chain, options, depth + 1),
  });
  return rendered ?? fallback();
}
