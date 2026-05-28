# LLM 输出文本修复分层设计

## 背景

LLM API 响应存在两类常见的"脏输出"问题，需要在不同的系统层级处理：

1. **协议层泄漏**：模型将本应走专用通道的内部标记（如 DeepSeek DSML tool_call 标记）错误地输出到 `content` 字段，导致结构化信息丢失或裸标记出现在用户侧
2. **渲染层错误**：模型输出的 Markdown 存在格式错误（如 GFM 表格分隔行列数与表头不一致），导致 remark-gfm、KaTeX 等渲染器解析失败

这两类问题的性质不同，修复位置和策略也应不同。

---

## 责任分层

```
┌──────────────────────────────────────────────────┐
│  plugin-agent                                    │
│  finalContent = normalizeAssistantContent(...)   │  ← 渲染层修复 + 通用兜底
└────────────────────┬─────────────────────────────┘
                     │ ChatResponse { content, toolCalls }
┌────────────────────▼─────────────────────────────┐
│  plugin-deepseek / plugin-openai / ...           │
│  （LLM 适配器）                                   │  ← 协议层修复（厂商特定）
└────────────────────┬─────────────────────────────┘
                     │ SSE / HTTP
┌────────────────────▼─────────────────────────────┐
│  DeepSeek / OpenAI / Ollama API                  │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  plugin-webui-client                             │
│  preprocessLaTeX → fixGfmTables(...)             │  ← 也在前端跑一遍渲染修复
└──────────────────────────────────────────────────┘
```

### 层 1：LLM 适配器（`plugin-deepseek` 等）

**职责**：处理本厂商专有协议的"协议层泄漏"。

- 检测泄漏 → 尝试将泄漏内容恢复为有效 `ToolCall[]`（best-effort）
- 将 `content` 中的标记残渣剥离干净
- 对外暴露的 `ChatResponse` 中，`content` 已是干净文本，`toolCalls` 已是恢复后的结构化数据

**不做的事**：
- 不做 GFM 修复（与厂商无关，不是适配器关心的事）
- 不发明自己的剥离 regex（直接复用 `@aalis/util-text-normalize` 的 `stripLeakedSpecialTokens`）

### 层 2：`util-text-normalize`（`@aalis/util-text-normalize`）

**职责**：提供无副作用的纯函数文本处理工具集，供适配器层、agent 层、webui 层复用。

| 函数 | 用途 | 设计约束 |
|---|---|---|
| `stripLeakedSpecialTokens` | 剥离 DSML 等泄漏的特殊 token 标记（`[｜\|]+ ... DSML ...` 等） | 不返回 ToolCall[]；不 import 业务类型 |
| `fixGfmTables` | 修复 GFM 表格分隔行与表头列数不一致 | 跳过代码块，仅修正明确错误 |
| `normalizeAssistantContent` | 两者的组合应用 | 顺序：先剥标记，再修表格 |

**设计约束**：该包不能依赖 `@aalis/plugin-message-api` 等业务包，以便在 webui 客户端（browser bundle）中也能使用。返回类型只能是 `string` 或 `{ string, boolean }`。

### 层 3：`plugin-agent`

**职责**：在拿到 `ChatResponse` 后，统一调 `normalizeAssistantContent` 做最终渲染修复。这是对**所有** LLM provider 通用的兜底层。

- 适配器层已处理过协议泄漏的情况下，`stripLeakedSpecialTokens` 是 no-op
- 对未实现内部修复的适配器（如某个简单的第三方兼容层），这里仍能剥除已知格式的标记残渣
- `fixGfmTables` 在这里统一修复 Markdown 渲染问题

### 层 4：`plugin-webui-client`（前端）

**职责**：在客户端渲染前再跑一次 `fixGfmTables`，处理流式增量拼接过程中可能产生的中间状态碎片（agent 层在完整响应上修过一次，但 WebSocket 推流的每个增量 chunk 不一定完整）。

---

## DeepSeek DSML 泄漏的完整处理流程

### 背景

DeepSeek V3.2/V4 使用 DSML (DeepSeek Markup Language) 表达 tool_calls：

```
<｜DSML｜tool_calls>
  <｜DSML｜invoke name="web_search">
    <｜DSML｜parameter name="query" string="true">keyword</｜DSML｜parameter>
  </｜DSML｜invoke>
</｜DSML｜tool_calls>
```

（`｜` 为 U+FF5C 全角竖线）

