// 通用 LLM JSON 输出的容错解析与提取，做三样修复：
// - 去掉代码围栏和前后文字：模型常把 JSON 包进 ```json 围栏，或在前后写推理与解释；
// - 转义字符串里的裸引号：模型会在字符串里直接写英文引号，严格 JSON 要转义；
// - 去掉尾逗号：模型照 JS 习惯在最后一项后面留逗号，严格 JSON 不收。
// 被输出上限截断的 JSON 不补结尾、照样解析失败：截断由模型插件报的结束原因（api-llm 的 finishReason）认。

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
    // 模型照 JS 习惯在最后一项后面留逗号，严格 JSON 不收
    name: '移除尾部多余逗号',
    apply: stripTrailingCommasOutsideStrings,
  },
];

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

/**
 * 移除对象/数组尾部多余逗号（`,]` / `,}`），只在字符串外生效。
 * 无状态的全局 replace 会把字符串**内容**里的 `,]` / `,}` 一并吃掉，
 * 静默改写模型写的正文（落库后无人复核），故与其它两步同款走 inString 状态机。
 */
function stripTrailingCommasOutsideStrings(s: string): string {
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
      inString = !inString;
      out += c;
      continue;
    }
    if (!inString && c === ',') {
      const next = nextNonWhitespace(s, i + 1);
      if (next === ']' || next === '}') {
        changed = true;
        continue; // 丢掉这个逗号，其后空白原样保留
      }
    }

    out += c;
  }

  return changed ? out : s;
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
 * - 若无合格候选则从第一个 '{' 取配平片段，配不平时取到末尾
 */
export function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  // 遍历所有顶层 '{' 位置，收集平衡且含 ':' 的对象候选，记录最后一个。
  // 关键：找到平衡对象后跳到 end+1，跳过该对象的全部内容，只扫顶层对象，
  // 避免把嵌套的内层 {} 误当成候选。
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
      // 跳过整个对象（含其内部的所有嵌套 '{'），只扫顶层
      searchFrom = end + 1;
    } else {
      // 顶层 '{' 配不平时其后所有内容都算在这个未闭合对象内部（字符串里只有一个裸引号、或对象被截断）；若它只是正文里
      // 的孤立 '{'（如推理中写了半截代码），其后真正的 JSON 会随之被放弃（这是取舍）。此时必须停止扫描：若继续 brace+1
      // 前进会 descend 进内层嵌套对象、把配平的内层误当候选，从而丢弃外层已输出的全部字段。停止后交由下方降级分支
      // 从第一个 '{' 返回整段
      break;
    }
  }

  if (lastObjectStart >= 0) {
    return unfenced.slice(lastObjectStart, lastObjectEnd + 1);
  }

  // 没有合格候选：从第一个 '{' 开始，配平的取那一段，配不平的取到末尾——字符串里只有一个裸引号时配平会失败，
  // 这一段要交给裸引号转义；被截断的照样解析失败
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
