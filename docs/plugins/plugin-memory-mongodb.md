# plugin-memory-mongodb — MongoDB 记忆存储

**包名**: `@aalis/plugin-memory-mongodb`  
**源码**: `packages/plugin-memory-mongodb/src/index.ts`

## 概述

基于 MongoDB 的 `MemoryService` 实现，适合分布式部署或需要持久化到远程数据库的场景。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-mongodb'
meta.provides = ['memory']
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `uri` | string | `mongodb://localhost:27017` | MongoDB 连接 URI（必填） |
| `database` | string | `aalis` | 数据库名（必填） |
| `collection` | string | `messages` | 集合名 |

## 特性

- `apply` 为异步函数，启动时连接数据库并创建 `{ sessionId: 1, timestamp: 1 }` 复合索引
- 提供 `saveMessage`、`getHistory`、`clearSession`
- dispose 时关闭 MongoDB 连接
- 连接失败直接抛出错误（不提供回退）
