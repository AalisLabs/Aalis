# plugin-memory-inmemory — 内存记忆

**包名**: `@aalis/plugin-memory-inmemory`  
**源码**: `packages/plugin-memory-inmemory/src/index.ts`

## 概述

无持久化的内存消息存储，作为 `memory` 服务的 fallback 实现。本插件不会自动启用，需要显式启用；与 SQLite、MongoDB 后端同时加载且未通过 `servicePreferences` 指定偏好时，服务解析选中对方。

## 插件声明

```ts
definePlugin({
  name: '@aalis/plugin-memory-inmemory',
  displayName: '内存记忆',
  subsystem: 'memory',
  provides: [memory],
  apply(caps) { caps.provide(memory, service, { priority: -100 }); },
  uses: {
    config,
    logger,
    provide,
  },
})
```

注册优先级 **-100**（低于 `plugin-memory-sqlite` 的 10 与 `plugin-memory-mongodb` 的 5）。

## 配置

配置项由 `packages/plugin-memory-inmemory/src/index.ts` 的 `configSchema` 声明。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `rangeQueryLimit` | number | `500` | 范围查询返回上限：区间消息查询单次返回的最大条数。命中上限会静默截断（与 sqlite/mongodb 后端对齐） |
| `crossSessionMaxLimit` | number | `1000` | 跨会话查询返回上限：跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限 |

## 工作方式

- 消息按会话 ID 存放在进程内存中，活跃历史与 `trimHistory` 裁出的归档分开保存
- 结构化元数据按命名空间与 key 存放，写入和读出时均做深拷贝
- 应用重启后数据丢失
- 适用于开发/测试环境或无需持久化的场景
