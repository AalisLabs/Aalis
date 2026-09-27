# plugin-llm-openai — OpenAI LLM 服务

**包名**: `@aalis/plugin-llm-openai`  
**源码**: `packages/plugin-llm-openai/src/index.ts`

## 概述

OpenAI 兼容接口的 LLM 提供者：为每个可用模型实现一个 `LLMModel`（`@aalis/api-llm`）并注册为 `llm` 服务条目（条目 id 为 `<实例 id>/<modelId>`），支持流式输出、工具调用和多模态图片输入。可对接任何兼容 OpenAI API 格式的服务。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-llm-openai',
  provides: [llm],
  uses: {
    config,
    logger,
    lifecycle,
    provide,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | — | API Key：OpenAI API 密钥（本地服务可留空）（secret） |
| `baseUrl` | string | `'https://api.openai.com/v1'` | API 地址：API 端点完整前缀（含版本段，如 https://api.openai.com/v1）；插件只在其后拼 /chat/completions 与 /models。可替换为任何兼容服务（如 Gemini 的 https://generativelanguage.googleapis.com/v1beta/openai）。 |
| `customModels` | textarea | `''` | 自定义模型：手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。 |
| `discoverModels` | boolean | `true` | 自动发现模型：启动时请求 /models 发现可用模型，WebUI 可刷新模型列表。网关不提供 /models 时关闭：不发发现请求，只注册 customModels（此时必填），也不支持刷新。 |
| `modelCapabilities` | textarea | `''` | 单模型能力覆盖：按行指定某个模型的能力集。有该模型的表项时**覆盖**插件启发式推断，与 adapter 默认能力仍取并集。 格式：`&lt;modelId&gt;: &lt;cap1&gt;,&lt;cap2&gt;,...`，每行一条。如：gpt-4o: chat,tool_calling,vision,streaming 可用能力：chat / tool_calling / vision / streaming / thinking 等。 |
| `providerCapabilities` | string | `''` | 适配器默认能力（逗号分隔）：为本适配器下所有模型额外补充的能力。最终某模型的能力 = 此处能力 ∪ 模型级别能力。例：chat,tool_calling,streaming |
| `timeout` | number | `120` | 请求超时 (秒)：LLM 请求超时时间（秒）。思考模式或长文本建议适当调大。0 = 不限制。 |
| `temperature` | number | `0.7` | 温度：0-2，越高越随机 |
| `maxTokens` | number | `4096` | 最大 Token：单次回复最大生成 token 数 |
| `contextLength` | number | `128000` | 上下文长度：模型上下文窗口大小 |
| `thinkingParam` | boolean | `false` | 透传 thinking 开关（DeepSeek 风格）：开启后把请求的 think 开关编码为 DeepSeek 风格的 `thinking: {type: enabled\|disabled}` 字段发给端点，使会话级 /session.set -t 与平台档 think 对本 provider 生效。仅在端点是 DeepSeek 或会原样透传该字段的中转时开启——OpenAI 官方端点不认此字段会拒收请求。请求未指定 think 时不发送该字段（沿用端点默认）。 |

## 特性

- **SSE 流式**: `chatStream()` 解析 SSE 事件流，累积 tool_calls delta
- **动态模型列表**: 启动时请求 `/models` 发现模型（停用或停机时中止），与 `customModels` 合并（重复项会告警）后逐个注册；发现失败（不可达、超时、非 2xx、响应不是 JSON 或不是模型列表）时记一条 warn（带 URL 与原因），只注册 `customModels`。一个模型都没有（发现失败且未配置 `customModels`，或已连接但列表为空）时实例转为出错，错误信息写明原因。模型句柄上的 `refresh()` 会重新发现，并增删已注册的条目；发现失败时报错（消息带 URL 与原因），停用或停机时中止并报错，这两种情况都不增删条目
- **不提供 `/models` 的网关**: 关闭 `discoverModels`。启动时不发发现请求、不记 warn，只注册 `customModels`（此时必填，留空时实例转为出错并点名该字段），模型句柄不提供 `refresh()`，WebUI 模型选择框旁的「刷新」会提示该 provider 不支持运行时刷新
- **错误信息**: 对话请求失败时的错误信息会经 agent 发回会话，只写状态码与原因：非 2xx 时写状态码，401/403、402、404、429、5xx 各加一句提示（密钥无效或没有权限、余额不足或需要付费、模型或地址不对、请求过多或额度不足、上游服务故障），并附上游 JSON 里的说明（`error.message`、`error` 字符串或顶层 `message`，折成一行后截断）；取不到说明（如 HTML 错误页）时写「详情见日志」。超时与连不上各一句；非流式请求的应答是 200 但不是 JSON 时写明。响应体与底层原因（如 `connect ECONNREFUSED <地址>`）只记 warn 日志，响应体先把换行与连续空白折叠成一个空格，再截断到 500 个字符（按代理对安全截断）。内容审查类错误按完整响应体识别，给固定提示。模型发现失败的原因带响应体摘录（同样折叠与截断）；这段原因与启动日志里的 URL 去掉查询串
- **`baseUrl` 校验**: 带用户名或密码（`user:pass@`）或解析不了的 `baseUrl` 在读配置时报配置错误，实例转为出错、不发请求，错误信息不带 URL；密钥填在 `apiKey`。带凭据的 URL 本就发不出请求（fetch 拒绝），凭据还会出现在报错与 WebUI 的模型下拉里
- **兼容性**: 修改 `baseUrl` 可对接 Ollama、vLLM、LocalAI 等兼容服务——须写到完整前缀（如 `http://localhost:11434/v1`）。注意 plugin-llm-ollama 自身的 `baseUrl` 语义不同：填服务器根地址（默认 `http://localhost:11434`），由插件自行拼接 `/api/chat` 等路径
- **能力推断**: 模型能力按内置家族表的模型名前缀推断，带 `vision` 的有 gpt-4o、gpt-4.1、gpt-5、Gemini、通义千问视觉族（qwen-vl、qwen2.5-vl、qwen3-vl）与智谱视觉族（glm-4v、glm-4.1v、glm-4.5v），表外模型只推断为 `chat`（另并上 `providerCapabilities` 声明的适配器默认能力）。`vision` 决定 media 能否选它做识别模型，以及 `vision.delivery=auto` 时是否向它直通原图。推断不准时用 `modelCapabilities` 逐模型覆盖；每行按**最后一个**冒号切分模型 id 与能力段，带冒号的 id（如经 Ollama `/v1` 接入的 `qwen3:8b`）照原样写即可
