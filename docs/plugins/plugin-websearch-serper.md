# plugin-websearch-serper — Web 搜索

**包名**: `@aalis/plugin-websearch-serper`  
**源码**: `packages/plugin-websearch-serper/src/index.ts`

## 概述

注册 `web_search` 工具，通过 Serper.dev API 调用 Google 搜索。内置三重限流保护。

## 插件声明

```typescript
meta.name = '@aalis/plugin-websearch-serper'
meta.provides = [] // 不提供服务，仅注册工具
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | — | Serper.dev API 密钥（必填，secret） |
| `maxPerMinute` | number | 10 | 每分钟最大请求数 |
| `maxPerDay` | number | 100 | 每天最大请求数 |
| `maxConcurrent` | number | 3 | 最大并发请求数 |
| `defaultNumResults` | number | 5 | 默认返回结果数 |

## 注册的工具

### `web_search`

参数: `{ query: string, num_results?: number }`

搜索结果格式化包含：
- 直接回答（Answer Box）
- 知识图谱（Knowledge Graph）
- 有机搜索结果（标题、链接、摘要）

## 限流

内置 `RateLimiter` 实现三重保护：
- 分钟窗口限流
- 天窗口限流
- 并发数限制
