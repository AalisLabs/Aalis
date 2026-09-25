# api-embedding — 文本向量化契约

**包名**: `@aalis/api-embedding`  
**源码**: `packages/api-embedding/src/index.ts`  
**实现**: `@aalis/plugin-embedding-openai`, `@aalis/plugin-embedding-ollama`

## 概述

最小化的 Embedding 服务契约：把一段文本转成 `number[]` 向量。被 vector memory / 语义搜索 / RAG 等场景消费。描述符 `embedding` 是普通调用型 `ServiceRef<EmbeddingService>`。

## 服务接口

```ts
interface EmbeddingService {
  readonly modelId?: string;
  embed(text: string, options?: { signal?: AbortSignal }): Promise<number[]>;
  listModels?(): Promise<string[]>;
}
```

`modelId` 是可选的向量空间标识：`modelId` 相同的两次 `embed` 结果可以直接比较，换模型必须换值。消费方可把它并入向量缓存的失效键，从而在换模型（包括同维度换模型）后识别并重算旧向量；提供者不声明时，消费方无法区分模型。两个第一方实现分别声明为 `openai:<model>` 与 `ollama:<model>`。

调用方可传入 `options.signal`，在回合取消或检索超时时终止请求。Ollama 和 OpenAI
实现都会将它传至底层 HTTP 请求；调用方取消不触发重试，provider 自身的超时与重试策略仍然生效。

## 获取方式

```ts
import { embedding } from '@aalis/api-embedding';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-embedding',
  uses: { embedding },
  apply({ embedding }) {
    const svc = embedding.current;
    if (!svc) return;
    void svc.embed('the quick brown fox');
  },
});
```

`embedding.current` 每次读取重新解析当前胜者。不要把返回值存进字段：提供者换人后旧引用失效（有失效逻辑则抛，无则静默成功）；关停边不保护缓存引用。

## 注意事项

- 向量维度由具体 provider 决定（如 OpenAI text-embedding-3-small = 1536；ollama nomic-embed-text = 768）。**消费方应避免假设维度**——`plugin-memory-vector` 会在初始化时 probe 一次并存为元数据。
- 多个 embedding 实现互斥：同一时间只有一个胜者绑定到 `embedding` 服务名（通过 instanceId / 偏好区分多实例）。

## 实现者

- [@aalis/plugin-embedding-openai](../plugins/plugin-embedding-openai.md)
- [@aalis/plugin-embedding-ollama](../plugins/plugin-embedding-ollama.md)

## 相关

- 消费方：[plugin-memory-vector](../plugins/plugin-memory-vector.md) 与 [plugin-vectorstore-*](./api-vectorstore.md)
