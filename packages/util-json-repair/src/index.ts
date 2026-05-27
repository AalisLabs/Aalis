// 通用 LLM JSON 输出的容错解析与提取。
//
// LLM 输出的 JSON 经常带各种小毛病：包了 markdown 代码块、前后多了文本、
// XML 属性里的双引号没转义、尾部多余逗号、被截断少了 '}' 等。
// 这里把所有修复策略集中到一处，按"由轻到重"依次尝试，直到 JSON.parse 成功。
//
// 历史：本文件抽自 @aalis/plugin-persona/src/json-repair.ts，
// 供 persona / user-profile / user-relation 等所有需要解析 LLM JSON
// 的插件共享，避免重复实现修复策略。

/** 修复策略，依次尝试。每个策略接收当前文本，返回修复后的文本（不变可返回原值）。 */
type RepairStep = { name: string; apply: (s: string) => string };

const repairSteps: RepairStep[] = [
  {
    // 模型有时会在 JSON 字符串里直接写英文引号，例如：
    // "message": "他说"你好"然后走了"
    // 严格 JSON 需要把内部引号转义。这里用状态机判断：字符串中的引号只有在
    // 后续字符像 JSON 分隔符（: , } ] 或结尾）时才视为闭合，否则转义。
    name: '字符串内部裸引号转义',
    apply: escapeBareQuotesInStrings,
  },
  {
    // 模型偶尔会在 message 里写 <face id="14"/> 之类的 XML 标签，
    // 但属性引号没转义，导致 JSON 解析在字符串中提前断开。
    name: 'XML 属性引号转义',
    apply: s => s.replace(/<(\w+)\s+(\w+)="([^"]*?)"\s*\/>/g, '<$1 $2=\\"$3\\" />'),
  },
  {
    name: '移除尾部多余逗号',
    apply: s => s.replace(/,\s*([\]}])/g, '$1'),
  },
  {
    // 模型截断（max_tokens 触发、推理块被中途切断等）常常少一个或多个 '}'。
    name: "补全缺失的 '}' 与 ']'",
    apply: s => {
      const trimmed = s.trimEnd();
      const missingObj = countOutsideStrings(trimmed, '{') - countOutsideStrings(trimmed, '}');
      const missingArr = countOutsideStrings(trimmed, '[') - countOutsideStrings(trimmed, ']');
      if (missingObj <= 0 && missingArr <= 0) return s;
      let completed = trimmed;
      // 数组先闭合，再闭合对象，符合常见嵌套
      if (missingArr > 0) completed += ']'.repeat(missingArr);
      if (missingObj > 0) completed += '}'.repeat(missingObj);
      return completed;
    },
  },
];

/** 在字符串字面量之外计算字符出现次数，避免把 message 里的 '{' 算进去。 */
function countOutsideStrings(s: string, ch: string): number {
  let count = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && c === ch) count++;
  }
  return count;
}

function nextNonWhitespace(s: string, start: number): string {
  for (let i = start; i < s.length; i++) {
    if (!/\s/.test(s[i])) return s[i];
  }
  return '';
}

function isJsonValueStart(c: string): boolean {
  return c === '"' || c === '{' || c === '[' || c === '-' || /[0-9tfn]/.test(c);
}

function isLikelyClosingQuote(s: string, quoteIndex: number): boolean {
  const next = nextNonWhitespace(s, quoteIndex + 1);
  if (next === '' || next === ':' || next === '}' || next === ']') return true;
  if (next !== ',') return false;

  const commaIndex = s.indexOf(',', quoteIndex + 1);
  if (commaIndex < 0) return false;
  const afterComma = nextNonWhitespace(s, commaIndex + 1);
  return isJsonValueStart(afterComma) || afterComma === '}' || afterComma === ']';
}

function escapeBareQuotesInStrings(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }

    if (c === '\\') {
      out += c;
      if (inString) escaped = true;
      continue;
    }

    if (c === '"') {
      if (!inString) {
        inString = true;
        out += c;
        continue;
      }

      if (isLikelyClosingQuote(s, i)) {
        inString = false;
        out += c;
      } else {
        out += '\\"';
        changed = true;
      }
      continue;
    }

    out += c;
  }

  return changed ? out : s;
}

/** 找到第一个顶层 JSON 对象的结束位置；忽略字符串里的括号与转义。 */
function findBalancedJsonObjectEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

/**
 * 从模型原始输出里提取 JSON 子串。
 * - 去掉 ```json / ``` 围栏
 * - 扫描所有顶层 '{' 候选，取**最后一个**包含 ':' 的配平对象
 *   （有 ':' 才是真正的 key:value JSON 对象，数学集合符号如 {1,2,3} 不含 ':' 会被跳过）
 * - 模型通常先输出推理/自由文本，最后才输出 JSON payload，因此优先取最后一个候选
 * - 若无合格候选则退化为原行为：从第一个 '{' 取配平或截断片段
 */
export function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  // 遍历所有 '{' 位置，收集平衡且含 ':' 的对象候选，记录最后一个。
  let lastObjectStart = -1;
  let lastObjectEnd = -1;
  let searchFrom = 0;

  while (searchFrom < unfenced.length) {
    const brace = unfenced.indexOf('{', searchFrom);
    if (brace < 0) break;
    const end = findBalancedJsonObjectEnd(unfenced, brace);
    if (end > brace) {
      const candidate = unfenced.slice(brace, end + 1);
      // 真正的 JSON 对象必须含 ':'；纯集合/枚举写法 {A,B,C} 没有 ':' 故排除
      if (candidate.includes(':')) {
        lastObjectStart = brace;
        lastObjectEnd = end;
      }
    }
    searchFrom = brace + 1;
  }

  if (lastObjectStart >= 0) {
    return unfenced.slice(lastObjectStart, lastObjectEnd + 1);
  }

  // 降级回原行为：从第一个 '{' 开始，配平或截断
  const firstBrace = unfenced.indexOf('{');
  if (firstBrace < 0) return unfenced;
  const endFb = findBalancedJsonObjectEnd(unfenced, firstBrace);
  return endFb >= firstBrace ? unfenced.slice(firstBrace, endFb + 1) : unfenced.slice(firstBrace);
}

export interface RepairResult {
  /** 解析得到的对象；解析全部失败时为 null。 */
  parsed: Record<string, unknown> | null;
  /** 命中的修复步骤名称（按顺序累积）。直接解析成功则为空数组。 */
  repairsApplied: string[];
}

/**
 * 容错解析 JSON 对象：先按原文 parse，失败则依次叠加修复策略再试。
 * 仅返回对象类型；数组/原始值或所有修复都失败时 parsed 为 null。
 */
export function tryParseJsonObject(jsonStr: string): RepairResult {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const obj = JSON.parse(s);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  let parsed = tryParse(jsonStr);
  if (parsed) return { parsed, repairsApplied: [] };

  let current = jsonStr;
  const applied: string[] = [];
  for (const step of repairSteps) {
    const next = step.apply(current);
    if (next === current) continue;
    current = next;
    applied.push(step.name);
    parsed = tryParse(current);
    if (parsed) return { parsed, repairsApplied: applied };
  }
  return { parsed: null, repairsApplied: applied };
}

/**
 * 一站式：从 LLM 原始输出中提取 + 容错解析 JSON 对象。
 * 等价于 `tryParseJsonObject(extractJsonCandidate(raw))`，便于调用方一行解决。
 */
export function parseLLMJsonObject(raw: string): RepairResult {
  return tryParseJsonObject(extractJsonCandidate(raw));
}
