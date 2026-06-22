# text-normalize

> 受众：写 LLM provider 插件、写「会把 assistant 回复渲染/转发出去」插件、或写自定义前端渲染器的第三方作者。
> 本文讲清如何在「LLM 返回的自然语言 content 落到用户眼前之前」做最后一道净化：修复 LLM 常写错的 GFM 表格、剥离泄漏到正文的特殊 token 残渣。
>
> 全部断言以代码为准并标注 `file:line`。源码：`packages/util-text-normalize/src/index.ts`。

---

## 1. 一句话定位

`@aalis/util-text-normalize` 是一个**纯函数、零服务**的文本净化库：把 LLM 输出的 assistant `content` 在**展示/发送前**统一过一遍，修复下游 Markdown 渲染器（remark-gfm / KaTeX 等）会卡住的明确错误，并剥离漏到正文里的内部协议 token（如 DeepSeek 的 DSML 标记）。

它带 `aalis-util` 关键词（`package.json` keywords），是 **util 库**——没有 `ctx`、不参与 DI、不注册服务。第三方插件的用法是：在 `package.json` 里依赖它，然后直接 `import` 函数调用（见 §3）。

设计原则（`index.ts:7-11`）：

- 纯函数、无副作用；可在 agent 端、webui 端、其它前端**复用同一份逻辑**。
- 只修复**明确错误**的格式问题，不做风格改写。
- 自动跳过代码块（```` ``` ```` 与 inline `` ` ``）以避免误改示例代码。

与同生态的 `@aalis/util-json-repair` 的边界（`index.ts:12-16`）：json-repair 处理「被 prompt 要求输出 JSON 的结构化数据通道」的解析问题；本库处理「自然语言对话 `content`」的渲染层问题，约定在 agent 拿到完整响应后**统一调用一次**。

---

## 2. 导出 API

库导出三个函数（其余 `countGfmCols` / `normalizeSepRow` / `isSeparatorRow` 为内部 helper，**未导出**）。

### 2.1 `fixGfmTables(content: string): string`

签名：`packages/util-text-normalize/src/index.ts:86`

修复 **GFM 表格分隔行与表头列数不一致**的问题。

背景（`index.ts:62-65`）：`micromark-extension-gfm-table` v2 严格要求「表头列数 === 分隔行列数」，否则整个表格退化为纯文本——用户在 UI 上看到的是裸露的 `|...|...|` 字符串。LLM 经常多打或少打一个 `|`：

```text
| A | B |          ← 表头 2 列
|:--|:--|:--|      ← 分隔行 3 列（多打一个 |）
| x | y |
```

修复后分隔行被归一为 2 列：`|:--|:--|`。

行为要点：

- **双向修复**（`index.ts:48-49`、`normalizeSepRow`）：分隔行列数多 → 截断；少 → 补 `---`。
- **保留对齐符号**：归一时只保留合法对齐段 `:?-+:?`（`:--` / `--:` / `:--:`），过滤掉空段（`index.ts:44-47`）。
- **跳过代码区域**：先按 ```` ``` ```` fenced block 与 inline `` ` `` 拆分，奇数索引片段原样保留（`index.ts:89-92`），避免改坏示例代码里的伪表格。
- **保守触发**：仅当上一行包含 `|` 且非空、且两侧列数都 > 0 且**确实不等**时才动手（`index.ts:97-105`）；否则原样输出。
- 空串直接返回（`index.ts:87`）。

### 2.2 `stripLeakedSpecialTokens(content: string): { sanitized: string; hadLeak: boolean }`

签名：`packages/util-text-normalize/src/index.ts:151-154`

剥离 LLM 输出 `content` 里**泄漏的「特殊 token 标记」残渣**。返回净化后的文本 + 一个 `hadLeak` 布尔（供调用方告警/遥测，`index.ts:149`）。

适用范围（`index.ts:117-119`）：任何「服务端用 `<…特殊字符…keyword…特殊字符…>` 形式的 special token 表达内部协议，但解析器偶发匹配失败、导致裸标记落到 `content`」的场景。当前已知典型 case 是 **DeepSeek 的 DSML**（DeepSeek Markup Language，用于表达 `tool_calls`，`index.ts:121-129`）。已知 bug 是模型会输出畸形变体（多一对全角竖线 `<｜｜DSML｜｜…>`，`｜` 为 U+FF5C），让按 `｜DSML｜` 严格匹配的服务端 parser 失败，整段裸文本留在 `content` 里（`index.ts:132-136`）。

