# plugin-memory-mongodb — MongoDB 记忆存储

**包名**: `@aalis/plugin-memory-mongodb`  
**源码**: `packages/plugin-memory-mongodb/src/index.ts`

## 概述

基于 MongoDB 的 `MemoryService` 实现，需要一个可访问的 MongoDB 服务。以 `priority: 5` 注册 `memory` 服务（`plugin-memory-sqlite` 为 10，`plugin-memory-inmemory` 为 -100），与 sqlite 同时启用时默认选用 sqlite；如需改用本插件，可在顶层配置 `servicePreferences` 中显式指定。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-mongodb'
meta.provides = ['memory']
meta.inject = {} // 无依赖
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `uri` | string | `'mongodb://localhost:27017'` | MongoDB URI：MongoDB 连接字符串 |
| `database` | string | `'aalis'` | 数据库名：存储消息历史的数据库 |
| `collection` | string | `'messages'` | 集合名：消息集合名称 |
| `connectTimeoutMs` | number | `5000` | 连接超时（毫秒）：建立连接与服务器选择（serverSelection）的超时时间，两者共用此值 |
| `rangeQueryLimit` | number | `500` | 范围查询返回上限：区间消息查询（向量召回的上下文窗口扩展等）单次返回的最大条数。命中上限会静默截断 |
| `crossSessionMaxLimit` | number | `1000` | 跨会话查询返回上限：跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限 |

## 特性

- `apply` 为异步函数，启动时连接数据库，在消息集合上创建 `{ sessionId: 1, timestamp: 1 }`、`{ archived: 1, timestamp: -1 }`、`{ 'metadata.platform': 1, timestamp: -1 }` 三个索引；结构化元数据存放在同库固定名为 `metadata` 的集合中（不受 `collection` 配置影响），并建有 `{ namespace: 1, key: 1 }` 唯一索引
- 完整实现 `MemoryService`：消息读写（`saveMessage`、`getHistory`、`getFullHistory`、`clearSession`、`clearAll`，其中 `clearAll` 同时清空 `metadata` 集合）、区间与跨会话查询（`getMessagesBySessionRange` 受 `rangeQueryLimit` 限制，`getRecentMessagesAcrossSessions` 受 `crossSessionMaxLimit` 限制）、`trimHistory`（将较早的未归档消息标记为 `archived`，不删除）、`updateMessageContent`、`deleteMessagesByTimestamps`，以及结构化元数据（`saveMetadata` / `getMetadata` / `listMetadata` / `commitMetadata` / `deleteMetadata`）
- `commitMetadata` 用有序 `bulkWrite` 批量写入，不是事务：遇错即停，失败点之前的写已生效
- dispose 时关闭 MongoDB 连接
- 连接或建索引失败时关闭客户端，并抛出 `MongoDB 连接失败: <原因>`，不回退到其它存储
- 日志中打印的 URI 会隐去密码段（`mongodb://user:***@host`）
