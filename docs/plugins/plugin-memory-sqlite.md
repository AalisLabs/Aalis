# plugin-memory-sqlite — SQLite 记忆存储

**包名**: `@aalis/plugin-memory-sqlite`  
**源码**: `packages/plugin-memory-sqlite/src/index.ts`

## 概述

基于 `better-sqlite3` 的 `MemoryService` 实现，用本地 SQLite 文件保存消息历史和结构化元数据（`metadata` 表），是 `memory` 服务的零配置默认后端。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-sqlite'
meta.subsystem = 'memory'
meta.provides = ['memory']
meta.inject = { required: ['storage'] }
```

注册优先级: **10**（高于 `plugin-memory-mongodb` 的 5 和 `plugin-memory-inmemory` 的 -100；通过 `servicePreferences` 显式指定偏好时不按优先级选择）

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `'data/aalis.db'` | 数据库路径：SQLite 数据库文件路径，相对于项目根目录 |
| `rangeQueryLimit` | number | `500` | 范围查询返回上限：区间消息查询（向量召回的上下文窗口扩展等）单次返回的最大条数。命中上限会静默截断 |
| `crossSessionMaxLimit` | number | `1000` | 跨会话查询返回上限：跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限 |

## 特性

- `path` 按 storage URI 解析：首段路径视为存储根名（如 `data/aalis.db` 即 `data:/aalis.db`），也可以直接写 `data:/xxx.db`；对应存储根须支持写入和本地路径解析（`resolveLocalPath`），否则启动时报错
- 自动创建 `messages` 表（含 `(sessionId, timestamp)` 与 `(archived, timestamp)` 两个索引）和 `metadata` 表；旧库启动时自动补齐缺失的列
- 启用 WAL 模式以提升并发性能
- `getHistory()`（默认 50 条）只取未归档消息，倒序取最新 N 条后正序返回；`trimHistory()` 是把旧消息标记为归档，不做物理删除
- `/clear` 经命令插件调用 `clearSession()`（删除该会话全部消息）；`/clear all` 调用 `clearAll()`，同时清空 `messages` 与 `metadata` 两张表。两者均仅在清理类型包含 `context` 时执行
- dispose 时关闭数据库连接
