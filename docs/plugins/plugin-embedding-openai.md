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
| `apiKey` | string | — | API 密钥（必填，secret） |
| `baseUrl` | string | `https://api.openai.com` | API 基地址 |
| `model` | select | `text-embedding-3-small` | 嵌入模型名（动态选项来源: embedding） |

## 特性

- 调用 `/v1/embeddings` 端点
- `listModels()` 从 `/v1/models` 获取可用模型
- apiKey 缺失时抛错
- 启动时连通性检查（失败仅警告，不阻塞启动）
- 修改 `baseUrl` 可对接兼容 OpenAI 格式的其他 Embedding 服务
