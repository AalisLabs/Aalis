# bounded-map（有界 Map）

> 受众：编写 / 维护 Aalis 第三方插件的开发者。
> 这是一个 **util 包**——纯函数、零服务、不碰 `ctx`、不进 DI 容器。你在 `package.json` 里**依赖**它，然后直接 `import` 函数用。不要去 `ctx.getService('bounded-map')`（它根本不在容器里）。util 包的统一约定见 [清单元数据 → util 关键词](../concepts/manifest-metadata.md)。

## 1. 一句话定位

`@aalis/util-bounded-map` 给你一个**带上限护栏的 Map**：必填 `max` 限制条目数（超限逐出最久未访问的，即 LRU），可选 `ttlMs` 做**滑动过期**，可选 `onEvict` 在条目离场时回调释放资源。它治理的是「裸 `Map` 当进程内缓存、只增不清 → 长跑泄漏」这一类问题（`packages/util-bounded-map/src/index.ts:1-9`）。

包名 `@aalis/util-bounded-map`，MIT，无运行时依赖（`packages/util-bounded-map/package.json:1-9`）。

---

## 2. 导出 API

### `BoundedMapOptions<K, V>`（`index.ts:11-18`）

```ts
interface BoundedMapOptions<K, V> {
  /** 最多保留的条目数（必填）。超出时逐出"最久未访问"的条目。 */
  max: number;
  /** 可选滑动 TTL（毫秒）：每次 get/set 刷新过期时刻；过期条目在 get/values 时惰性逐出。 */
  ttlMs?: number;
  /** 可选：条目被逐出（超限/过期/delete/clear）时回调，用于释放底层资源（如句柄）。 */
  onEvict?: (value: V, key: K) => void;
}
```

- `max`：**必填正数**。非正数或非有限值会在 `createBoundedMap` 直接抛错（`index.ts:36-38`）。
- `ttlMs`：**不传则永不过期**（内部 `expireAt` 记为 `+Infinity`，`index.ts:65`）。传了就是**滑动 TTL**——`get`/`set` 命中都会把过期时刻刷新到 `Date.now() + ttlMs`（`index.ts:58`、`index.ts:65`），不是固定寿命。
- `onEvict(value, key)`：**任何**离场路径都会触发——超限逐出、TTL 过期、`delete`、`clear`，统一经内部 `evict`/`clear` 调用（`index.ts:43-46`、`index.ts:83`）。

### `BoundedMap<K, V>`（`index.ts:20-28`）

```ts
interface BoundedMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
  /** 当前未过期条目的值（顺带惰性清理过期项）。 */
  values(): V[];
  readonly size: number;
}
```

| 方法 | 语义 | 关键行为 |
| --- | --- | --- |
| `get(key)` | 取值；命中返回值，缺失/已过期返回 `undefined`（`index.ts:49-61`） | 命中时把条目**移到队尾**（LRU 标记为最近）并刷新 TTL；过期则当场逐出并返回 `undefined` |
| `set(key, value)` | 写入/覆盖 | 已存在则先删再写（移到队尾，`index.ts:64`）；写完若 `size > max` 循环逐出**队首**（最久未访问），直到不超限（`index.ts:67-72`） |
| `delete(key)` | 删除单条 | 命中触发 `onEvict`，返回 `true`；不存在返回 `false`（`index.ts:75-80`） |
| `clear()` | 清空 | 逐条触发 `onEvict` 后清空（`index.ts:82-85`） |
| `values()` | 当前未过期值数组 | 遍历时**惰性逐出**过期项，只返回存活值（`index.ts:87-94`） |
| `size` | 当前条目数（getter） | 直接读底层 `Map.size`，**不剔除已过期项**——见第 5 节坑点（`index.ts:96-98`） |

### `createBoundedMap<K, V>(opts): BoundedMap<K, V>`（`index.ts:34`）

工厂函数，唯一导出的运行时入口。

---

## 3. 用法示例

```ts
import { createBoundedMap } from '@aalis/util-bounded-map';

// 最多 1000 条，24h 滑动 TTL，无 onEvict
const cache = createBoundedMap<string, string>({
  max: 1000,
  ttlMs: 24 * 60 * 60 * 1000,
});

cache.set('img://a.png', '一只橘猫趴在键盘上');
const desc = cache.get('img://a.png'); // 命中 → 刷新这条的 TTL，移到队尾
console.log(cache.get('miss') ?? null); // 缺失 → undefined → null

// 持有外部句柄时，用 onEvict 释放
const handles = createBoundedMap<string, FileHandle>({
  max: 50,
  ttlMs: 30 * 60 * 1000,
  onEvict: handle => handle.close(), // 超限/过期/delete/clear 都会调
});
```

在 `package.json` 里声明依赖（util 包用普通版本号，不用 `workspace:`）：

```json
{ "dependencies": { "@aalis/util-bounded-map": "^0.5.0" } }
```

---

## 4. 谁在用（codebase 内真实消费点）