已知 bug：模型偶发输出**双竖线变体** `<｜｜DSML｜｜...>`，服务端严格匹配失败，整段泄漏到 `content`，`tool_calls` 字段为空。

### 流式路径（`chatStream()`）

```
chunk 到来
  │
  ├─ accContent += delta.content
  │
  ├─ [｜|]+ 检测到 DSML 起始 → dsmlDetected = true
  │   ├─ 输出 DSML 之前的 cleanPart（如有）
  │   └─ 后续 chunk 只累积 accContent，不 emit
  │
  └─ [DONE 或流意外结束]
      ├─ dsmlDetected && toolCalls.length === 0
      │   └─ parseDsmlToolCalls(accContent) → ToolCall[]   ← 从原始泄漏文本恢复
      └─ yield { done: true, toolCalls: [...] }

agent 收到：
  content  = DSML 之前的文本（干净）
  toolCalls = 恢复的工具调用

normalizeAssistantContent(content) → stripLeakedSpecialTokens = no-op，fixGfmTables 生效
```

**跨帧缓冲（`pendingTail`）**：检测到 `<` 或 `<｜...`（可能是 DSML 起始的前缀）时，暂存到下一帧再判，避免半截特殊 token 已被 emit 后无法收回。

### 非流式路径（`chat()`）

```
API 响应 JSON
  choices[0].message.content  = "前缀文本<｜[｜]DSML[｜]｜...>..."  ← 泄漏
  choices[0].message.tool_calls = []                                ← 服务端解析失败

  │
  ├─ stripLeakedSpecialTokens(content)
  │   ├─ hadLeak = true
  │   └─ sanitized = "前缀文本"                ← 剥离后的干净文本
  │
  ├─ [!hasServerToolCalls]
  │   └─ parseDsmlToolCalls(原始 content)      ← 注意：在 content = sanitized 赋值前调用
  │       └─ recoveredToolCalls = ToolCall[]   ← 从原始泄漏文本恢复
  │
  └─ result.content  = sanitized              ← 干净文本
     result.toolCalls = recoveredToolCalls    ← 恢复的工具调用

agent 收到：
  content  = sanitized（DSML 已剥离）
  toolCalls = 恢复的工具调用

normalizeAssistantContent(content) → stripLeakedSpecialTokens = no-op，fixGfmTables 生效
```

### 关键：两条路径传给 agent 的是什么版本？

| 字段 | 传的版本 | 原因 |
|---|---|---|
| `content` | **修复后**（DSML 已剥离） | 不应把含 DSML 的脏文本暴露给上层 |
| `toolCalls` | 从**修复前**的原始泄漏内容解析恢复 | 需要完整的 DSML 结构才能提取 invoke/parameter |

因此 agent 层的 `stripLeakedSpecialTokens` 对 deepseek 在正常处理后是 **no-op**，仅作为对其他 provider 或异常 fallthrough 的通用兜底。

---

## 各包依赖关系

```
plugin-agent
  └── @aalis/util-text-normalize  (normalizeAssistantContent, stripLeakedSpecialTokens)

plugin-deepseek
  ├── @aalis/util-text-normalize  (stripLeakedSpecialTokens)
  └── ./dsml-parser               (parseDsmlToolCalls → ToolCall[])

plugin-webui-client
  └── @aalis/util-text-normalize  (fixGfmTables)

util-text-normalize
  └── （无业务依赖）
```

`dsml-parser` 依赖 `@aalis/plugin-message-api`（`ToolCall` 类型），**不能**放入 `util-text-normalize`，这是唯一的隔离边界。

---

## 未来扩展指南

**新增 LLM provider 有类似的特殊 token 泄漏**（如 Qwen `<|im_tool_call|>`、Llama `<|python_tag|>`）：

1. **能否恢复结构化数据**（解析为 ToolCall[]）：在对应的 `plugin-xxx` 适配器内实现，不放 util
2. **剥离文本**：扩展 `util-text-normalize` 的 `stripLeakedSpecialTokens` 中的 regex，不要新建 `stripQwenTokens` 等并列函数，避免调用方认知碎片化
3. **GFM / 渲染修复**：直接加进 `normalizeAssistantContent` 的处理链

**扩展 util-text-normalize 时的约束**：
- 只接受/返回 `string`，不引入业务包类型
- 所有函数必须是纯函数，无副作用，可在 Node.js 和 browser 环境运行
- 跳过 fenced code block（` ``` ` 内）和 inline code（`` ` `` 内）以避免误改代码示例
