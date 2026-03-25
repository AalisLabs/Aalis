# plugin-embedding-ollama — Ollama 嵌入服务

**包名**: `@aalis/plugin-embedding-ollama`  
**源码**: `packages/plugin-embedding-ollama/src/index.ts`

## 概述

基于 Ollama 本地服务的 `EmbeddingService` 实现，适合本地运行不依赖外部 API 的场景。

## 插件声明

```typescript
meta.name = '@aalis/plugin-embedding-ollama'
meta.provides = ['embedding']
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `http://localhost:11434` | Ollama API 地址 |
| `model` | select | `nomic-embed-text` | 嵌入模型名（动态选项来源: embedding） |

## 特性

- 自动检测 Ollama API 版本（`/api/embed` vs `/api/embeddings`）
- 启动时进行连通性检查（失败仅警告，不阻塞启动）
- `listModels()` 从 `/api/tags` 获取本地已下载的模型
