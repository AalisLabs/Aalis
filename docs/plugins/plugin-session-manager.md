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

- **会话 CRUD**: 创建、查询、更新、归档、删除会话（删除会递归删除子会话，并经 `memory:clear` 钩子以会话级、不带类型清理，该会话的消息历史、摘要、待办与向量随之清空）
- **会话树**: 支持父子会话关系（用于子任务系统）
- **平台配置**: 每个平台可独立设置 persona、默认模型（`llm`）、启用的工具分组、think 等，在解析会话配置时叠加；同一平台的群与私聊可以用受众条目区分
- **IM 房间收录与会话页分区**: 群与私聊的首条真人消息到达即登记，WebUI 会话页把它们列在「IM 房间」区，owner 自己的 WebUI、CLI 会话列在「我的会话」区（收录口径见 [session-manager 服务](../services/session-manager.md) §6.6）
- **事件发射**: `session:created`、`session:updated`、`session:deleted`、`session:completed`
- **持久化**: 会话表存于 memory 的元数据命名空间 `sessions`，写操作经 1 秒防抖后整批提交。会话表跟随 memory 的当前胜者：运行中胜者换成另一个后端（如新装或启用首选后端）时，先把未落盘的变更写回旧后端，再从新后端读取会话表整体替换。换后端即换库，不跨后端合并；新表加载完成前的改动仍写回旧后端，旧后端已卸载或停用时写回失败，只记 warn。读取会话表失败时记 error，会话列表为空，在这个后端上的会话改动不落盘，以免空表覆盖后端原有记录。清空、读取历史等消息类操作始终走当前胜者

## 平台配置继承

```
全局 defaults → 平台 profile → 受众条目 → 父会话 sessionDefaults → 会话自身 config
```

从左到右优先级递增，右侧覆盖左侧；值为 `undefined` 或 `null` 的字段视为未设置，沿用上一层的值。

平台 profile 可以设置 persona、默认模型（`llm`）、启用的工具分组、think 等字段。工具分组写 `'*'` 表示全部分组；不写则该平台只有无分组的通用工具（带分组的工具默认不暴露）。`npm create aalis` 生成的配置只给 owner 专用的 `cli`、`webui` 两个平台写了 `enabledToolGroups: ['*']`。WebUI 新建根会话且未指定配置时，会把 webui 平台的 profile 拷贝为初始配置。

解析会话生效配置时选哪份平台 profile，结果不写回会话：

- IM 房间（会话 id 以 `<平台>:` 开头，子任务按父会话算）按房间的出生平台选档，不论从哪个入口驱动。owner 从 WebUI 往 QQ 群插话，这一轮仍按 onebot 的档选工具组、人设与模型，拿不到 webui 档开放的工具组；会话页的继承提示与 `/session` 的来源显示同一口径。
- 没有出生平台的会话（WebUI、CLI 等 owner 面会话）按调用方传入的入口平台选档。

钉死只管继承链：会话自身 config 里的覆盖仍然优先。

### 受众条目

同一平台的群与私聊可以用不同的档：在基础档（不写 `audience` 的那条）之外，再写一条带 `audience` 的条目，只列与基础档不同的键，叠加在基础档之上。

```yaml
'@aalis/plugin-session-manager':
  platformProfiles:
    - platform: onebot                 # 不写 audience：这个平台全部房间的基础档
      enabledToolGroups: [<分组>]
    - platform: onebot
      audience: private                # 只列与基础档不同的键
      enabledToolGroups: [<分组>, <另一分组>]
```

`audience` 取 `group`（群与频道）或 `private`（私聊），WebUI 配置页里是「受众」下拉框，留空为「该平台全部房间」。受众条目只对有出生平台的房间生效，owner 面会话不取。取值不是 `group`、`private` 的条目整条丢弃并告警，不当成不限受众去覆盖整个平台。同一平台同一受众写了多条时，后写的覆盖先写的。服务方法 `getPlatformProfiles()` 只回基础档；会话页的继承来源对受众条目显示为「平台档 `<平台>`（私聊）」或「平台档 `<平台>`（群）」。
