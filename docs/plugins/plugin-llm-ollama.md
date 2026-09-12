# plugin-llm-ollama — Ollama 本地模型 LLM

**包名**: `@aalis/plugin-llm-ollama`  
**源码**: `packages/plugin-llm-ollama/src/index.ts`

## 概述

Ollama 本地模型 LLM 服务提供者，通过 Ollama REST API 连接本地运行的模型。

## 插件声明

```typescript
meta.name = '@aalis/plugin-llm-ollama'
meta.provides = ['llm']
meta.inject = { optional: ['process'] }
```

每个发现的模型单独注册为一条 `llm` 服务条目，能力按模型解析，优先级从高到低：`modelCapabilities` 覆盖、Ollama `/api/show` 探测结果、内置模型家族表、`providerCapabilities` 兜底。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `'http://localhost:11434'` | Ollama 地址：本地 Ollama 服务的 HTTP 地址 |
| `customModels` | textarea | `''` | 自定义模型：手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。 |
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
3. 启动时经 `/api/tags` 发现已安装模型，与 `customModels` 合并后注册；之后可经模型条目的 `refresh`（由 WebUI 触发）重新发现，按差异增删条目，无需重启插件