- **图片描述缓存** `packages/plugin-media/src/cache.ts:14`
  `createBoundedMap<string, string>({ max: 1000, ttlMs: 24h })`，key 是 url / data uri / 本地路径，value 是 vision 识别结果。同一张图在聊天 + `analyze_image` + 引用消息里复用，避免重复识别（`cache.ts:1-7`）。注意它在 `set` 前先过滤空串与 `[图片: ...]` 占位符——**不可缓存的值在入口处挡掉，而不是依赖 Map**（`cache.ts:17-21`）。

- **文档会话管理** `packages/plugin-office/src/session.ts:21`
  `createBoundedMap<string, DocSession>({ max: 50, ttlMs: 30min })`。value 持有 docx/ExcelJS/pptx 等底层文档对象。活跃文档（持续 `add → get`）因滑动 TTL 不会被逐出；只清理「创建后 30min 未操作」的废弃会话（`session.ts:18-21`）。`require()` 取不到时抛「已过期请重新 create」的提示（`session.ts:53-55`），插件卸载时 `clear()` 释放全部（`session.ts:43-46`）。

- **Prompt 预算快照** `packages/plugin-prompt-budget/src/index.ts:32`
  `createBoundedMap<string, TokenUsage>({ max: 500, ttlMs: 6h })`，按 `sessionId` 缓存最近一次 `token:usage` 事件。注释点明了用它的理由——「派生只读，逐出后 AI 重查即重算；有界防长跑泄漏」（`index.ts:31-32`、`index.ts:36`）。

三处都没有用 `onEvict`（值都是可丢的派生数据）；plugin-office 持有重对象但靠 GC 回收，未显式释放。

---

## 5. 边界与坑

- **只配派生 / 可重算 / 可丢的缓存**。源码开篇即划线：权威状态（丢了会改变行为的）不要塞进来——它随时可能被逐出（`index.ts:8`）。三个消费点全是「丢了重算/重查」的场景，这是正确用法的范本。
- **没有后台 sweeper**，过期是**惰性**的：只在 `get` / `values` 触碰时才逐出过期项（`index.ts:5-6`、`index.ts:52`、`index.ts:90`）。作者刻意不开定时清理（「sweeper 自身会成泄漏源」）。后果——
  - `size` 读的是底层 `Map.size`，**会把尚未被触碰的过期条目算进去**（`index.ts:96-98`）。别拿 `size` 当「有效条目数」断言。要精确数活的就用 `values().length`（它会先惰性清理）。
  - 一个写满即不再读取的 key 会一直占位，直到下次 `set` 触发超限逐出或有人 `get`/`values`。所以 `max` 仍是真正的内存护栏，TTL 只是「热度衰减」。
- **TTL 是滑动的，不是固定寿命**：频繁访问的条目永不过期。若你要的是「绝对过期」（写入 N 毫秒后无条件失效），这个包给不了——它每次 `get`/`set` 都续命。
- **LRU 基于插入序模拟**：底层 `Map` 保持插入序，`get`/`set` 命中即「删了重插」把条目顶到队尾，故队首恒为最冷条目，超限逐出队首即真 LRU（`index.ts:30-33`、`index.ts:57-59`、`index.ts:68`）。这是 O(1) 操作，无需额外链表。
- **`onEvict` 覆盖所有离场路径**，包括你主动的 `delete` 和 `clear`。如果回调里做「释放句柄」，注意 `clear()` 会对每条都调一次（`index.ts:83`）——这是预期行为，但回调必须幂等/可重入安全。
- **进程内、非持久**：纯内存结构，进程重启即空。需要跨重启留存请走存储服务，见交叉链接。
- **审计相关**：缓存 value 可能含敏感派生数据（如 plugin-media 缓存的图片描述文本）。util 本身不做脱敏——出站到 LLM / 外部的内容审计由调用方与管线负责，见 [安全模型](../concepts/security-model.md) 与 [消息 / LLM 管线](../concepts/message-llm-pipeline.md)。

### 什么时候用它，什么时候用裸 `Map`

| 用 `createBoundedMap` | 用裸 `Map` |
| --- | --- |
| 长跑进程里的瞬态缓存，需要上限护栏防泄漏 | 生命周期受控、规模天然有界（如一次请求内的临时索引、键集合固定） |
| 需要 TTL 自动让条目衰减 | 永久映射，全程必须保留 |
| 缓存项是派生 / 可重算 / 可丢的 | 权威状态，丢失会改变行为 |
| 需要逐出时释放底层资源（`onEvict`） | 值无需清理 |

一句话决策：**「这个 Map 会不会随运行无限增长？」** 答是 → 给它 `max`；答否 → 裸 `Map` 即可，别引依赖。

---

## 6. 交叉链接

- 概念 · [清单元数据](../concepts/manifest-metadata.md)——util 包靠 `aalis-util` 关键词识别、为何不进 DI 容器。
- 概念 · [服务模型](../concepts/service-model.md)——对照：服务走 `ctx.provide`/`getService`，util 走 `package.json` 依赖 + 直接 import。
- 概念 · [安全模型](../concepts/security-model.md) / [消息 · LLM 管线](../concepts/message-llm-pipeline.md)——缓存内容出站时的审计边界。
- 消费范例源码：`packages/plugin-media/src/cache.ts`、`packages/plugin-office/src/session.ts`、`packages/plugin-prompt-budget/src/index.ts`。
