/**
 * @aalis/util-text-normalize
 *
 * 对话内容净化工具集：处理 LLM 输出的自然语言 Markdown 中常见错误，
 * 让下游渲染器（remark-gfm / KaTeX 等）能正确解析。
 *
 * 设计原则：
 * - 纯函数、无副作用；可在 agent 端、webui 端、其它前端复用
 * - 只修复**明确错误**的格式问题；不做风格改写
 * - 跳过代码块（``` 与 inline `）以避免误改示例代码
 *
 * 与 `@aalis/util-json-repair` 的边界：
 * - util-json-repair：处理"被 prompt 要求输出 JSON 的 LLM 响应"的解析问题
 *   （结构化数据通道，调用者主动调用）
 * - util-text-normalize：处理"自然语言对话 content"的渲染层问题
 *   （在 agent 拿到完整响应后统一调用一次）
 */

/**
 * 统计 GFM 表格行的列数（兼容有无首尾竖线两种写法）。
 *
 * 示例：
 * - `| a | b | c |`  → 3
 * - `a | b | c`      → 3
 * - `|:--|:--|`      → 2
 */
function countGfmCols(line: string): number {
  const t = line.trim();
  const parts = t.split('|');
  const start = parts[0].trim() === '' ? 1 : 0;
  const end = parts[parts.length - 1].trim() === '' ? parts.length - 1 : parts.length;
  return Math.max(0, end - start);
}

/**
 * 将分隔行的列数规范为 targetCols：多裁少补，保留原始对齐符号（`:--`、`--:`、`:--:`）。
 */
function normalizeSepRow(sepLine: string, targetCols: number): string {
  const t = sepLine.trim();
  const lead = t.startsWith('|') ? '|' : '';
  const trail = t.endsWith('|') ? '|' : '';
  const inner = t.slice(lead.length, trail ? t.length - 1 : undefined);
  // 只保留合法对齐符号；过滤掉空段（例如末尾多余的 `|` 造成的空 cell）
  const cells = inner
    .split('|')
    .map(c => c.trim())
    .filter(c => /^:?-+:?$/.test(c));
  while (cells.length < targetCols) cells.push('---');
  cells.length = targetCols;
  return lead + cells.join('|') + trail;
}

/**
 * 判断某行是否符合 GFM 表格的"分隔行"特征
 * （仅由 `|`, `-`, `:`, 空白 组成，且至少含一个 `-`）。
 */
function isSeparatorRow(line: string): boolean {
  return /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?\s*$/.test(line);
}

/**
 * 修复 GFM 表格分隔行与表头列数不一致的问题。
 *
 * 背景：`micromark-extension-gfm-table` v2 严格要求表头列数 === 分隔行列数，
 * 否则整个表格退化为纯文本（用户在 UI 上看到的就是裸露的 `|...|...|` 字符串）。
 *
 * 典型 LLM 错误：
 * ```
 * | A | B |          ← 2 列
 * |:--|:--|:--|      ← 3 列（多打了一个 |）
 * | x | y |
 * ```
 *
 * 修复后：
 * ```
 * | A | B |
 * |:--|:--|
 * | x | y |
 * ```
 *
 * 实现要点：
 * - 跳过 ``` fenced code blocks 与 `inline code`，避免误改示例
 * - 仅当上一行包含 `|` 且非空时才认为是表头
 * - 列数双向修复：分隔行多 → 截断；少 → 补 `---`
 */
export function fixGfmTables(content: string): string {
  if (!content) return content;
  // 先按代码区域拆分，奇数索引为代码内容，保持原样
  const parts = content.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const lines = part.split('\n');
      const out: string[] = [];
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        if (j > 0 && isSeparatorRow(line)) {
          const prev = lines[j - 1];
          if (prev.includes('|') && prev.trim()) {
            const hCols = countGfmCols(prev);
            const sCols = countGfmCols(line);
            if (hCols > 0 && sCols > 0 && hCols !== sCols) {
              out.push(normalizeSepRow(line, hCols));
              continue;
            }
          }
        }
        out.push(line);
      }
      return out.join('\n');
    })
    .join('');
}

