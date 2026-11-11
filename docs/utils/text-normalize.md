# text-normalize

> 受众：写 LLM provider 插件、写「会把 assistant 回复渲染/转发出去」插件、或写自定义前端渲染器的第三方作者。
> 本文讲清两样净化：渲染端修复 LLM 常写错的 GFM 表格（只改显示），拿到完整回复的一方剥离泄漏到正文的特殊 token 残渣。
>
> 全部断言以代码为准并标注 `file:line`。源码：`packages/util-text-normalize/src/index.ts`。

---

## 1. 定位

`@aalis/util-text-normalize` 是一个**纯函数、零服务**的文本净化库：渲染端用它修复下游 Markdown 渲染器（remark-gfm / KaTeX 等）会卡住的明确错误，只改显示、不动存下的原文；拿到完整回复的一方用它剥离漏到正文里的内部协议 token（如 DeepSeek 的 DSML 标记）。

它带 `aalis-util` 关键词（`package.json` keywords），是 **util 库**——不经服务容器、不参与 DI、不注册服务。第三方插件的用法是：在 `package.json` 里依赖它，然后直接 `import` 函数调用（见 §3）。

设计原则（`index.ts`）：

- 纯函数、无副作用；可在 agent 端、webui 端、其它前端**复用同一份逻辑**。
- 只修复**明确错误**的格式问题，不做风格改写。
- 自动跳过代码块（```` ``` ```` 与 inline `` ` ``）以避免误改示例代码。

与同生态的 `@aalis/util-json-repair` 的边界（`index.ts`）：json-repair 处理「被 prompt 要求输出 JSON 的结构化数据通道」的解析问题；本库处理「自然语言对话 `content`」的渲染与协议残渣问题。

---

## 2. 导出 API

模块共导出四个函数。本文覆盖其中两个净化函数——`fixGfmTables` / `stripLeakedSpecialTokens`。另两个 `truncateChars` / `toWellFormedText` 处理的是「LLM 请求边界的孤代理（lone surrogate）安全」，属另一议题，本文不展开——参见各自 JSDoc 与 [message-llm-pipeline](../concepts/message-llm-pipeline.md)。`countGfmCols` / `normalizeSepRow` / `isSeparatorRow` 为内部 helper，**未导出**。

### 2.1 `fixGfmTables(content: string): string`

签名：`packages/util-text-normalize/src/index.ts`

修复 **GFM 表格分隔行与表头列数不一致**的问题。

背景（`index.ts`）：`micromark-extension-gfm-table` v2 严格要求「表头列数 === 分隔行列数」，否则整个表格退化为纯文本——用户在 UI 上看到的是裸露的 `|...|...|` 字符串。LLM 经常多打或少打一个 `|`：

```text
| A | B |          ← 表头 2 列
|:--|:--|:--|      ← 分隔行 3 列（多打一个 |）
| x | y |
```

修复后分隔行被归一为 2 列：`|:--|:--|`。

行为要点：

- **双向修复**（`index.ts`、`normalizeSepRow`）：分隔行列数多 → 截断；少 → 补 `---`。
- **保留对齐符号**：归一时只保留合法对齐段 `:?-+:?`（`:--` / `--:` / `:--:`），过滤掉空段（`index.ts`）。
- **跳过代码区域**：先按 ```` ``` ```` fenced block 与 inline `` ` `` 拆分，奇数索引片段原样保留（`index.ts`），避免改坏示例代码里的伪表格。
- **保守触发**：仅当上一行包含 `|` 且非空、且两侧列数都 > 0 且**确实不等**时才动手（`index.ts`）；否则原样输出。
- 空串直接返回（`index.ts`）。

### 2.2 `stripLeakedSpecialTokens(content: string): { sanitized: string; hadLeak: boolean }`

签名：`packages/util-text-normalize/src/index.ts`

剥离 LLM 输出 `content` 里**泄漏的「特殊 token 标记」残渣**。返回净化后的文本 + 一个 `hadLeak` 布尔（供调用方告警/遥测，`index.ts`）。

适用范围（`index.ts`）：任何「服务端用 `<…特殊字符…keyword…特殊字符…>` 形式的 special token 表达内部协议，但解析器偶发匹配失败、导致裸标记落到 `content`」的场景。当前已知典型 case 是 **DeepSeek 的 DSML**（DeepSeek Markup Language，用于表达 `tool_calls`，`index.ts`）。已知 bug 是模型会输出畸形变体（多一对全角竖线 `<｜｜DSML｜｜…>`，`｜` 为 U+FF5C），让按 `｜DSML｜` 严格匹配的服务端 parser 失败，整段裸文本留在 `content` 里（`index.ts`）。

三层剥离策略（按顺序，`index.ts`）：

1. **整段成对 block**：`<…DSML…>…</…DSML…>`，lazy 匹配到最近闭合（`blockRe`，`index.ts`）。
2. **残留单 token**：跨 chunk 边界泄漏的开/闭标签碎片（`tokenRe`，`index.ts`）。
3. **极端兜底**：未闭合的 DSML 起始片段（缺末尾 `>`，如 `<｜｜DSML｜｜tool_calls`，`partialRe`，`index.ts`）。

关键约束：

