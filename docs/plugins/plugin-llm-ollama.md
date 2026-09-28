# plugin-llm-ollama — Ollama 本地模型 LLM

**包名**: `@aalis/plugin-llm-ollama`  
**源码**: `packages/plugin-llm-ollama/src/index.ts`

## 概述

Ollama 本地模型 LLM 服务提供者，通过 Ollama REST API 连接本地运行的模型。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-llm-ollama',
  provides: [llm],
  uses: {
    config,
    logger,
    lifecycle,
    provide,
    proc: optional(processService),
  },
  apply(caps) { /* 见源码 */ },
});
```

每个发现的模型单独注册为一条 `llm` 服务条目，能力按模型解析，优先级从高到低：`modelCapabilities` 覆盖、Ollama `/api/show` 探测结果、内置模型家族表、`providerCapabilities` 兜底。

`/api/show` 探测到能力但其中没有对话能力的模型（如只报 `embedding` 的嵌入模型）不注册条目，不会出现在 `/model` 与 WebUI 的模型列表里；确需注册可用 `modelCapabilities` 显式声明能力。

`modelCapabilities` 每行按**最后一个**冒号切分模型 id 与能力段——Ollama 模型 id 自带 tag（`qwen3:8b`、`bge-m3:latest`），带 tag 的 id 照原样写即可（`bge-m3:latest: chat,streaming`）。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `'http://localhost:11434'` | Ollama 地址：本地 Ollama 服务的 HTTP 地址 |
| `customModels` | textarea | `''` | 自定义模型：手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。 |
| `discoverModels` | boolean | `true` | 自动发现模型：启动时请求 /api/tags 发现已安装的模型，WebUI 可刷新模型列表。服务不提供 /api/tags 时关闭：不发发现请求，只注册 customModels（此时必填），也不支持刷新。 |
| `modelCapabilities` | textarea | `''` | 单模型能力覆盖：强制覆盖某模型的能力(优先级最高,高于 /api/show 自动探测与家族表),与 adapter 默认能力取并集。 格式：`&lt;modelId&gt;: &lt;cap1&gt;,&lt;cap2&gt;,...`，每行一条。如：nemotron3:33b: chat,vision,tool_calling |
| `providerCapabilities` | string | `''` | 适配器默认能力（逗号分隔）：兜底默认能力:仅当某模型既无法从 Ollama /api/show 探测、又不在内置家族表时才使用。能力现已自动探测,通常留空即可（填了反而可能给不支持的模型乱标能力）。例：chat,tool_calling,streaming |
| `timeout` | number | `120` | 请求超时 (秒)：LLM 请求超时时间（秒）。大模型或长上下文建议适当调大。0 = 不限制。 |
| `temperature` | number | `0.7` | 温度：0-2，越高越随机 |
| `maxTokens` | number | `4096` | 最大 Token：单次回复最大生成 token 数（num_predict） |
| `contextLength` | number | `8192` | 上下文长度：模型上下文窗口大小（num_ctx） |
| `keepAlive` | string | `'5m'` | 模型保活时间：模型在显存中保留的时间，如 5m、1h、0（立即卸载） |
| `thinking` | boolean | `true` | 启用思考：为支持思考的模型启用扩展思考（think 参数）。无 thinking 能力的模型该参数无效。 |

## 工作方式

1. 对话请求走 Ollama 原生 `/api/chat` 端点；消息含音频输入时改走 OpenAI 兼容的 `/v1/chat/completions`（原生 `/api/chat` 不支持音频）
2. 支持流式输出：`/api/chat` 以换行分隔的 JSON（NDJSON）逐块返回；带音频的请求不走流式，整段结果作为单个块交付
3. 启动时经 `/api/tags` 发现已安装模型，与 `customModels` 合并后注册（发现与能力探测在停用或停机时中止）；发现失败（不可达、超时、非 2xx、响应不是 JSON 或不是模型列表）时记一条 warn（带 URL 与原因），只注册 `customModels`。没有可注册的模型（发现失败且未配置 `customModels`，已连接但没有已安装的模型，或模型都是非对话模型）时实例转为出错，错误信息写明原因。之后可经模型条目的 `refresh`（由 WebUI 触发）重新发现，按差异增删条目，无需重启插件；发现失败时刷新报错（消息带 URL 与原因），停用或停机时进行中的刷新随之中止并报错，这两种情况都不增删条目
4. 服务不提供 `/api/tags`（如只转发对话接口的反向代理）时关闭 `discoverModels`：启动时不发发现请求、不记 warn，只注册 `customModels`（此时必填，留空时实例转为出错并点名该字段），能力照常经 `/api/show` 探测；模型条目不提供 `refresh`，WebUI 的「刷新」会提示该 provider 不支持运行时刷新
5. 对话请求失败时的错误信息会经 agent 发回会话，只写状态码与原因：非 2xx 时写状态码，401/403、402、404、429、5xx 各加一句提示（密钥无效或没有权限、余额不足或需要付费、模型或地址不对、请求过多或额度不足、上游服务故障），并附上游 JSON 里的说明（`error.message`、`error` 字符串或顶层 `message`，折成一行后截断）；取不到说明（如 HTML 错误页）时写「详情见日志」。超时与连不上各一句；非流式请求（带音频的请求一律走非流式）的应答是 200 但不是 JSON 时写明。响应体与底层原因（如 `connect ECONNREFUSED <地址>`）只记 warn 日志，响应体先把换行与连续空白折叠成一个空格，再截断到 500 个字符（按代理对安全截断）。音频路径的 `unknown format` 诊断按完整响应体判断，另起一行附在错误信息后。模型发现失败的原因带响应体摘录（同样折叠与截断）；这段原因与启动日志里的 URL 去掉查询串
6. 带用户名或密码（`user:pass@`）或解析不了的 `baseUrl` 在读配置时报配置错误，实例转为出错、不发请求，错误信息不带 URL。插件不支持带凭据访问 Ollama：带凭据的 URL 本就发不出请求（fetch 拒绝），凭据还会出现在报错与 WebUI 的模型下拉里

## 配置校验

`baseUrl` 的显式无效值会使实例进入错误态；地址格式及 URL 内的用户名、密码在模型发现前校验。`keepAlive` 中不加引号的有限数字会转为字符串（例如 `0` 变为 `"0"`）；`timeout` 的 0 或负数仍表示不限时。
