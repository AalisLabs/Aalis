# vectorstore 服务

## 1. 定位

向量数据库服务：存放 embedding 向量 + 元数据，提供近邻检索（topK）。它是语义记忆等子系统的「底层向量存储后端」，本身不做 embedding、不懂消息语义——只认 `number[]` 与 `Record<string, unknown>`。

- 服务注册名：`getService('vectorstore')`
- 契约包：`@aalis/plugin-vectorstore-api`（`packages/plugin-vectorstore-api`）
- 内置参考实现：`@aalis/plugin-vectorstore-flat`（零依赖，JSON 文件）、`@aalis/plugin-vectorstore-lancedb`（LanceDB 高性能）

## 2. 契约

`packages/plugin-vectorstore-api/src/index.ts`：

```ts
// VectorSearchResult（index.ts:7-12）
export interface VectorSearchResult {
  /** 余弦相似度分数 */
  score: number;
  /** 存储时附带的元数据 */
  metadata: Record<string, unknown>;
}

// VectorStoreService（index.ts:15-28）
export interface VectorStoreService {
  add(vector: number[], metadata: Record<string, unknown>): Promise<void>;        // :17
  search(queryVector: number[], topK: number): Promise<VectorSearchResult[]>;     // :19
  size(): Promise<number>;                                                        // :21
  clear(): Promise<void>;                                                         // :23
  deleteByFilter?(filter: Record<string, unknown>): Promise<number>;             // :25（可选）
  save(): Promise<void>;                                                          // :27
}
```

类型通过 declaration merging 注入内核映射（`index.ts:31-35`），因此 `getService('vectorstore')` 自动得到 `VectorStoreService` 类型——只要消费者 `import '@aalis/plugin-vectorstore-api'`（哪怕只是触发模块）即可。

方法语义（以契约注释 + 参考实现为准）：

- `add(vector, metadata)`：追加一条向量。注意契约**未规定唯一性/去重**——同向量重复 `add` 会得到多条记录。元数据是后续 `search` 结果与 `deleteByFilter` 的唯一寻址依据。
- `search(queryVector, topK)`：返回**最多** topK 条，按 `score` 降序。`score` 约定为**余弦相似度**（见 §6 跨后端可比性）。
- `size()`：当前向量总数。
- `clear()`：清空全部数据。
- `deleteByFilter?(filter)`：删除「metadata 中 filter 的每个键都精确相等」的条目，返回删除条数。是**可选方法**——消费者调用前必须判存在性（`!!store.deleteByFilter`）。语义是「全部键匹配才删」，flat 与 lancedb 实现一致（flat `index.ts:107-118`、lancedb `index.ts:126-153`）。
- `save()`：持久化。契约把持久化时机交给调用方：消费者在写入后应显式 `save()`（参考实现里 LanceDB 是 no-op，flat 才真正落盘）。

## 3. 谁提供 / 谁消费

提供方（`provides = ['vectorstore']`）：

- `@aalis/plugin-vectorstore-flat`：`FlatVectorStore`，`packages/plugin-vectorstore-flat/src/index.ts:58`，注册于 `:180`（默认 priority）。
- `@aalis/plugin-vectorstore-lancedb`：`LanceDBVectorStore`，`packages/plugin-vectorstore-lancedb/src/index.ts:44`，注册于 `:190`（`{ priority: 10 }`，比 flat 高 → 同时装两个时 lancedb 胜出）。

消费方：

- `@aalis/plugin-memory-vector`（向量记忆，提供 `semantic-memory`）：`packages/plugin-memory-vector/src/index.ts`
  - 声明依赖：`inject.required = ['vectorstore', 'embedding']`（`:17-20`）。
  - 取服务：`ctx.getService<VectorStoreService>('vectorstore')!`（`:251-253`，封装为 `getStore()`，每次用都重取）。
  - 典型调用：索引时 `add` + `save`（`:371-372`）；按会话删 `deleteByFilter`（`:399`、`:442`）；清库 `clear` + `save`（`:434-435`）；检索 `search`（`:493`、`:752`），并对结果做 `score >= minScore` 过滤（`:496`、`:754`）。
- `@aalis/plugin-commands` 仅探测可用性：`ctx.hasService('vectorstore')`（`packages/plugin-commands/src/index.ts:252`）。

## 4. 写一个 provider

最小必须实现（契约非可选方法）：`add`、`search`、`size`、`clear`、`save`。可选：`deleteByFilter`（不实现则消费者会跳过按会话删除）。