三层剥离策略（按顺序，`index.ts:163-180`）：

1. **整段成对 block**：`<…DSML…>…</…DSML…>`，lazy 匹配到最近闭合（`blockRe`，`index.ts:164`）。
2. **残留单 token**：跨 chunk 边界泄漏的开/闭标签碎片（`tokenRe`，`index.ts:170`）。
3. **极端兜底**：未闭合的 DSML 起始片段（缺末尾 `>`，如 `<｜｜DSML｜｜tool_calls`，`partialRe`，`index.ts:176`）。

关键约束：

- **不反解为 tool_calls**（`index.ts:142`）：本函数只剥离文本，绝不尝试把 DSML 解析回 tool_call——避免触发未授权副作用，且畸形变体解析风险大。需要恢复 tool_call 是**调用方的责任**（DeepSeek 插件的做法见 §4）。
- **廉价早出 + 防 ReDoS**（`index.ts:156-158`）：先 `content.includes('DSML')`，无该字面量直接原样返回。这同时把「无 DSML 的病理输入（如海量竖线）」挡在正则外，杜绝灾难性回溯——旧实现 5000 个竖线即冻进程。正则本身改成线性（每标签内单个 `[^<>]*` + 零宽 lookahead，`index.ts:161-162`），消除回溯爆炸。
- 仅当确实发生剥离时才对结果 `trim()`（`index.ts:181`）；无泄漏时 `sanitized === content` 原样。
- 命名刻意**不带厂商前缀**（`index.ts:144-147`）：未来 Qwen 漏 `<|im_xxx|>`、Llama 漏 `<|python_tag|>` 等同类问题，应**扩展本函数的 regex**，而非新开 `stripQwenTokens` 等并列函数。注意：当前三条 regex 都靠 `DSML` 字面量驱动，扩展其它 token 时这些断言需要相应放宽。

### 2.3 `normalizeAssistantContent(content: string): string`

签名：`packages/util-text-normalize/src/index.ts:188`

**一次性应用所有净化规则**的便捷入口。顺序固定（`index.ts:186-191`）：**先 `stripLeakedSpecialTokens` 剥离结构性泄漏，再 `fixGfmTables` 修表格**。

顺序很重要：先剥掉 DSML 块再修表格，避免 DSML 标记里的竖线被表格逻辑误判为列分隔。本函数丢弃 `hadLeak`（`index.ts:190` 解构后只取 `sanitized`）——**需要遥测 `hadLeak` 的调用方应自己单独调 `stripLeakedSpecialTokens`**（见 §4 agent 的做法）。空串直接返回（`index.ts:189`）。

---

## 3. 用法示例

最小可运行片段（在你的插件里）：

```ts
import {
  normalizeAssistantContent,
  stripLeakedSpecialTokens,
  fixGfmTables,
} from '@aalis/util-text-normalize';

// A. 最常见：assistant 完整响应净化，一把过
const display = normalizeAssistantContent(llmResponse.content);

// B. 需要告警/遥测时：拆开调，拿到 hadLeak
const { sanitized, hadLeak } = stripLeakedSpecialTokens(llmResponse.content);
if (hadLeak) logger.warn('LLM content 残留特殊 token，已剥离');

// C. 纯前端渲染器：只想修表格，不碰 token
const md = fixGfmTables(rawMarkdown);
```

`package.json` 依赖声明（util 库直接 import，无 DI）：

```json
{
  "dependencies": {
    "@aalis/util-text-normalize": "latest"
  }
}
```

---

## 4. 谁在用（codebase 内真实消费点）

### `plugin-agent`：回合收尾统一净化 + 遥测

`packages/plugin-agent/src/index.ts:16` 导入；在组装最终回复时（`index.ts:264-273`）：先 `stripLeakedSpecialTokens` 拿 `hadLeak` 打 warn 日志（记录 session / platform / 原长 / 净化后长度），再用 `normalizeAssistantContent(content)` 产出 `finalContent`。这是「agent 拿到完整响应后统一调用一次」约定的权威落点——所有走 agent 通道的回复都已净化。

