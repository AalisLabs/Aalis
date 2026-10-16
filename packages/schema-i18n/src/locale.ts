// 语言标签的规范化与匹配

/** 系统与手填的写法先整理：下划线换连字符，去掉 `.UTF-8`、`@euro` 这类后缀 */
const tidy = (tag: string) => tag.replace(/[.@].*$/, '').replace(/_/g, '-');

/** 规范写法（`zh-cn` → `zh-CN`），不合法时 undefined */
export function canonicalLanguage(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/** 读者给的列表只看前几项：超长的列表不逐项规范化 */
const MAX_INPUT = 32;
/** 语言链最多几种：再多也轮不到 */
const MAX_LANGUAGES = 8;

/**
 * 读者给的语言列表规范化：整理写法、过 getCanonicalLocales，不合法的（含不是字符串的）丢掉，去重保序。列表来自读者
 * （请求、协议、会话设置），只看前 32 项，至多给出 8 种
 */
export function normalizeLanguages(tags: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const tag of tags.slice(0, MAX_INPUT)) {
    if (out.length === MAX_LANGUAGES) break;
    if (typeof tag !== 'string') continue;
    const canonical = canonicalLanguage(tidy(tag));
    if (canonical !== undefined && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

interface Subtags {
  readonly language: string;
  readonly script?: string;
  readonly region?: string;
}

// 读者的标签来自请求，条目数封顶
const subtagCache = new Map<string, Subtags | null>();

/** maximize 之后的语言、文字与地区：zh、zh-CN、zh-SG 都是 zh-Hans，zh-TW、zh-HK 是 zh-Hant */
function subtags(tag: string): Subtags | undefined {
  let found = subtagCache.get(tag);
  if (found === undefined) {
    try {
      const { language, script, region } = new Intl.Locale(tidy(tag)).maximize();
      found = { language, script, region };
    } catch {
      found = null;
    }
    if (subtagCache.size >= 512) subtagCache.clear();
    subtagCache.set(tag, found);
  }
  return found ?? undefined;
}

/**
 * 按读者语言链在可用语言里选一种，返回下标：①链里逐项找语言与文字都相同的，同文字内地区相同者优先，
 * 其余按 available 的先后；②链里逐项找语言相同、文字不同的（zh-TW 读者遇到只有简体时用简体）；③en。
 * 都没有时 undefined，由调用方用原文
 */
export function pickLanguage(chain: readonly string[], available: readonly string[]): number | undefined {
  const offered = available.map(subtags);
  const sameScript = (reader: Subtags) => {
    let first: number | undefined;
    for (const [i, candidate] of offered.entries()) {
      if (candidate?.language !== reader.language || candidate.script !== reader.script) continue;
      if (candidate.region === reader.region) return i;
      first ??= i;
    }
    return first;
  };
  const readers = chain.map(subtags).filter(reader => reader !== undefined);
  for (const reader of readers) {
    const found = sameScript(reader);
    if (found !== undefined) return found;
  }
  for (const reader of readers) {
    const found = offered.findIndex(candidate => candidate?.language === reader.language);
    if (found >= 0) return found;
  }
  const english = subtags('en');
  return english && sameScript(english);
}
