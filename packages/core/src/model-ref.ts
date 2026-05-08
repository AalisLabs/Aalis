// ===== Model 引用编解码 =====
//
// 把 (provider, model) 二元组与配置/UI 友好的 string 形式互转，避免在 yaml 与 form 里
// 引入复合 schema。yaml 与 WebUI dynamicOptions:'llm' 的 select value 都使用此格式：
//
//   "<providerContextId>::<modelId>"
//
// 例如：
//   "@aalis/plugin-openai::gpt-4o"
//   "@aalis/plugin-deepseek::deepseek-chat"
//   "@aalis/plugin-ollama::qwen2.5:7b"   ← model id 内部出现 ':' 仍然安全（用 '::' 分隔）
//
// 只接受 contextId 作为 provider 部分；不接受 label，避免歧义。

const MODEL_REF_SEPARATOR = '::';

export interface ModelRef {
  /** provider 的 contextId（instanceId）。未指定则 router 走"按 model id 在所有 provider listModels 中查找" */
  provider?: string;
  /** 模型 id；未指定则 provider 用其默认模型 */
  model?: string;
}

/**
 * 解析复合 model 引用字符串。
 *
 * - `"@aalis/plugin-openai::gpt-4o"` → `{ provider: "@aalis/plugin-openai", model: "gpt-4o" }`
 * - `"gpt-4o"` （无 `::`）→ `{ model: "gpt-4o" }`（旧风格，仅 model）
 * - `""` / null / undefined → `{}`（让调用方走默认 provider/model）
 *
 * 注意：分隔符使用 `::` 而非 `:`，因为 model id 中允许包含 `:`（如 ollama 的 `qwen2.5:7b`）。
 */
export function parseModelRef(value: string | null | undefined): ModelRef {
  if (!value) return {};
  const idx = value.indexOf(MODEL_REF_SEPARATOR);
  if (idx < 0) return { model: value };
  const provider = value.slice(0, idx);
  const model = value.slice(idx + MODEL_REF_SEPARATOR.length);
  return {
    provider: provider || undefined,
    model: model || undefined,
  };
}

/**
 * 将 (provider, model) 编码为复合 string，用于持久化或 UI 选项 value。
 * 任一方缺失时不输出分隔符（避免产生 `::xxx` 或 `xxx::` 这种不规整形式）。
 */
export function formatModelRef(ref: ModelRef): string {
  if (ref.provider && ref.model) return `${ref.provider}${MODEL_REF_SEPARATOR}${ref.model}`;
  return ref.model ?? ref.provider ?? '';
}
