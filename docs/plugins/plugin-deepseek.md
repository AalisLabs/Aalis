# plugin-deepseek — DeepSeek LLM 服务

**包名**: `@aalis/plugin-deepseek`  
**源码**: `packages/plugin-deepseek/src/index.ts`

## 概述

DeepSeek API 的 `LLMService` 适配器，支持流式输出、工具调用和思考模式。

## 插件声明

```typescript
meta.name = '@aalis/plugin-deepseek'
meta.provides = ['llm']
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | — | API 密钥（必填，secret） |
| `baseUrl` | string | `https://api.deepseek.com` | API 基地址 |
| `model` | select | `deepseek-chat` | 模型名（动态选项来源: llm） |
| `temperature` | number | 0.7 | 采样温度 |
| `maxTokens` | number | 8192 | 最大生成 token 数 |
| `contextLength` | number | 131072 | 模型上下文窗口大小 |
| `maxToolIterations` | number | 10 | 工具调用最大迭代次数 |
| `strictToolCalls` | boolean | false | 启用 strict 模式工具调用 |
| `capabilities` | multiselect | — | 声明能力: chat / tool_calling / streaming / thinking |

## 特性

- **思考模式**: 当 capabilities 含 `thinking` 时自动启用，请求体附加 `thinking: { type: 'enabled', budget_tokens }`，思考内容通过 `reasoningContent` 返回
- **Strict 工具调用**: 启用后工具参数 schema 添加 `strict: true`
- **SSE 流式解析**: `chatStream()` 解析 SSE 事件流，累积 tool_calls delta
- **动态模型列表**: `listModels()` 从 API 获取可用模型供 WebUI 下拉选择
