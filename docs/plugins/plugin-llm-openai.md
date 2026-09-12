# plugin-llm-openai — OpenAI LLM 服务

**包名**: `@aalis/plugin-llm-openai`  
**源码**: `packages/plugin-llm-openai/src/index.ts`

## 概述

OpenAI 兼容接口的 LLM 提供者：为每个可用模型实现一个 `LLMModel`（`@aalis/api-llm`）并注册为 `llm` 服务条目（条目 id 为 `<实例 id>/<modelId>`），支持流式输出、工具调用和多模态图片输入。可对接任何兼容 OpenAI API 格式的服务。

## 插件声明

```typescript
meta.name = '@aalis/plugin-llm-openai'
meta.provides = ['llm']
meta.reusable = true // 可多实例
// 未声明 inject（无服务依赖）
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | — | API Key：OpenAI API 密钥（本地服务可留空）（secret） |
| `baseUrl` | string | `'https://api.openai.com/v1'` | API 地址：API 端点完整前缀（含版本段，如 https://api.openai.com/v1）；插件只在其后拼 /chat/completions 与 /models。可替换为任何兼容服务（如 Gemini 的 https://generativelanguage.googleapis.com/v1beta/openai）。 |
| `customModels` | textarea | `''` | 自定义模型：手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。 |
| `modelCapabilities` | textarea | `''` | 单模型能力覆盖：按行指定某个模型的能力集。有该模型的表项时**覆盖**插件启发式推断，与 adapter 默认能力仍取并集。 格式：`&lt;modelId&gt;: &lt;cap1&gt;,&lt;cap2&gt;,...`，每行一条。如：gpt-4o: chat,tool_calling,vision,streaming 可用能力：chat / tool_calling / vision / streaming / thinking / json_mode 等。 |
| `providerCapabilities` | string | `''` | 适配器默认能力（逗号分隔）：为本适配器下所有模型额外补充的能力。最终某模型的能力 = 此处能力 ∪ 模型级别能力。例：chat,tool_calling,streaming |
| `timeout` | number | `120` | 请求超时 (秒)：LLM 请求超时时间（秒）。思考模式或长文本建议适当调大。0 = 不限制。 |
| `temperature` | number | `0.7` | 温度：0-2，越高越随机 |
| `maxTokens` | number | `4096` | 最大 Token：单次回复最大生成 token 数 |
| `contextLength` | number | `128000` | 上下文长度：模型上下文窗口大小 |
| `thinkingParam` | boolean | `false` | 透传 thinking 开关（DeepSeek 风格）：开启后把请求的 think 开关编码为 DeepSeek 风格的 `thinking: {type: enabled\|disabled}` 字段发给端点，使会话级 /session.set -t 与平台档 think 对本 provider 生效。仅在端点是 DeepSeek 或会原样透传该字段的中转时开启——OpenAI 官方端点不认此字段会拒收请求。请求未指定 think 时不发送该字段（沿用端点默认）。 |

## 特性

- **SSE 流式**: `chatStream()` 解析 SSE 事件流，累积 tool_calls delta
- **动态模型列表**: 启动时请求 `/models` 发现模型，与 `customModels` 合并（重复项会告警）后逐个注册；模型句柄上的 `refresh()` 会重新发现，并增删已注册的条目。未发现任何模型时不注册条目
- **兼容性**: 修改 `baseUrl` 可对接 Ollama、vLLM、LocalAI 等兼容服务——须写到完整前缀（如 `http://localhost:11434/v1`）。注意 plugin-llm-ollama 自身的 `baseUrl` 语义不同：填服务器根地址（默认 `http://localhost:11434`），由插件自行拼接 `/api/chat` 等路径
