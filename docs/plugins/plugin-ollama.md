# plugin-ollama — Ollama 本地模型 LLM

**包名**: `@aalis/plugin-ollama`  
**源码**: `packages/plugin-ollama/src/index.ts`

## 概述

Ollama 本地模型 LLM 服务提供者，通过 Ollama REST API 连接本地运行的模型。

## 插件声明

```typescript
meta.name = '@aalis/plugin-ollama'
meta.provides = ['llm']
meta.inject = {}
```

注册能力: `chat`, `streaming`

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `http://localhost:11434` | Ollama API 地址 |
| `model` | string | — | 默认模型名称 |
| `contextLength` | number | `8192` | 上下文窗口大小 |
| `keepAlive` | string | `5m` | 模型在内存中保持时间 |

## 工作方式

1. 通过 `/api/chat` 端点发送请求
2. 支持流式输出（SSE）
3. 自动检测本地可用模型列表
