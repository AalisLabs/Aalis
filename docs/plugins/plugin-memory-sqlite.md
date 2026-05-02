# plugin-memory-sqlite — SQLite 记忆存储

**包名**: `@aalis/plugin-memory-sqlite`  
**源码**: `packages/plugin-memory-sqlite/src/index.ts`

## 概述

基于 `better-sqlite3` 的 `MemoryService` 实现，适合单机部署场景。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-sqlite'
meta.provides = ['memory']
meta.inject = {} // 无依赖
```

注册优先级: **10**（高于内置 fallback）

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `data/aalis.db` | SQLite 数据库文件路径 |

## 特性

- 自动创建 `messages` 表和 `sessionId + timestamp` 复合索引
- 启用 WAL 模式以提升并发性能
- `getHistory()` 倒序取最新 N 条后正序返回
- 可被 `/clear` 间接调用：命令插件通过 `MemoryService.clearSession()` / `clearAll()` 清理消息历史
- dispose 时关闭数据库连接
