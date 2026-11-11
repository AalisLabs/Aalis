# plugin-llm-deepseek — DeepSeek LLM 服务

**包名**: `@aalis/plugin-llm-deepseek`  
**源码**: `packages/plugin-llm-deepseek/src/index.ts`

## 概述

DeepSeek API 的 LLM 提供者：为每个可用模型实现一个 `LLMModel`（`@aalis/api-llm`）并注册为 `llm` 服务条目，支持流式输出、工具调用、思考模式和图片输入。

## 插件声明

```ts
definePlugin({
  name: '@aalis/plugin-llm-deepseek',
  displayName: 'DeepSeek',
  subsystem: 'llm',
  reusable: true,
  provides: [llm],
  uses: { config, logger, lifecycle, provide, events },
  apply: registerModels,
})
```

无其它服务依赖。每个模型 `provide.use(llm, metered(handle, events.use), { entryId: \`${lifecycle.use.id}/${modelId}\`, label })`：拿到用量的调用发 `llm:usage`（见 [api-llm 的记账](../api/api-llm.md#记账)）。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | 必填 | API Key：DeepSeek API 密钥（secret）。**缺失时 apply 直接抛错，插件转 error 态**——启动不中断，但本插件不提供任何模型 |
| `baseUrl` | string | `'https://api.deepseek.com'` | API 地址：API 端点完整前缀（官方无版本段）；插件只在其后拼 /chat/completions 与 /models |
| `customModels` | textarea | `''` | 自定义模型：手动添加的模型名称（每行一个或逗号分隔）。用于补充自动发现列表中未出现的模型。与自动发现重复时会提示去重。 |
| `discoverModels` | boolean | `true` | 自动发现模型：启动时向服务查询可用模型。服务不提供模型列表时关闭，这时只用自定义模型，且必须填写。 |
| `modelCapabilities` | textarea | `''` | 单模型能力覆盖：逐个模型指定能力。写了的模型不再按名字推断，能力为这里写的加上适配器默认能力。 格式：`&lt;modelId&gt;: &lt;cap1&gt;,&lt;cap2&gt;,...`，每行一条。如：deepseek-flash: chat,tool_calling,streaming,thinking,vision 可用能力：chat / tool_calling / vision / streaming / thinking 等。 |
| `providerCapabilities` | string | `''` | 适配器默认能力：给所有模型额外加上的能力，逗号分隔。例：chat,tool_calling,streaming |
| `timeout` | number | `120` | 停顿超时（秒）：多久收不到新的生成内容算超时，持续输出（含思考）不算；不流式的请求要在这段时间内收到完整回复。0 为不限。 |
| `temperature` | number | `0.7` | 温度：0-2，越高越随机 |
| `maxTokens` | number | `8192` | 最大 Token：单次回复最大生成 token 数，须为正整数，否则实例转为出错 |
| `contextLength` | number | `131072` | 上下文长度：模型上下文窗口大小 |
| `strictToolCalls` | boolean | `false` | Strict 工具调用：开启后所有工具定义都用 strict 模式，模型给的参数严格符合 JSON Schema。 |
| `forceJsonOutput` | boolean | `false` | 强制 JSON 输出：开启后不带工具的请求要求模型输出 JSON，配合角色卡的输出格式使用。系统提示里须含 json 字样。 |
| `thinking` | select | `'auto'` | 默认思考档位：能思考的模型在请求没指定档位时用这一档，会话设置的「深度思考」优先。自动：开启思考，强度由 DeepSeek 在高与最高之间选。 |

## 特性

- **思考档位**: 能力里有 `thinking` 的模型（按名字推断的 v4、reasoner 等，或单模型能力覆盖里写了 `thinking` 的）声明关、高、自动、最高四档（`off`、`high`、`auto`、`max`），默认档取实例配置 `thinking`；请求带了档位按请求，没带按默认档，带了别的档位拒绝。档位翻成请求体字段：

  | 档位 | `thinking.type` | `reasoning_effort` | `temperature` |
  |---|---|---|---|
  | `off` | `disabled` | 不发 | 发 |
  | `high` | `enabled` | `high` | 不发 |
  | `auto` | `enabled` | 不发 | 不发 |
  | `max` | `enabled` | `max` | 不发 |

  不能思考的模型不声明档位，一律按 `off` 发（v4 系列不发 `thinking` 会保持开启）。思考内容在非流式响应中通过 `reasoningContent` 返回，在流式响应中通过 `reasoningDelta` 逐段返回
- **Strict 工具调用**: 启用 `strictToolCalls` 后，每个工具定义的 `function` 字段带上 `strict: true`；关闭时沿用各工具自身声明的 `strict`（参考 api-docs.deepseek.com）
- **强制 JSON 输出**: 启用 `forceJsonOutput` 后，不带工具的请求携带 `response_format: {type:"json_object"}`，配合角色卡的 `outputFormat` 可提升格式遵循率；带工具的请求不加（`json_object` 与工具调用互斥，工具调用走 `tool_calls` 字段）。system prompt 里须含 json 字样，启用 `outputFormat` 的角色卡自动满足
- **SSE 流式解析**: `chatStream()` 解析 SSE 事件流，累积 tool_calls delta
- **漏进正文的工具调用标记**: 服务端没解析出工具调用时，模型的工具调用标记（DSML）会漏进 `content`。插件只剥离、不当调用执行，工具调用只取服务端给的，并记一条 warn：流式在检测到标记起始后不再交出之后的正文，只剩标记之前的文字（可能为空）；非流式去掉标记块，其余正文照留
- **模型发现**: 启动时 `fetchRemoteModelIds()` 请求 `/models` 获取远端模型列表（停用或停机时中止），与 `customModels` 合并后为每个模型注册一个独立的 `llm` 服务条目。发现失败（不可达、超时、非 2xx、响应不是 JSON 或不是模型列表）时记一条 warn（带 URL 与原因），只注册 `customModels`；一个模型都没有（发现失败且未配置 `customModels`，或已连接但列表为空）时实例转为出错，错误信息先写怎么修（检查 `apiKey`、`baseUrl` 与网络，或在 `customModels` 里写明要用的模型），再写原因。网关不提供 `/models` 时关闭 `discoverModels`：不发发现请求、不记 warn，只注册 `customModels`（此时必填，留空时实例转为出错并点名该字段）
- **超时**: `timeout` 按停顿计，规则见 [api-llm 的生成请求的超时](../api/api-llm.md#生成请求的超时)。算作新内容的是 `content`（含为防 DSML 泄漏暂不交出的）、`reasoning_content` 与工具调用的名字和参数；超时报「DeepSeek 请求超时：\<timeout> 秒内没有收到新的生成内容，可在配置里调大 timeout」。对话请求经插件自己的连接池发出：没有 Node 自带 fetch 等响应头与读响应体各 300 秒的默认时限，也不走全局 dispatcher，经 `NODE_USE_ENV_PROXY` 或 `setGlobalDispatcher` 配的代理对它不起作用
- **错误信息**: 对话请求失败时的错误信息会经 agent 发回会话，只写状态码与原因：非 2xx 时写状态码，401/403、402、404、429、5xx 各加一句提示（密钥无效或没有权限、余额不足或需要付费、模型或地址不对、请求过多或额度不足、上游服务故障），并附上游 JSON 里的说明（`error.message`、`error` 字符串或顶层 `message`，折成一行后截断）；取不到说明（如 HTML 错误页）时写「详情见日志」。超时、连不上、插件已停用或重载（停用或重载之后还拿着旧句柄发的请求，不发出）各一句；对话请求另接本插件这次激活的中止信号，停用或重载时在飞的请求（调用方没中止）随之停下，报插件已停用或重载、这次请求中途停下，不记 warn；非流式请求的应答是 200 但不是 JSON 时写明。响应体与底层原因（如 `connect ECONNREFUSED <地址>`）只记 warn 日志，响应体先把换行与连续空白折叠成一个空格，再截断到 500 个字符（按代理对安全截断）。模型发现失败的原因带响应体摘录（同样折叠与截断）
- **`baseUrl` 校验**: 带用户名或密码（`user:pass@`）、带查询串或片段（`?` 或 `#` 之后的部分）或解析不了的 `baseUrl` 在读配置时报配置错误，实例转为出错、不发请求，错误信息不带 URL；密钥填在 `apiKey`。带凭据的 URL 本就发不出请求（fetch 拒绝），凭据还会出现在报错与 WebUI 的模型下拉里；插件在 `baseUrl` 后面拼路径，带查询串或片段时拼出来的地址是坏的
- **能力覆盖**: `modelCapabilities` 每行按**最后一个**冒号切分模型 id 与能力段，`baseUrl` 指向兼容网关时带冒号的模型 id（如 `qwen3:8b`）照原样写即可。模型的最终能力是 `providerCapabilities` 与它自己的能力（覆盖或按名字推断）的并集
- **图片输入**: 带图的 user 消息编成文字之后的 `image_url` 段。DeepSeek 只收 user 消息里的图，工具结果里的图由 `prepareLLMMessages` 挪到这段工具应答之后的一条 user 消息上。插件不按模型名推断 `vision`：要让能看图的模型（如 `deepseek-flash`）看图，在 `modelCapabilities` 里写上它的完整能力并带 `vision`，例如 `deepseek-flash: chat,tool_calling,streaming,thinking,vision`（这一行覆盖推断，漏写的能力就没有了）。`vision` 决定 media 能否选它做识别模型，以及它做主模型时能不能亲眼看图
- **system 位置归一化**: DeepSeek 把请求里所有 system 消息提升到上下文最前部，排在历史之后的每轮材料会让历史的前缀缓存失效。出口因此把首个非 system 消息之后的 system 消息改为 `user`，一律补 `[系统提示]` 标记（自带 `[系统通知]` 这类标记的也补），空内容保持原样。本轮指令块豁免：`metadata.injector` 属于 `DIRECTIVE_KINDS`（workflow 代发的任务、宿主通知、空闲开话题的提示）的消息保持 system，改成 user 会被模型当成真实用户在指挥。代价是它们渲染时被提到上下文最前部、离决策点远；这类回合低频，牺牲该轮缓存（见[消息到 LLM 的处理流水线](../concepts/message-llm-pipeline.md) §9）

## 配置校验

`baseUrl` 和 `apiKey` 的显式无效值会使实例进入错误态；地址格式、查询串与片段及 URL 内的用户名、密码在模型发现前校验。缺省地址仍用官方端点。其余数字、布尔字段按 schema 解析，错误类型回落默认值并告警。
