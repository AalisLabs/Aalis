// DSML (DeepSeek Markup Language) → ToolCall best-effort 解析器
//
// 背景：DeepSeek V3.2 / V4 服务端使用基于特殊 token 的 tool_call 协议
// （DSML），正常情况下服务端会把 <｜DSML｜...> 块解析为 chat.completion 的
// `tool_calls` 字段，content 字段不含 DSML 文本。
//
// 已观察到的服务端 bug：当模型输出 **双竖线** 变体
// `<｜｜DSML｜｜tool_calls>...` 时（推测是 prompt 注入/上下文污染/小模型
// 失稳所致），服务端严格匹配 `｜DSML｜` 失败，DSML 文本原样 fallthrough
// 到 content 字段，且 tool_calls 字段为空。
//
// 本模块的职责：在客户端把这种泄漏的 DSML 文本重新解析为 ToolCall[]，
// 让 agent 走正常工具调用循环，而不是把它当垃圾文本剥掉导致空回复。
//
// 已知 DSML 块结构（基于真实样本）：
//   <｜DSML｜tool_calls>
//     <｜DSML｜invoke name="X">
//       <｜DSML｜parameter name="Y" string="true">VALUE</｜DSML｜parameter>
//       ...
//     </｜DSML｜invoke>
//     ...
//   </｜DSML｜tool_calls>
//
// 兼容变体：[｜|]+ 任意数量的全角/半角竖线。

import type { ToolCall } from '@aalis/plugin-message-api';

/**
 * 解析 DSML 文本块为 ToolCall 数组。
 *
 * @param text 包含 DSML 文本的字符串（可以是 content 全文，也可以是 DSML 块本身）
 * @returns 解析出的 ToolCall 数组（可能为空数组，表示未识别到任何完整 invoke）
 *
 * 设计原则：
 * - **best-effort**：不抛错。任何无法识别的片段静默跳过。
 * - **宽松**：兼容单/双/任意数量竖线、全角/半角竖线、name 内的空白。
 * - **去重**：同名同参的 invoke 只保留一次（避免重复触发）。
 */
export function parseDsmlToolCalls(text: string): ToolCall[] {
  if (!text?.includes('DSML')) return [];

  // 匹配每个 invoke 块。竖线类用 [｜|]+ 兼容变体。
  // [\s\S] 非贪婪匹配任意字符（包括换行）。
  const invokeRe =
    /<[｜|]+\s*DSML[｜|]+\s*invoke\s+name=(["'])([^"']+?)\1\s*>([\s\S]*?)<\/[｜|]+\s*DSML[｜|]+\s*invoke\s*>/g;
  const paramRe =
    /<[｜|]+\s*DSML[｜|]+\s*parameter\s+name=(["'])([^"']+?)\1(?:\s+string=(["'])(?:true|false)\3)?\s*>([\s\S]*?)<\/[｜|]+\s*DSML[｜|]+\s*parameter\s*>/g;

  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  let invokeMatch: RegExpExecArray | null;
  let idx = 0;
  invokeRe.lastIndex = 0;

  // biome-ignore lint/suspicious/noAssignInExpressions: 标准的 exec-while 循环
  while ((invokeMatch = invokeRe.exec(text)) !== null) {
    const name = invokeMatch[2]?.trim();
    const body = invokeMatch[3] ?? '';
    if (!name) continue;

    const args: Record<string, string> = {};
    paramRe.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: 标准的 exec-while 循环
    while ((paramMatch = paramRe.exec(body)) !== null) {
      const pName = paramMatch[2]?.trim();
      const pValue = paramMatch[4] ?? '';
      if (pName) args[pName] = pValue;
    }

    // 即使没有任何 parameter 也保留 invoke（无参工具是合法的）
    const argsJson = JSON.stringify(args);
    const dedupKey = `${name}\u0000${argsJson}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    calls.push({
      // 服务端 tool_call id 通常是 `call_xxxxx`；leak 场景下我们没有真实 id，
      // 自己生成一个稳定 id 让 agent / OneBot 适配器能区分。
      id: `call_dsml_${Date.now().toString(36)}_${idx}`,
      type: 'function',
      function: { name, arguments: argsJson },
    });
    idx++;
  }

  return calls;
}
