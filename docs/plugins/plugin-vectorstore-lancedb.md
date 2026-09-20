# plugin-vectorstore-lancedb — LanceDB 向量存储

**包名**: `@aalis/plugin-vectorstore-lancedb`  
**源码**: `packages/plugin-vectorstore-lancedb/src/index.ts`

## 概述

基于 LanceDB 的向量存储实现，提供 `vectorstore` 服务。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-vectorstore-lancedb',
  displayName: 'LanceDB 向量库',
  subsystem: 'embedding',
  provides: [vectorstore],
  uses: {
    storage,
    provide,
    config,
    logger,
    lifecycle,
  },
  apply(caps) { /* 见源码 */ },
});
```

运行时经存储网关把 `path` 解析为本地目录，没有 storage 连库都开不了，故 storage 是必需依赖；还要求该 URI 所在的存储根具备 write 与 local-path 能力。声明 `required` 换来 `app.stop()` 时的拓扑保证：消费者先关、提供者后关；单独禁用或热重载 storage 时没有这条保证。

注册优先级: **10**（高于 plugin-vectorstore-flat）

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `'data:/lancedb'` | 数据库目录：LanceDB 数据存储 storage URI（也兼容裸名/相对路径） |
| `tableName` | string | `'vectors'` | 表名：向量表名称 |
| `optimizeEvery` | number | `500` | 压实间隔：每写入多少条向量后后台压实一次（合并碎片 + 回收作废数据文件）。LanceDB 每次 add 产生一个新碎片与版本，不压实会让 data/ 与 _versions/ 无界膨胀、写入越来越慢；设 0 关闭 |
| `cleanupRetentionMinutes` | number | `60` | 数据文件保留窗（分钟）：压实时回收「此分钟数以前」的作废数据文件。比它更新的文件（含可能在途的写入）一律保留，故对单进程写入安全。默认 LanceDB 保留 7 天，高频压实下会让 data/ 累到数百 GB —— 收紧到分钟级即可把库压回真实大小。调大更保守、更占盘。 |

## 特性

- 启动时若向量表已存在则直接打开，不存在则在首次写入时自动创建
- 利用 LanceDB 原生向量检索，显式使用余弦距离，评分为 `1 - 余弦距离`（即余弦相似度，与 plugin-vectorstore-flat 量纲一致）
- 每写入 `optimizeEvery` 条后在后台压实一次，不阻塞写入；压实失败记 warn 日志，下一轮重试。启动时若表已存在也会压实一次（`optimizeEvery` 为 0 时均不执行）
- `deleteByFilter` 把过滤条件转为 LanceDB 原生 SQL 谓词原地删除，空过滤器不删除任何记录
- 压实、`deleteByFilter`、`clear` 三种表结构操作串行执行
- 自动持久化，`save()` 为空操作
- dispose 时关闭表句柄