- **不反解为 tool_calls**（`index.ts`）：本函数只剥离文本，绝不尝试把 DSML 解析回 tool_call——避免触发未授权副作用，且畸形变体解析风险大。
- **廉价早出 + 防 ReDoS**（`index.ts`）：先 `content.includes('DSML')`，无该字面量直接原样返回。这同时把「无 DSML 的病理输入（如海量竖线）」挡在正则外，杜绝灾难性回溯——旧实现 5000 个竖线即冻进程。正则本身改成线性（每标签内单个 `[^<>]*` + 零宽 lookahead，`index.ts`），消除回溯爆炸。
- 仅当确实发生剥离时才对结果 `trim()`（`index.ts`）；无泄漏时 `sanitized === content` 原样。
- 命名刻意**不带厂商前缀**（`index.ts`）：未来 Qwen 漏 `<|im_xxx|>`、Llama 漏 `<|python_tag|>` 等同类问题，应**扩展本函数的 regex**，而非新开 `stripQwenTokens` 等并列函数。注意：当前三条 regex 都靠 `DSML` 字面量驱动，扩展其它 token 时这些断言需要相应放宽。

---

## 3. 用法示例

最小可运行片段（在你的插件里）：

```ts
import { stripLeakedSpecialTokens, fixGfmTables } from '@aalis/util-text-normalize';

// A. 拿到完整回复的一方：剥离泄漏的特殊 token，hadLeak 供告警/遥测
const { sanitized, hadLeak } = stripLeakedSpecialTokens(llmResponse.content);
if (hadLeak) logger.use.warn('LLM content 残留特殊 token，已剥离');

// B. 渲染端：显示前修表格，存下的原文不动
const md = fixGfmTables(rawMarkdown);
```

`package.json` 依赖声明（util 库直接 import，无 DI；x.y.z 写开发时用的版本，写法见[第三方插件开发者指南的「依赖怎么归类」](../guide/third-party-plugin.md#_5-1-类型从哪里-import-依赖怎么归类)）：

```json
{
  "dependencies": {
    "@aalis/util-text-normalize": ">=x.y.z <1.0.0"
  }
}
```

---

## 4. 谁在用（codebase 内真实消费点）

### `plugin-agent`：回合收尾剥离协议标记 + 遥测

`packages/plugin-agent/src/index.ts` 导入；每次模型调用拿到完整回复时（`index.ts`）用 `stripLeakedSpecialTokens` 剥离，`hadLeak` 时打 warn 日志（记录 session / platform / 原长 / 净化后长度）；时间线的正文段过同一个函数，落库的正文与时间线是同一份净化。经 OpenAI 兼容接口接入时，服务端漏进正文的工具调用标记只有这一层会剥：只剥不执行。agent 不修表格，外发与落库的是模型的原文。

### `plugin-llm-deepseek`：泄漏检测 + 剥离

`packages/plugin-llm-deepseek/src/index.ts` 导入。非流式分支（`index.ts`）用 `stripLeakedSpecialTokens` 检测+剥离 DSML 文本（覆盖单/双竖线变体），`hadLeak` 时打 warn 日志（服务端没给 `tool_calls` 时写明这次的工具调用丢了）；工具调用只取服务端给的，漏进正文的标记不当调用执行。

### `plugin-webui-client`：前端渲染预处理复用

`packages/plugin-webui-client/src/markdown/latex.ts` 导入 `fixGfmTables`，在 `preprocessLaTeX` 开头先执行一次表格归一：模型常多打或少打一根竖线，渲染器遇到列数不等会把整张表退成纯文字。只改显示，存下的原文不动；表格只在这里修。

---

## 5. 边界与注意事项

- **它不是 sanitizer / 不防 XSS**：只修 Markdown 格式 + 剥协议 token，不转义 HTML、不做安全过滤。输出仍是不可信文本，渲染端该做的转义/隔离照做。
- **`fixGfmTables` 只管「表头 vs 分隔行列数」这一种错**：表头列数不会被改，数据行列数也不碰；表格因别的原因（缺空行、嵌套等）渲染失败它管不了。
- **`stripLeakedSpecialTokens` 当前强绑 `DSML` 字面量**：`index.ts` 的早出和三条 regex 的 lookahead 都要求出现 `DSML`；要支持其它模型的 token 必须改源码放宽断言，而非配置。
- **应在「完整响应」上调，而非每个流式 chunk**：DSML block 是跨 chunk 的成对结构，半截 chunk 上调只能命中「单 token / 未闭合片段」兜底，无法正确剥整段。约定是**拿到完整 content 后调一次**。

---

## 6. 交叉链接

- [concepts/message-llm-pipeline](../concepts/message-llm-pipeline.md) — 一条消息从平台流到 LLM 再返回的完整管线；本库在 assistant `content` 的出口剥协议标记、在渲染端修表格。
- [services/agent](../services/agent.md) — 回合编排引擎，在完整回复上调 `stripLeakedSpecialTokens`（回合收尾）。
- [services/llm](../services/llm.md) — LLM provider 契约；provider 插件（如 deepseek）在出口处用本库剥离泄漏 token。
- [services/webui](../services/webui.md) — WebUI 前端渲染层，用 `fixGfmTables` 做渲染预处理。
