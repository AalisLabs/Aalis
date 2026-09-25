# plugin-embedding-openai — OpenAI 嵌入服务

**包名**: `@aalis/plugin-embedding-openai`  
**源码**: `packages/plugin-embedding-openai/src/index.ts`

## 概述

OpenAI 兼容 API 的 `EmbeddingService` 实现，向量空间标识 `modelId` 为 `openai:<model>`。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-embedding-openai',
  provides: [embedding],
  uses: {
    config,
    logger,
    provide,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | 必填 | API Key：OpenAI API 密钥（secret） |
| `baseUrl` | string | `'https://api.openai.com/v1'` | API 地址：API 端点完整前缀（含版本段）；插件只在其后拼 /embeddings 与 /models |
| `model` | select | `'text-embedding-3-small'` | Embedding 模型：用于生成文本向量的模型 |
| `timeoutMs` | number | `30000` | 请求超时 (ms)：单次 embedding 请求超时时间。不设上限时启动探测会把插件激活链整条钉住 |

## 特性

- `embed()` / `listModels()` 的请求都带 `AbortSignal.timeout(timeoutMs)`。这不是可选项：插件激活是串行的（`PluginManager.recompute` 逐个 `await activatePlugin`），而 `apply()` 会 await 一次启动连通性探测——对端不应答时整条引导链被钉住；索引路径上则是 `plugin-memory-vector` 的一个并发槽被无限期占用


- 调用 `/embeddings` 端点
- `listModels()` 从 `/models` 获取可用模型
- apiKey 缺失时抛错
- 启动时用 `embed('ping')` 做一次连通性检查。apply 会等检查结束；检查失败只记警告，服务照常注册
- 修改 `baseUrl` 可对接兼容 OpenAI 格式的其他 Embedding 服务（须写到完整前缀，如 `http://host/v1`）
