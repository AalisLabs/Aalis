# plugin-embedding-ollama — Ollama 嵌入服务

**包名**: `@aalis/plugin-embedding-ollama`  
**源码**: `packages/plugin-embedding-ollama/src/index.ts`

## 概述

基于 Ollama HTTP API 的 `EmbeddingService` 实现，默认连接本地 `http://localhost:11434`，以 `embedding` 服务注册，标签为 `Ollama / <model>`。

## 插件声明

```typescript
meta.name = '@aalis/plugin-embedding-ollama'
meta.subsystem = 'embedding'
meta.provides = ['embedding']
meta.reusable = true
// 未声明 inject（无依赖）
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `'http://localhost:11434'` | Ollama 地址：本地 Ollama 服务的 HTTP 地址 |
| `model` | select | `'nomic-embed-text'` | Embedding 模型：用于生成文本向量的模型 |
| `timeoutMs` | number | `30000` | 请求超时 (ms)：单次 embedding 请求超时时间 |
| `retries` | number | `1` | 失败重试次数：fetch 失败或 5xx 时的重试次数 |

## 特性

- 首次调用先请求新版 `/api/embed`，失败（含网络错误、超时、非 2xx）则改用旧版 `/api/embeddings`；选定结果缓存在服务实例上，之后不再切换。启动连通性检查就是首次调用，此时 Ollama 不可达会让实例固定使用旧版接口，直到插件重载
- 启动时以 `embed('ping')` 做连通性检查：失败只记一条 warn，服务照常注册。检查本身会被等待，Ollama 无响应时最长约 `2 × (retries + 1) × timeoutMs`
- `listModels()` 从 `/api/tags` 获取本地已下载的模型