/**
 * 剥离 LLM 输出 `content` 字段中泄漏的"特殊 token 标记"残渣。
 *
 * 适用范围（通用）：任何使用 `<...特殊字符...keyword...特殊字符...>` 形式
 * special token 表达内部协议、且服务端解析器偶发匹配失败导致裸标记落到
 * content 的场景。当前已知典型 case 是 DeepSeek 的 DSML：
 *
 * ## DSML 背景
 * DeepSeek V3.2/V4 系列使用内部 DSML (DeepSeek Markup Language) 协议表达
 * tool_calls，标记形如：
 * ```
 * <｜DSML｜tool_calls><｜DSML｜invoke name="X">
 *   <｜DSML｜parameter name="Y" string="true">VALUE</｜DSML｜parameter>
 * </｜DSML｜invoke></｜DSML｜tool_calls>
 * ```
 * （`｜` 为 U+FF5C 全角竖线）
 *
 * 已知 bug：模型会输出**畸形变体**（多一对竖线，如 `<｜｜DSML｜｜...>`），
 * 服务端按 `｜DSML｜` 严格匹配的 tool_call_parser 失败，整段以裸文本形式
 * 留在 `content` 里。参见：
 * - https://huggingface.co/deepseek-ai/DeepSeek-V3.2/discussions/29
 * - https://forums.developer.nvidia.com/t/367901
 *
 * ## 本函数策略
 * 作为最后一道防线：
 * - 优先剥离整段 `<...DSML...>...</...DSML...>`
 * - 兜底剥离零散残留的 `<...DSML...>` 单 token（跨 chunk 边界泄漏的碎片）
 * - 不尝试反解为 tool_calls（避免触发未授权副作用，且畸形变体解析风险大）
 *
 * 命名上不带厂商前缀（"Leaked Special Tokens"），意图是当未来其他模型出现
 * 同类问题时（例如 Qwen 漏 `<|im_xxx|>`、Llama 漏 `<|python_tag|>`），可以
 * 直接扩展本函数的 regex，而非新开 `stripQwenTokens` / `stripLlamaTokens`
 * 等并列函数造成上游调用方的认知碎片化。
 *
 * @returns 净化后的内容 + 是否发生过泄漏（供调用方告警/遥测）
 */
export function stripLeakedSpecialTokens(content: string): {
  sanitized: string;
  hadLeak: boolean;
} {
  if (!content) return { sanitized: content, hadLeak: false };
  // 廉价早出：三条规则都要求出现字面量 "DSML"——没有它不可能泄漏。这同时把「无 DSML 的
  // 病理输入(如海量竖线)」挡在正则外，杜绝灾难性回溯(ReDoS：旧实现 5000 竖线即冻进程)。
  if (!content.includes('DSML')) return { sanitized: content, hadLeak: false };
  let sanitized = content;
  let hadLeak = false;
  // 线性正则：每个标签内仅**一个** `[^<>]*`，DSML 用零宽 lookahead 断言——消除旧版
  // `[^<>]*?[｜|]+[^<>]*`（同类字符多量词重叠）的回溯爆炸，行为对现有样本完全等价。
  // 1) 整段成对 block：<...DSML...>...</...DSML...>（lazy 到最近闭合）
  const blockRe = /<(?=[^<>]*DSML)[｜|][^<>]*>[\s\S]*?<\/(?=[^<>]*DSML)[｜|][^<>]*>/g;
  if (blockRe.test(sanitized)) {
    hadLeak = true;
    sanitized = sanitized.replace(blockRe, '');
  }
  // 2) 残留单 token：开/闭标签碎片
  const tokenRe = /<\/?(?=[^<>]*DSML)[｜|][^<>]*>/g;
  if (tokenRe.test(sanitized)) {
    hadLeak = true;
    sanitized = sanitized.replace(tokenRe, '');
  }
  // 3) 极端兜底：未闭合的 DSML 起始片段（例如 `<｜｜DSML｜｜tool_calls`，缺末尾 `>`）
  const partialRe = /<\/?(?=[^<>]*DSML)[｜|][^<>]*/g;
  if (partialRe.test(sanitized)) {
    hadLeak = true;
    sanitized = sanitized.replace(partialRe, '');
  }
  return { sanitized: hadLeak ? sanitized.trim() : sanitized, hadLeak };
}

/**
 * 一次性应用所有对话内容净化规则。
 * 顺序：先剥离结构性泄漏（DSML 等特殊 token），再修复 GFM 表格渲染问题。
 */
export function normalizeAssistantContent(content: string): string {
  if (!content) return content;
  const { sanitized } = stripLeakedSpecialTokens(content);
  return fixGfmTables(sanitized);
}
