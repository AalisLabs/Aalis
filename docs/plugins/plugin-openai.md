# plugin-openai — OpenAI LLM 服务

**包名**: `@aalis/plugin-openai`  
**源码**: `packages/plugin-openai/src/index.ts`

## 概述

OpenAI 兼容 API 的 `LLMService` 适配器，支持流式输出和工具调用。可对接任何兼容 OpenAI API 格式的服务。

## 插件声明

```typescript
meta.name = '@aalis/plugin-openai'
meta.provides = ['llm']
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | — | API 密钥（必填，secret） |
| `baseUrl` | string | `https://api.openai.com` | API 基地址 |
| `model` | select | `gpt-4o` | 模型名（动态选项来源: llm） |
| `temperature` | number | 0.7 | 采样温度 |
| `maxTokens` | number | 4096 | 最大生成 token 数 |
| `contextLength` | number | 128000 | 模型上下文窗口大小 |
| `maxToolIterations` | number | 10 | 工具调用最大迭代次数 |
| `capabilities` | multiselect | — | 声明能力: chat / tool_calling / streaming / thinking |

## 特性

- **SSE 流式**: `chatStream()` 解析 SSE 事件流，累积 tool_calls delta
- **动态模型列表**: `listModels()` 从 `/v1/models` 获取可用模型
- **兼容性**: 修改 `baseUrl` 可对接 Ollama、vLLM、LocalAI 等兼容服务
