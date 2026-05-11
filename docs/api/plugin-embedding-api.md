# plugin-embedding-api — 文本向量化契约

**包名**: `@aalis/plugin-embedding-api`  
**源码**: `packages/plugin-embedding-api/src/index.ts`  
**实现**: `@aalis/plugin-embedding-openai`, `@aalis/plugin-embedding-ollama`

## 概述

最小化的 Embedding 服务契约：把一段文本转成 `number[]` 向量。被 vector memory / 语义搜索 / RAG 等场景消费。

## 服务接口

```ts
interface EmbeddingService {
  /** 将文本转为向量 */
  embed(text: string): Promise<number[]>;
  /** 列出远端可用模型（用于前端下拉框） */
  listModels?(): Promise<string[]>;
}
```

## 获取方式

```ts
const embedding = ctx.getService<EmbeddingService>('embedding');
if (!embedding) return; // 未启用任何 embedding 插件时不可用
const vec = await embedding.embed('the quick brown fox');
```

依赖声明：

```ts
export const inject = { required: ['embedding'] };
```

## 注意事项

- 向量维度由具体 provider 决定（如 OpenAI text-embedding-3-small = 1536；ollama nomic-embed-text = 768）。**消费方应避免假设维度**——`plugin-memory-vector` 会在初始化时 probe 一次并存为元数据。
- 多个 embedding 实现互斥：同一时间只能有一个绑定到 `embedding` 服务名（通过 contextId 区分多实例）。

## 实现者

- [@aalis/plugin-embedding-openai](../plugins/plugin-embedding-openai.md)
- [@aalis/plugin-embedding-ollama](../plugins/plugin-embedding-ollama.md)

## 相关

- 消费方：[plugin-memory-vector](../plugins/plugin-memory-vector.md) 与 [plugin-vectorstore-*](./plugin-vectorstore-api.md)
