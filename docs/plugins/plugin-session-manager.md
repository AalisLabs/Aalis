# plugin-session-manager — 会话管理器

**包名**: `@aalis/plugin-session-manager`  
**源码**: `packages/plugin-session-manager/src/index.ts`

## 概述

会话生命周期管理，支持会话树形结构和平台配置继承。每个平台可配置独立的 persona、model、工具集等。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-session-manager',
  provides: [sessionManager],
  uses: {
    memory,
    agent: optional(agent),
    llm: optional(llm),
    persona: optional(persona),
    platform: optional(platform),
    tools: optional(tools),
    webui: optional(webuiServer),
    events,
    hooks,
    lifecycle,
    logger,
    config,
    provide,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

配置分两层：`defaults` 为所有平台共享的默认值，`platformProfiles` 按平台覆盖。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaults` | object | — | 全局默认配置：所有平台共享的最低层默认配置（platform profile 之下的 fallback）。LLM 默认模型由各 agent 插件通过 ServicePreference 锁定，不再在此配置；本节仅保留 persona 等通用默认。 |
| `defaults.persona` | select | — | 默认人设：所有平台未单独指定时使用的默认人设 |
| `platformProfiles` | array | `[]` | 平台默认配置：为每个平台设置默认的会话配置模板。新会话创建时自动应用对应平台的模板。 |

## 功能

- **会话 CRUD**: 创建、查询、更新、归档、删除会话（删除会递归删除子会话，并经 `memory:clear` 钩子清空该会话的消息历史）
- **会话树**: 支持父子会话关系（用于子任务系统）
- **平台配置**: 每个平台可独立设置 persona、默认模型（`llm`）、启用的工具分组、think 等，在解析会话配置时叠加
- **事件发射**: `session:created`、`session:updated`、`session:deleted`、`session:completed`
- **持久化**: 会话表存于 memory 的元数据命名空间 `sessions`，写操作经 1 秒防抖后整批提交。会话表跟随 memory 的当前胜者：运行中胜者换成另一个后端（如新装或启用首选后端）时，先把未落盘的变更写回旧后端，再从新后端读取会话表整体替换。换后端即换库，不跨后端合并；新表加载完成前落盘仍写旧后端。清空、读取历史等消息类操作始终走当前胜者

## 平台配置继承

```
全局 defaults → 平台 profile → 父会话 sessionDefaults → 会话自身 config
```

从左到右优先级递增，右侧覆盖左侧；值为 `undefined` 或 `null` 的字段视为未设置，沿用上一层的值。

平台 profile 可以设置 persona、默认模型（`llm`）、启用的工具分组、think 等字段。工具分组写 `'*'` 表示全部分组；不写则该平台只有无分组的通用工具（带分组的工具默认不暴露）。`npm create aalis` 生成的配置只给 owner 专用的 `cli`、`webui` 两个平台写了 `enabledToolGroups: ['*']`。解析会话生效配置时，按调用方传入的平台叠加对应 profile，结果不写回会话。WebUI 新建根会话且未指定配置时，会把 webui 平台的 profile 拷贝为初始配置。
