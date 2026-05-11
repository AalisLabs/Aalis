# plugin-vectorstore-api — 向量数据库契约

**包名**: `@aalis/plugin-vectorstore-api`  
**源码**: `packages/plugin-vectorstore-api/src/index.ts`  
**实现**: `@aalis/plugin-vectorstore-flat`, `@aalis/plugin-vectorstore-lancedb`

## 概述

最小化的向量数据库服务契约：存向量、查最近邻、按 metadata 过滤删除。常被 `plugin-memory-vector` 消费做语义历史检索。

## 关键类型

```ts
interface VectorSearchResult {
  score: number;                              // 余弦相似度
  metadata: Record<string, unknown>;
}

interface VectorStoreService {
  add(vector: number[], metadata: Record<string, unknown>): Promise<void>;
  search(queryVector: number[], topK: number): Promise<VectorSearchResult[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
  deleteByFilter?(filter: Record<string, unknown>): Promise<number>;
  save(): Promise<void>;
}
```

## 典型用法

```ts
const embedding = ctx.getService<EmbeddingService>('embedding');
const vs = ctx.getService<VectorStoreService>('vectorstore');
if (!embedding || !vs) return;

const vec = await embedding.embed('查询内容');
const hits = await vs.search(vec, 5);
for (const { score, metadata } of hits) {
  console.log(score, metadata.sessionId, metadata.text);
}
```

## 维度一致性

向量维度由配套的 `embedding` 服务决定。**vectorstore 实现不强校验维度**——调用方应保证 `embedding.embed()` 与历史写入向量来自同一模型。`plugin-memory-vector` 启动时会 probe 维度并存为元数据。

## 持久化

- `flat` —— 进程内 + 启动时全量加载 JSON / 关停时 `save()` 落盘
- `lancedb` —— LanceDB 列存，每次 `add` 即可见

## 实现者

- [@aalis/plugin-vectorstore-flat](../plugins/plugin-vectorstore-flat.md) — 简单 in-memory + 文件，适合小规模
- [@aalis/plugin-vectorstore-lancedb](../plugins/plugin-vectorstore-lancedb.md) — 适合大规模 / 多元数据过滤

## 相关

- 消费方：[plugin-memory-vector](../plugins/plugin-memory-vector.md)
- 配套 embedding：[plugin-embedding-api](./plugin-embedding-api.md)
