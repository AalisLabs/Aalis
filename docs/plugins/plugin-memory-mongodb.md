# plugin-memory-mongodb — MongoDB 记忆存储

**包名**: `@aalis/plugin-memory-mongodb`  
**源码**: `packages/plugin-memory-mongodb/src/index.ts`

## 概述

基于 MongoDB 的 `MemoryService` 实现，需要一个可访问的 MongoDB 服务。以 `priority: 5` 注册 `memory` 服务（`plugin-memory-sqlite` 为 10，`plugin-memory-inmemory` 为 -100），与 sqlite 同时启用时默认选用 sqlite；如需改用本插件，可在顶层配置 `servicePreferences` 中显式指定。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-memory-mongodb',
  reusable: true,
  provides: [memory],
  apply(caps) { /* 见源码 */ },
  uses: {
    logger,
    config,
    lifecycle,
    provide,
    paths: optional(hostPaths), // 家目录：派生库名、核对库的归属
  },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `uri` | string | `'mongodb://localhost:27017'` | MongoDB URI：MongoDB 连接字符串（secret：连接串可能带账号密码，值存进 `secrets.yaml`，WebUI 不回显）。默认值不写进配置文件，没填时插件按默认值连接；引用的键不在 `secrets.yaml` 里时激活失败，不回落到默认的本机库 |
| `database` | string | `''` | 数据库名：存储消息历史与元数据的数据库。留空按家目录与实例派生，见下 |
| `claimFrom` | string | `''` | 认领库的归属：平时留空。库已归另一个家目录（例如家目录搬了位置）时，先停掉那个家目录的实例，再填它的路径；库里已有数据却还没有归属记录时填 `unowned`。启动一次就把归属改到这个家目录，认领后删掉这一项：留着的 `unowned` 会让以后指向的任何库都跳过「已有数据」的检查 |
| `collection` | string | `'messages'` | 集合名：消息集合名称 |
| `connectTimeoutMs` | number | `5000` | 连接超时（毫秒）：建立连接与服务器选择（serverSelection）的超时时间，两者共用此值 |
| `rangeQueryLimit` | number | `500` | 范围查询返回上限：区间消息查询（向量召回的上下文窗口扩展等）单次返回的最大条数。命中上限会静默截断 |
| `crossSessionMaxLimit` | number | `1000` | 跨会话查询返回上限：跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限 |

## 特性

- `apply` 为异步函数，启动时连接数据库（停用或停机时关闭客户端，中止连接与建索引），在消息集合上创建 `{ sessionId: 1, timestamp: 1 }`、`{ archived: 1, timestamp: -1 }`、`{ 'metadata.platform': 1, timestamp: -1 }` 三个索引；结构化元数据存放在同库固定名为 `metadata` 的集合中（不受 `collection` 配置影响），并建有 `{ namespace: 1, key: 1 }` 唯一索引
- 完整实现 `MemoryService`：消息读写（`saveMessage`、`getHistory`、`getFullHistory`、`clearSession`、`clearAll`，其中 `clearAll` 只清空消息集合，`metadata` 集合由各命名空间的归属插件经 `memory:clear` 自行清理）、区间与跨会话查询（`getMessagesBySessionRange` 受 `rangeQueryLimit` 限制，`getRecentMessagesAcrossSessions` 受 `crossSessionMaxLimit` 限制）、`trimHistory`（将较早的未归档消息标记为 `archived`，不删除）、`updateMessageContent`、`deleteMessagesByTimestamps`，以及结构化元数据（`saveMetadata` / `getMetadata` / `listMetadata` / `listMetadataKeys` / `commitMetadata` / `deleteMetadata`）
- `commitMetadata` 用有序 `bulkWrite` 批量写入，不是事务：遇错即停，失败点之前的写已生效
- `listMetadata` 逐条检查：`data` 不是对象的文档跳过并记一条 warn，点名命名空间与键；缺少 `updatedAt` 或它不是日期的文档照常返回，`updatedAt` 记为 0。这两种文档只会来自手工导入等外部写入，本插件写入时总会带上这两个字段。`listMetadataKeys` 只取键、不读 `data`，跳过的文档也在其中：各插件经 `/clear` 整体清空命名空间时连同它们一并删除
- 可多实例（`@aalis/plugin-memory-mongodb:<后缀>`）。`database` 留空时按家目录与实例派生：主家目录用 `aalis`，profile 家目录（`~/.aalis-<profile>`）用 `aalis_<profile>`，带后缀的实例再加后缀（如 `:b` 实例用 `aalis-b`、`aalis_<profile>_b`）；配置里写明的库名照用。库名超过 MongoDB 63 字节的上限时激活失败，报一行 `ConfigError`。`metadata` 集合与消息集合同库，所以同一连接串（按字面比较）下两个实例用同一个库时，即使 `collection` 不同也算共用：后激活的那个激活失败，报一行 `ConfigError`，点名占用该库的实例，不发起连接
- 库的归属：宿主提供 `host-paths` 时，库里 `metadata` 集合记着它归哪个家目录与哪个实例（命名空间 `aalis.home`、键 `owner`）。不同家目录连同一个 MongoDB、派生出同一个库名时（例如开发用的 `.aalis-dev/` 与生产的 `~/.aalis`，或复制出来的测试实例），后来的那个激活失败，报一行 `ConfigError`，点名库归属的家目录与实例，不会共写。
  - 归属按家目录的真实路径认。家目录搬了位置、换了用户名或从备份恢复到别处，也会报这个错；确认是同一份数据后，先停掉原家目录的实例，再在配置里写 `claimFrom: <原家目录>` 启动一次认领。归属只在激活时核对，认领之后原家目录里还在跑的实例不会察觉，两边会一起写。
  - 路径只在一台机器上有意义：两台机器或两个容器的家目录路径相同（例如同一个镜像起的容器都用 `/root/.aalis`）、又连同一个 MongoDB 时认不出来，要各自写明不同的 `database`。
  - 新库（没有记录、任何集合里也没有数据）直接记下本家目录。库里已有数据却没有记录时不默认认走，要写 `claimFrom: unowned`；记录坏了（缺家目录或实例）时同样报错，确认后写 `claimFrom: unowned` 改写。
  - 宿主不提供 `host-paths`（嵌入式宿主、测试夹具）时不做这项检查
- dispose 时关闭 MongoDB 连接
- 连接或建索引失败时关闭客户端，并抛出 `MongoDB 连接失败（确认 MongoDB 在运行、配置项 uri 写对）: <原因>`。激活失败（连接失败或归属不对）时本插件不提供 `memory` 服务；同时启用了 `@aalis/plugin-memory-sqlite` 或 `@aalis/plugin-memory-inmemory` 的，记忆改由它们提供，看起来像历史丢了、新消息也写到了那里。只用 MongoDB 的，把这两个插件写进 `disabledPlugins`
- 日志中打印的 URI 会隐去密码段（`mongodb://user:***@host`）
