# json-repair

> 受众：写「让 LLM 按 JSON 格式回话、再把回话解析成结构化对象」的第三方插件作者（人设输出格式、信息抽取、状态持久化等）。
> 本文讲清如何从一坨脏乱的模型输出里把**一个 JSON 对象**捞出来、并尽力修复常见格式错误。
>
> 全部断言以代码为准并标注 `file:line`。包名 `@aalis/util-json-repair`，源码全在 `packages/util-json-repair/src/index.ts`。

---

## 1. 定位

LLM 被要求输出 JSON 时，实际产出经常带毛病：包了 ` ```json ` 代码块、前后夹了一段自然语言解释、字符串里写了没转义的英文引号、被 `max_tokens` 截断少了结尾的 `}`、尾部多了逗号。直接 `JSON.parse` 必炸。

`@aalis/util-json-repair` 把这些修复策略集中到一处，按「由轻到重」依次尝试，直到 `JSON.parse` 成功或全部用尽（`index.ts:14-48`、`253-261`）。它是一个**纯函数工具库**（`aalis-util` keyword，无 `ctx`、无 DI，见 `package.json` 的 `"aalis": { "util": true }`）——插件在 `package.json` 里依赖它、直接 `import` 函数即可。

> **最重要的边界（先记住）**：本库只解析**顶层 JSON 对象** `{...}`。顶层是 JSON **数组** `[...]` 的输出会被判为失败（返回 `null`）。详见 §5。

---

## 2. 导出 API

三个函数 + 一个结果类型。三者递进：`extractJsonCandidate`（提取子串）→ `tryParseJsonObject`（容错解析）→ `parseLLMJsonObject`（两步合一）。

### 2.1 `RepairResult`

```ts
export interface RepairResult {
  /** 解析得到的对象；解析全部失败时为 null。 */
  parsed: Record<string, unknown> | null;
  /** 命中的修复步骤名称（按顺序累积）。直接解析成功则为空数组。 */
  repairsApplied: string[];
}
```

`index.ts:227-232`。`parsed` 永远是「非空对象、非数组、非原始值」或 `null`，二选一；`repairsApplied` 让你能在日志里看到到底动了哪些修复（调试模型输出质量很有用）。

### 2.2 `extractJsonCandidate(raw: string): string`

`index.ts:182-225`。从模型原始输出里**提取 JSON 子串**，不做解析。行为：

1. 去掉 ` ```json ` / ` ``` ` 围栏（`index.ts:186-189`）。
2. 扫描所有**顶层** `{`，取**最后一个**「括号配平且含 `:`」的对象（`index.ts:198-217`）。
   - 取最后一个：模型常先输出推理/自由文本、最后才吐 JSON payload。
   - 必须含 `:`：排除数学集合写法 `{1,2,3}` 这类无 `key:value` 的伪对象（`index.ts:205`）。
   - 只扫顶层：找到配平对象后跳到其末尾之后，不把嵌套的内层 `{}` 当候选（`index.ts:209-210`）。
3. 无合格候选时**降级**：从第一个 `{` 取配平片段，配不平则直接截到末尾（留给后续修复步骤补 `}`，见 `index.ts:220-224`）。

返回的是字符串（可能仍不是合法 JSON），交给 `tryParseJsonObject` 收尾。

### 2.3 `tryParseJsonObject(jsonStr: string): RepairResult`

`index.ts:238-262`。对**已经是 JSON 子串**的文本做**容错解析**：

1. 先按原文 `JSON.parse`；成功且是对象则直接返回，`repairsApplied: []`（`index.ts:248-249`）。
2. 失败则依次叠加修复策略（`index.ts:14-48`），每命中一个就重试一次解析：
   - **字符串内部裸引号转义**（`index.ts:20-21`、`96-138`）：状态机识别字符串里没转义的 `"`，例如 `"message": "他说"你好"然后走了"`。
   - **XML 属性引号转义**（`index.ts:23-28`）：把 `<face id="14"/>` 这类标签属性里的引号转义。
   - **移除尾部多余逗号**（`index.ts:30-31`）：`{...,}` → `{...}`。
   - **补全缺失的 `}` 与 `]`**（`index.ts:33-47`）：截断少括号时，在字符串外统计缺口并补齐（先补 `]` 再补 `}`）。
3. 全部用尽仍失败 → `parsed: null`（`index.ts:261`）。

关键约束：`tryParse` 内部显式拒绝数组与原始值——只有 `typeof obj === 'object' && !Array.isArray(obj)` 才算成功（`index.ts:242`）。

### 2.4 `parseLLMJsonObject(raw: string): RepairResult`

`index.ts:268-270`。一站式入口，等价于 `tryParseJsonObject(extractJsonCandidate(raw))`。**绝大多数插件直接用这个**：传入模型原始 `content`，拿回 `RepairResult`。

---

## 3. 用法示例

```ts
import { parseLLMJsonObject } from '@aalis/util-json-repair';

const raw = await model.chat(/* ... */); // 模型可能输出 ```json{...}``` + 一段解释
const { parsed, repairsApplied } = parseLLMJsonObject(typeof raw.content === 'string' ? raw.content : '');

if (!parsed) {
  ctx.logger.warn('LLM 输出无法解析为 JSON 对象');
  return;
}
if (repairsApplied.length > 0) {
  ctx.logger.debug(`JSON 自动修复成功：${repairsApplied.join(' → ')}`);
}
// parsed 此时一定是 Record<string, unknown>
const reply = typeof parsed.response === 'string' ? parsed.response : '';
```

若你已经自己剥过围栏、只想做容错解析，跳过提取直接用 `tryParseJsonObject(jsonStr)` 即可。

---

## 4. 谁在用（真实消费点）

依赖声明：`plugin-persona` / `plugin-user-profile` / `plugin-user-relation` 三个插件的 `package.json` 都依赖本包。

- **`@aalis/plugin-persona`** —— 保留了一个 re-export 兼容壳 `src/json-repair.ts:1-5`（老代码走相对 import，新代码应直接 import 本包）。实际用法在 `src/index.ts`：
  - `src/index.ts:674` 无 `outputFormat` 时，用 `tryParseJsonObject` 自动解包模型误用 JSON 包裹的回复，逐个尝试 `response`/`reply`/`content` 等字段（`index.ts:674-684`）。
  - `src/index.ts:715-718` 有 `outputFormat` 时，`extractJsonCandidate` + `tryParseJsonObject` 结构化解析，并把 `repairsApplied` 写进 debug 日志。
- **`@aalis/plugin-user-profile`** —— `src/index.ts:8` import `parseLLMJsonObject`，在 `src/index.ts:978`、`1439`、`1649` 三处解析画像抽取结果。其中 `978-1006` 是范本：首解析失败后**带显式反馈重试一次**（提示模型「第一个字符必须是 `{`」），仍失败才放弃本批次。
- **`@aalis/plugin-user-relation`** —— `src/extractor.ts:25` import，`src/extractor.ts:1596` 的 `parseExtraction` 用 `parseLLMJsonObject` 解析图谱抽取结果。注意它把所有 `persons`/`events`/`edges` 等**数组都包在一个顶层对象里**（`extractor.ts:1600-1611`），所以能用本库——这正是「对象内可以有数组、但顶层不能是数组」的正面示范。

---

## 5. 边界与坑

### 5.1 顶层只认对象，不认数组（最重要）

`tryParseJsonObject` 把顶层数组视为解析失败：`!Array.isArray(obj)` 直接把数组结果归零成 `null`（`index.ts:242`）。原始值（字符串/数字/`true`/`null`）同样返回 `null`。

这不是疏漏，是设计取舍：本库面向「让模型回一个结构化对象」的主流场景，且 §2.2 的提取逻辑全程围绕 `{` 配平展开（`index.ts:198-217`），对 `[...]` 无能为力。

**反例 / 为什么有插件不复用本库**：`@aalis/plugin-user-relation` 的实体层级推断把模型 prompt 成「只输出 JSON **数组**」（`consolidate-llm.ts:366`），因此它**自己维护了一个独立解析器** `tryParseJson`（`consolidate-llm.ts:471-489`，返回 `unknown`），并在 `consolidate-llm.ts:376-377` 用 `Array.isArray(parsed)` 校验。如果硬塞给 `parseLLMJsonObject`，会直接拿到 `null`。

> 经验法则：**需要顶层数组 → 不要用本库**，自己 `JSON.parse` 或包一层对象（`{ "items": [...] }`）。其余顶层对象场景一律走 `parseLLMJsonObject`。

### 5.2 修复是「尽力而为」，不是保证正确

- 修复策略基于启发式（裸引号闭合判断靠「下一个非空白字符像不像 JSON 分隔符」，见 `index.ts:85-94`）。极端嵌套或对抗性输入下，补出来的对象可能在语法上合法、语义上却错位。**拿到 `parsed` 后务必按你的 schema 校验字段类型**（参考 persona 的 `persistStateFromParsed` 按 `fieldType` 强转，`index.ts:691-708`）。
- `repairsApplied` 非空意味着模型这次输出不规范。建议像消费者那样落 debug/warn 日志，长期可作为「该调 prompt 了」的信号。

### 5.3 与 `@aalis/util-text-normalize` 的分工

`util-text-normalize/src/index.ts:12-13` 明确划界：**本库**处理「被 prompt 要求输出 JSON 的 LLM 响应」的解析问题；`util-text-normalize` 处理的是另一类文本归一化问题。要解析模型 JSON 用本库，不要混用。

### 5.4 解析失败时不要静默丢数据

`parsed === null` 是常态而非异常（模型偶发跑偏）。好的处理：带反馈重试一次（user-profile `index.ts:982-999` 范本），仍失败再降级/放弃，并 warn 出原文前若干字便于排查——不要直接吞掉。

---

## 6. 交叉链接

- [消息 → LLM 管线](../concepts/message-llm-pipeline.md) —— 模型 `content` 从哪来、`Message`/`ContentSegment` 形态；本库消费的就是这里产出的字符串内容。
- [服务模型](../concepts/service-model.md) —— util 与 service 的区别：util 是零服务纯函数库（直接 import），不经 DI。
- [Manifest 元数据](../concepts/manifest-metadata.md) —— `aalis-util` keyword / `aalis.util` 标记的语义。
