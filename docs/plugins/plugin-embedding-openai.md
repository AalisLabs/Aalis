# plugin-embedding-openai — OpenAI 嵌入服务

**包名**: `@aalis/plugin-embedding-openai`  
**源码**: `packages/plugin-embedding-openai/src/index.ts`

## 概述

OpenAI 兼容 API 的 `EmbeddingService` 实现。

## 插件声明

```typescript
meta.name = '@aalis/plugin-embedding-openai'
meta.provides = ['embedding']
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | 必填 | API Key：OpenAI API 密钥（secret） |
| `baseUrl` | string | `'https://api.openai.com/v1'` | API 地址：API 端点完整前缀（含版本段）；插件只在其后拼 /embeddings 与 /models |
| `model` | select | `'text-embedding-3-small'` | Embedding 模型：用于生成文本向量的模型 |

## 特性

- 调用 `/embeddings` 端点
- `listModels()` 从 `/models` 获取可用模型
- apiKey 缺失时抛错
- 启动时用 `embed('ping')` 做一次连通性检查。apply 会等检查结束，但请求本身不设超时；检查失败只记警告，服务照常注册
- 修改 `baseUrl` 可对接兼容 OpenAI 格式的其他 Embedding 服务（须写到完整前缀，如 `http://host/v1`）
