# plugin-tool-search — 工具搜索层

**包名**: `@aalis/plugin-tool-search`  
**源码**: `packages/plugin-tool-search/src/index.ts`

## 概述

当注册工具数量超过阈值时，自动将完整工具列表替换为搜索层：LLM 需先调用 `search_tools` 查询工具后才能使用，避免工具过多导致 token 浪费。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-search'
meta.provides = [] // 不提供服务
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 是否启用工具搜索层 |
| `showToolNames` | boolean | true | 系统提示中附带工具名称列表 |
| `maxDirectTools` | number | 5 | 工具数 ≤ 此阈值时跳过搜索层，直接传递所有工具 |

## 工作原理

通过 `agent:llm:before` 中间件（优先级 100）：

1. **检查阈值**: 如果注册工具数 ≤ `maxDirectTools`，直接传递所有工具
2. **替换工具列表**: 将 `data.tools` 替换为 `search_tools` 定义 + 已发现工具的定义
3. **追踪已发现工具**: 解析消息历史中 `search_tools` 调用结果，追踪 LLM 已知哪些工具
4. **可选**: 在 `search_tools` 描述中列出所有工具名称供 LLM 参考

### `search_tools` 工具

参数: `{ query: string }`

返回匹配查询的工具列表及其完整定义，LLM 在后续调用中可直接使用已发现的工具。