双源元数据必须同步声明（manifest 与导出都要写，见 docs/concepts/manifest-metadata.md）：

- `package.json` 的 `aalis.service.provides`（参考 `packages/plugin-vectorstore-flat/package.json`）：

```jsonc
{
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": { "service": { "provides": ["vectorstore"] } }
}
```

- 入口导出 `export const provides = ['vectorstore'];`

可编译最小骨架：

```ts
import type { Context } from '@aalis/core';
import type { VectorSearchResult, VectorStoreService } from '@aalis/plugin-vectorstore-api';

export const name = '@aalis/plugin-vectorstore-mine';
export const provides = ['vectorstore'];

class MyVectorStore implements VectorStoreService {
  private rows: Array<{ vector: number[]; metadata: Record<string, unknown> }> = [];

  async add(vector: number[], metadata: Record<string, unknown>): Promise<void> {
    this.rows.push({ vector, metadata });
  }

  async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
    // 务必返回「余弦相似度」语义的 score（见 §6），否则跨后端阈值不可比
    const scored = this.rows.map(r => ({ score: cosine(queryVector, r.vector), metadata: r.metadata }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.min(topK, scored.length));
  }

  async size(): Promise<number> { return this.rows.length; }
  async clear(): Promise<void> { this.rows = []; }
  // 可选：实现「全部键匹配才删」语义并返回删除数
  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter(r => Object.entries(filter).some(([k, v]) => r.metadata[k] !== v));
    return before - this.rows.length;
  }
  async save(): Promise<void> { /* 落盘；如后端自动持久化则 no-op */ }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.NEGATIVE_INFINITY; // 维度不匹配：见 §6/§7
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export async function apply(ctx: Context): Promise<void> {
  const store = new MyVectorStore();
  ctx.provide('vectorstore', store);          // 默认 priority=Backend(0)；想抢占已有后端用 { priority: 10 } 之类
  ctx.onDispose(() => void store.save());      // dispose 兜底落盘
}
```

注册细节：

- `ctx.provide('vectorstore', store, opts?)`。`opts.priority` 建议用 `ServicePriority` 枚举（`Backend=0/Override=50/System=200`，见 `packages/core/src/service-helpers.ts:62`）；lancedb 用了裸数字 `10` 表「优先于 flat 默认」。同名竞争胜者顺序：**preference > priority > 注册顺序**（DI 仅按名，无能力匹配，见 docs/concepts/service-model.md）。
- 存储路径用 storage URI（如 `data:/vectorstore`），经 `toStorageUri()` 归一；需要本地真实路径（LanceDB 这类原生库）用 `createStorageGateway(ctx).resolveLocalPath(uri, 'write')`，且要先判该方法存在（lancedb `index.ts:178-182`）。注意：vectorstore 自身不是单 owner 上下文里的「按会话隔离」资源，隔离靠消费者写进 metadata 的字段（见 §6）。

## 5. 标准消费姿势

```ts
export const inject = { required: ['vectorstore'] }; // 或放 optional 软依赖
import '@aalis/plugin-vectorstore-api';              // 触发类型增强

export async function apply(ctx: Context) {
  // 不要缓存句柄：provider 可能因热替换 bounce 失效——每次用都重取（见 docs/concepts/lazy-service-access.md）
  const store = () => ctx.getService<VectorStoreService>('vectorstore');

  // 软依赖：缺失时优雅降级
  const s = store();
  if (!s) { ctx.logger.warn('无 vectorstore，语义检索关闭'); return; }

  await s.add(vec, { sessionId, timestamp: Date.now() });
  await s.save();                                    // 写后显式持久化

  const topK = 5;
  // 先取宽候选再过阈值，避免阈值把 topK 提前耗光（memory-vector 取 topK*4 候选，:486/:752）
  const candidates = await s.search(queryVec, Math.min(topK * 4, await s.size()));
  const hits = candidates.filter(c => c.score >= minScore);

  // deleteByFilter 是可选方法，调用前判存在
  if (s.deleteByFilter) await s.deleteByFilter({ sessionId });
}
```

错误边界：`search` 在空库返回 `[]`（flat `:121`、lancedb `:92/:95`）。`getService` 用 `required` inject 时框架会保证就绪，`!` 断言安全；用 `optional` 则必须判 `undefined`。

## 6. 跨后端可比性、风险与隔离

