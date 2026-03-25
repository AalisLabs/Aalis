# plugin-vectorstore-lancedb — LanceDB 向量存储

**包名**: `@aalis/plugin-vectorstore-lancedb`  
**源码**: `packages/plugin-vectorstore-lancedb/src/index.ts`

## 概述

基于 LanceDB 的高性能向量存储，适合生产环境和大规模数据。

## 插件声明

```typescript
meta.name = '@aalis/plugin-vectorstore-lancedb'
meta.provides = ['vectorstore']
meta.inject = {} // 无依赖
```

注册优先级: **10**（高于 plugin-vectorstore-flat）

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `path` | string | `data/lancedb` | LanceDB 数据目录 |
| `tableName` | string | `vectors` | 表名 |

## 特性

- 首次写入时自动创建向量表
- 利用 LanceDB 原生向量检索（L2 距离转相似度评分）
- 自动持久化，`save()` 为空操作
- dispose 时关闭连接
- 性能远优于平面文件存储
