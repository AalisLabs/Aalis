// 角色卡 JSON 输出的提取与容错解析。
//
// LLM 输出的 JSON 经常带各种小毛病：包了 markdown 代码块、前后多了文本、
// XML 属性里的双引号没转义、尾部多余逗号、被截断少了 '}' 等。
// 这里把所有修复策略集中到一处，按"由轻到重"依次尝试，直到 JSON.parse 成功。

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
    apply: (s) => s.replace(
      /<(\w+)\s+(\w+)="([^"]*?)"\s*\/>/g,
      '<$1 $2=\\"$3\\" />',
    ),
  },
  {
    name: '移除尾部多余逗号',
    apply: (s) => s.replace(/,\s*([\]}])/g, '$1'),
  },
  {
    // 模型截断（max_tokens 触发、推理块被中途切断等）常常少一个或多个 '}'。
    name: "补全缺失的 '}' 与 ']'",
    apply: (s) => {
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
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
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
  let escape = false;
  let changed = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (escape) {
      out += c;
      escape = false;
      continue;
    }

    if (c === '\\') {
      out += c;
      if (inString) escape = true;
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

/**
 * 从模型原始输出里提取 JSON 子串。
 * - 去掉 ```json / ``` 围栏
 * - 若整体不是 '{' 起头，则取第一个 '{' 到最后一个 '}' 的片段
 * - 若都找不到，则返回 trim 后的原文
 */
export function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  let candidate = trimmed.startsWith('{')
    ? trimmed
    : trimmed.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  if (!candidate.startsWith('{')) {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidate = trimmed.slice(firstBrace, lastBrace + 1);
    }
  }
  return candidate;
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
      return obj && typeof obj === 'object' && !Array.isArray(obj)
        ? obj as Record<string, unknown>
        : null;
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