- **score 必须是余弦相似度语义**。flat 用归一化点积（真余弦，`:43-49`/`:97`/`:120-122`）；lancedb 显式用 `distanceType('cosine')` 后取 `1 - _distance`（`index.ts:100-104`），与 flat 量纲对齐。**provider 若返回别的度量（如 1 − L2、内积未归一），会破坏消费者跨后端通用的阈值** ——`memory-vector` 的 `minScore`（0~1）与时间加权融合（`search.timeWeight`）都假设 score 是余弦相似度。换后端不应要求用户重调阈值。
- **跨会话/隔离不在本服务**。Aalis 是单 owner，但向量库会混装所有会话的数据；隔离由消费者写入 metadata（如 `{ sessionId }`）并用 `deleteByFilter`/检索过滤实现。provider 不得擅自基于 metadata 做可见性裁剪——它不懂业务语义。
- 本服务不涉及 authority risk/visibility 标注、确认（session-confirm）、SSRF（safeFetch）——它不直接对外发请求，也不暴露危险动作。涉及落盘的安全边界归 storage（storage **不是沙箱**，见 docs/concepts/security-model.md / storage-uri-grammar.md）。LanceDB 的 `resolveLocalPath` 把绝对路径交给原生库，仍受 storage root 授权约束，但绕过了 storage 的 URI 边界——provider 应只用它指向自有数据目录。

## 7. 边界与坑

- **跨后端 score 不严格等价（审计项）**。lancedb 取 `1 - _distance`（cosine 距离 → 相似度），与 flat 的归一化点积理论一致；但两后端浮点路径、归一化时机不同，**绝对分值在边界处可能有微小差异**，迁移后端后命中集合可能轻微漂移。早期 lancedb 曾用默认 L2（`1 - L2` 既非相似度也与 flat 不可比），现已改为显式 cosine（见 `:97-100` 注释）——若你看到旧库/旧版本表现异常，先确认 `distanceType('cosine')` 生效。
- **维度不匹配**（换了 embedding 模型却复用旧库）：
  - flat：`dotProduct` 对长度不等返回 `Number.NEGATIVE_INFINITY`（`:35-37`），不匹配项被排到末尾并被下游 `minScore` 过滤，**不会读越界产 NaN、不会静默清空**；并一次性告警提示清库重建（`:124-130`）。注：审计早期记录的「flat dim-mismatch 产 NaN」已修复为 `-Infinity`。自研 provider 应照此处理（骨架里的 `cosine` 已对齐）。
  - lancedb：维度由表 schema 固定，写入不同维向量会由 LanceDB 自身报错。
- **flat 并发写竞态（已加固）**：索引默认 `concurrency=10` 会并发 `save()`，裸 `writeFile` 同路径并发写可能交错损坏 JSON、致下次 `init` 解析失败而整库清空。flat 用 `saveChain` 串行化所有写（`:65-66`/`:141-146`/`:148-159`），失败重标脏下次重试。自研「文件型」provider 必须同样串行化持久化。
- **flat 全量内存 + 全量重写**：所有向量常驻内存、每次 save 整库 `JSON.stringify` 落盘——大规模数据用 lancedb。
- **lancedb 建表 single-flight**：并发首批 `add` 复用同一建表 promise，避免「table already exists」吞掉向量（`:47-48`/`:76-89`）；`clear()` 必须同步重置 `tableInit`（`:118`），否则下次 `add` 会 await 到指向已删表的旧 promise 而崩。
- **lancedb `deleteByFilter` 是全表重建**：扫全表→过滤→drop→重建表（`:130-153`），删除成本随库大小线性增长，频繁按会话删会昂贵。

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名、priority/preference 胜出）、[lazy-service-access](../concepts/lazy-service-access.md)（每次重取、不缓存句柄）、[manifest-metadata](../concepts/manifest-metadata.md)（provides 双源）、[storage-uri-grammar](../concepts/storage-uri-grammar.md)、[security-model](../concepts/security-model.md)（storage 非沙箱）。
- 内核：[core/service](../core/service.md)、[core/context](../core/context.md)、[core/plugin.md](../core/plugin.md)。
- 相关契约/服务：`@aalis/plugin-storage-api`（落盘后端，[api/plugin-storage-api](../api/plugin-storage-api.md)）、`@aalis/plugin-embedding-api`（产生 `queryVector`，[api/plugin-embedding-api](../api/plugin-embedding-api.md)）、消费方 `@aalis/plugin-memory-vector`（semantic-memory）。