> 注意 `index.ts:267-273` 是**拆开调**的范例：因为既要 `hadLeak` 做遥测，又要全套净化。`normalizeAssistantContent` 内部会再调一次 `stripLeakedSpecialTokens`（幂等、无泄漏时是 no-op），所以这里调两次只是为了取 `hadLeak`，结果正确但有一次冗余扫描——属可接受取舍。

### `plugin-deepseek`：泄漏检测 + 本地恢复 tool_calls

`packages/plugin-deepseek/src/index.ts:8` 导入。非流式分支（`index.ts:299-328`）用 `stripLeakedSpecialTokens` 检测+剥离 DSML 文本（覆盖单/双竖线变体）；若 `hadLeak` 且服务端 `tool_calls` 为空，则调 provider 自己的 `parseDsmlToolCalls(cleanContent)` 本地恢复工具调用（`index.ts:310-315`），避免非流式路径下 tool_call 无声丢失。

> 这正是 §2.2「本函数不反解 tool_call」边界的体现：**剥离归库、恢复归调用方**。`stripLeakedSpecialTokens` 只负责告诉你「漏了」并清掉文本，要不要救 tool_call 由 provider 自己定。

### `plugin-webui-client`：前端渲染预处理复用

`packages/plugin-webui-client/src/preprocessLaTeX.ts:1` 导入 `fixGfmTables`，在 `preprocessLaTeX` 开头先跑一次表格归一（`preprocessLaTeX.ts:14`）。注释说明（`preprocessLaTeX.ts:13`）：agent 侧若已修复则此处等价 no-op，保留是为**兼容历史会话与未走 agent 通道的内容**。这说明同一份纯函数逻辑被「后端 provider/agent」和「前端渲染器」两端复用——正是 util 库存在的意义。

---

## 5. 边界与坑

- **它不是 sanitizer / 不防 XSS**：只修 Markdown 格式 + 剥协议 token，不转义 HTML、不做安全过滤。输出仍是不可信文本，渲染端该做的转义/隔离照做。
- **`fixGfmTables` 只管「表头 vs 分隔行列数」这一种错**：表头列数不会被改，数据行列数也不碰；表格因别的原因（缺空行、嵌套等）渲染失败它管不了。
- **`stripLeakedSpecialTokens` 当前强绑 `DSML` 字面量**：`index.ts:158` 的早出和三条 regex 的 lookahead 都要求出现 `DSML`；要支持其它模型的 token 必须改源码放宽断言，而非配置。它**不解析、不恢复** tool_call（§2.2）——恢复是调用方责任。
- **`hadLeak` 是唯一的可观测信号**：`normalizeAssistantContent` 把它丢了。需要审计/告警「LLM 漏了内部协议 token」就别用便捷入口，拆开调 `stripLeakedSpecialTokens`（agent 的做法，§4）。`hadLeak` 适合接日志/遥测，提示上游 prompt 或 provider parser 可能有问题。
- **顺序不可换**：先剥 token 再修表格（`index.ts:190-191`）；自己手动组合时务必保持此序，否则 DSML 里的全角/半角竖线可能干扰表格列数判断。
- **应在「完整响应」上调，而非每个流式 chunk**：DSML block 是跨 chunk 的成对结构，半截 chunk 上调只能命中「单 token / 未闭合片段」兜底，无法正确剥整段。约定是**拿到完整 content 后调一次**。

---

## 6. 交叉链接

- [concepts/message-llm-pipeline](../concepts/message-llm-pipeline.md) — 一条消息从平台流到 LLM 再返回的完整管线；本库是 assistant `content` 出口前的最后一道净化。
- [services/agent](../services/agent.md) — 回合编排引擎，`normalizeAssistantContent` 的权威调用点（回合收尾）。
- [services/llm](../services/llm.md) — LLM provider 契约；provider 插件（如 deepseek）在出口处用本库剥离泄漏 token。
- [services/webui](../services/webui.md) — WebUI 前端渲染层，复用 `fixGfmTables` 做渲染预处理。
