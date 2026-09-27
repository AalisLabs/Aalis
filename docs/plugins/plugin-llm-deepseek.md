# plugin-llm-deepseek — DeepSeek LLM 服务

**包名**: `@aalis/plugin-llm-deepseek`  
**源码**: `packages/plugin-llm-deepseek/src/index.ts`

## 概述

DeepSeek API 的 LLM 提供者：为每个可用模型实现一个 `LLMModel`（`@aalis/api-llm`）并注册为 `llm` 服务条目，支持流式输出、工具调用和思考模式。

## 插件声明

```ts
definePlugin({
  name: '@aalis/plugin-llm-deepseek',
  displayName: 'DeepSeek',
  subsystem: 'llm',
  reusable: true,
  provides: [llm],
  uses: { provide, lifecycle, logger, config },
  apply: registerModels,
})
```

无其它服务依赖。每个模型 `provide(llm, handle, { entryId: \`${lifecycle.id}/${modelId}\`, label })`。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | 必填 | API Key：DeepSeek API 密钥（secret）。**缺失时 apply 直接抛错，插件转 error 态**——启动不中断，但本插件不提供任何模型 |
| `baseUrl` | string | `'https://api.deepseek.com'` | API 地址：API 端点完整前缀（官方无版本段）；插件只在其后拼 /chat/completions 与 /models |
| `customModels` | textarea | `''` | 自定义模型：手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。 |
| `discoverModels` | boolean | `true` | 自动发现模型：启动时请求 /models 发现可用模型。网关不提供 /models 时关闭：不发发现请求，只注册 customModels（此时必填）。 |
| `modelCapabilities` | textarea | `''` | 单模型能力覆盖：按行指定某个模型的能力集。有该模型的表项时**覆盖**插件启发式推断，与 adapter 默认能力仍取并集。 格式：`&lt;modelId&gt;: &lt;cap1&gt;,&lt;cap2&gt;,...`，每行一条。如：deepseek-chat: chat,tool_calling,streaming |
| `providerCapabilities` | string | `''` | 适配器默认能力（逗号分隔）：为本适配器下所有模型额外补充的能力。最终某模型的能力 = 此处能力 ∪ 模型级别能力。例：chat,tool_calling,streaming |
| `timeout` | number | `120` | 请求超时 (秒)：LLM 请求超时时间（秒）。思考模式下建议 180-300 秒。0 = 不限制。 |
| `temperature` | number | `0.7` | 温度：0-2，越高越随机 |
| `maxTokens` | number | `8192` | 最大 Token：单次回复最大生成 token 数 |
| `contextLength` | number | `131072` | 上下文长度：模型上下文窗口大小 |
| `strictToolCalls` | boolean | `false` | Strict 工具调用：启用后所有工具调用将使用 strict 模式，模型输出严格遵循 JSON Schema（参考 api-docs.deepseek.com） |
| `forceJsonOutput` | boolean | `false` | 强制 JSON 输出：启用后所有最终回复请求将携带 response_format: {type:"json_object"}，配合角色卡 outputFormat 使用可提升格式遵循率。工具调用阶段不受影响（工具响应走 tool_calls 字段）。需确保 system prompt 中含有 json 字样（启用 outputFormat 的角色卡会自动满足此条件）。 |
| `thinkingMode` | select | `'auto'` | 思考模式：控制深度思考。auto 模式下，仅 thinking-capable 模型（v4 / reasoner 等）默认启用思考。enabled/disabled 会覆盖所有模型。 |
| `reasoningEffort` | select | `'auto'` | 推理强度：思考模式下的推理强度（v4 模型）。「自动」不发送参数，API 会为普通请求选 high、为 Agent 复杂场景选 max，推荐。 |

## 特性

- **思考模式**: 由 `thinkingMode` 按模型决定——`auto` 下仅能力集含 `thinking` 的模型启用，`enabled` / `disabled` 覆盖所有模型；请求自带 `think` 时以其为准。启用时请求体附加 `thinking: { type: 'enabled' }`，`reasoningEffort` 非 `auto` 时同时发送 `reasoning_effort`；关闭时显式发送 `thinking: { type: 'disabled' }`。思考内容在非流式响应中通过 `reasoningContent` 返回，在流式响应中通过 `reasoningDelta` 逐段返回
- **Strict 工具调用**: 启用 `strictToolCalls` 后，每个工具定义的 `function` 字段带上 `strict: true`；关闭时沿用各工具自身声明的 `strict`
- **SSE 流式解析**: `chatStream()` 解析 SSE 事件流，累积 tool_calls delta
- **模型发现**: 启动时 `fetchRemoteModelIds()` 请求 `/models` 获取远端模型列表（停用或停机时中止），与 `customModels` 合并后为每个模型注册一个独立的 `llm` 服务条目。发现失败（不可达、超时、非 2xx、响应不是 JSON 或不是模型列表）时记一条 warn（带 URL 与原因），只注册 `customModels`；一个模型都没有（发现失败且未配置 `customModels`，或已连接但列表为空）时实例转为出错，错误信息写明原因。网关不提供 `/models` 时关闭 `discoverModels`：不发发现请求、不记 warn，只注册 `customModels`（此时必填，留空时实例转为出错并点名该字段）
- **错误信息**: 对话请求失败时的错误信息会经 agent 发回会话，只写状态码与原因：非 2xx 时写状态码，401/403、402、404、429、5xx 各加一句提示（密钥无效或没有权限、余额不足或需要付费、模型或地址不对、请求过多或额度不足、上游服务故障），并附上游 JSON 里的说明（`error.message`、`error` 字符串或顶层 `message`，折成一行后截断）；取不到说明（如 HTML 错误页）时写「详情见日志」。超时与连不上各一句；非流式请求的应答是 200 但不是 JSON 时写明。响应体与底层原因（如 `connect ECONNREFUSED <地址>`）只记 warn 日志，响应体先把换行与连续空白折叠成一个空格，再截断到 500 个字符（按代理对安全截断）。内容审查类错误按完整响应体识别，给固定提示。模型发现失败的原因带响应体摘录（同样折叠与截断）；这段原因与启动日志里的 URL 去掉查询串
- **`baseUrl` 校验**: 带用户名或密码（`user:pass@`）或解析不了的 `baseUrl` 在读配置时报配置错误，实例转为出错、不发请求，错误信息不带 URL；密钥填在 `apiKey`。带凭据的 URL 本就发不出请求（fetch 拒绝），凭据还会出现在报错与 WebUI 的模型下拉里
- **能力覆盖**: `modelCapabilities` 每行按**最后一个**冒号切分模型 id 与能力段，`baseUrl` 指向兼容网关时带冒号的模型 id（如 `qwen3:8b`）照原样写即可
