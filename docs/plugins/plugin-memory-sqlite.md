# plugin-memory-sqlite — SQLite 记忆存储

**包名**: `@aalis/plugin-memory-sqlite`  
**源码**: `packages/plugin-memory-sqlite/src/index.ts`

## 概述

基于 `better-sqlite3` 的 `MemoryService` 实现，用本地 SQLite 文件保存消息历史和结构化元数据（`metadata` 表），是 `memory` 服务的零配置默认后端。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-memory-sqlite',
  subsystem: 'memory',
  reusable: true,
  provides: [memory],
  uses: {
    storage,
    provide,
    logger,
    lifecycle,
    config,
  },
  apply(caps) { /* 见源码 */ },
});
```

注册优先级: **10**（高于 `plugin-memory-mongodb` 的 5 和 `plugin-memory-inmemory` 的 -100；通过 `servicePreferences` 显式指定偏好时不按优先级选择）

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `''` | 数据库路径：SQLite 数据库文件的 storage URI（如 `data:/aalis.db`；不含 `:/` 时首段视为存储根名，单段裸名归 `data` 根）。留空按实例派生，见下 |
| `rangeQueryLimit` | number | `500` | 范围查询返回上限：区间消息查询（向量召回的上下文窗口扩展等）单次返回的最大条数。命中上限会静默截断 |
| `crossSessionMaxLimit` | number | `1000` | 跨会话查询返回上限：跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限 |

## 特性

- `path` 按 storage URI 解析：首段路径视为存储根名（如 `data/aalis.db` 即 `data:/aalis.db`），也可以直接写 `data:/xxx.db`；对应存储根须支持写入和本地路径解析（`resolveLocalPath`），否则启动时报错
- `path` 缺省或为 `null` 时仍按实例派生；显式给出布尔值、数组或对象等无效类型时拒绝激活，不会回落到默认数据库文件。
- 可多实例（`@aalis/plugin-memory-sqlite:<后缀>`）。`path` 留空时按实例派生：主实例用 `data:/aalis.db`，带后缀的实例在文件名上加后缀（如 `:b` 实例用 `data:/aalis-b.db`）；配置里写明的 `path` 照用。两个实例打开的是同一个文件时，后激活的那个激活失败，报一行 `ConfigError`，点名占用该文件的实例；两边路径写法不同时一并给出占用者打开的路径。是否同一个文件按文件身份（设备号与 inode）判断，大小写不敏感的卷上只差大小写的路径、硬链接都算同一个文件；文件系统不提供 inode 时退回按本地路径比较
- `better-sqlite3` 是原生模块，按装依赖时的 Node 版本编译。换了 Node 大版本后启动，插件激活失败并提示两条出路：用装依赖时的 Node 启动，或在项目根执行 `npm rebuild better-sqlite3`（pnpm 工程用 `pnpm rebuild better-sqlite3`），报错末尾附原始错误的首行。CPU 架构不符、缺系统库等其它原生加载失败不给这条提示，报错照录原始错误
- 自动创建 `messages` 表（含 `(sessionId, timestamp)` 与 `(archived, timestamp)` 两个索引）和 `metadata` 表
- `listMetadata` 逐行解析：`data` 不是 JSON 对象的行（手改或损坏）跳过并记一条 warn，点名命名空间与键，同一命名空间的其余条目照常返回。`listMetadataKeys` 只取键、不读 `data`，跳过的行也在其中：各插件经 `/clear` 整体清空命名空间时连同它们一并删除。`updatedAt` 读不出（被改成无法解析的文本或 BLOB）的行照常返回，`updatedAt` 记为 0
- 启用 WAL 模式以提升并发性能
- `getHistory()`（默认 50 条）只取未归档消息，倒序取最新 N 条后正序返回；`trimHistory()` 是把旧消息标记为归档，不做物理删除
- `/clear` 经命令插件调用 `clearSession()`（删除该会话全部消息，含归档）；`/clear all` 调用 `clearAll()`，只清空 `messages` 表。两者均仅在清理类型为空或包含 `context` 时执行。`metadata` 表不经这两个方法清理，各命名空间由归属插件在 `memory:clear` 中间件里自行删除（见 [plugin-commands](./plugin-commands.md) 的「`/clear` 类型」一节）
- dispose 时关闭数据库连接；激活时开库之后的任何一步失败（撞库、设 WAL、建表等），也先关掉刚打开的连接再报错
