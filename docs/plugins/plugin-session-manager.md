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

`platformProfiles[].think` 使用 `on`、`off` 或空串（继承）。旧配置中布尔 `true`、`false` 应分别转换为 `on`、`off`；会话运行态的 `think` 覆盖仍是布尔值。

## 功能

- **会话 CRUD**: 创建、查询、更新、归档、删除会话（删除会递归删除子会话，并经 `memory:clear` 钩子以会话级、不带类型清理，该会话的消息历史、摘要、待办与向量随之清空）
- **会话树**: 支持父子会话关系（用于子任务系统）
- **平台配置**: 每个平台可独立设置 persona、默认模型（`llm`）、启用的工具分组、think 等，在解析会话配置时叠加；同一平台的群与私聊可以用受众条目区分
- **IM 房间收录与会话页分区**: 群与私聊的首条真人消息到达即登记，WebUI 会话页把它们列在「IM 房间」区，owner 自己的 WebUI、CLI 会话列在「我的会话」区（收录口径见 [session-manager 服务](../services/session-manager.md) §6.6）
- **事件发射**: `session:created`、`session:updated`、`session:deleted`、`session:completed`
- **持久化**: 会话表存于 memory 的元数据命名空间 `sessions`，写操作经 1 秒防抖后整批提交。会话表跟随 memory 的当前胜者：运行中胜者换成另一个后端（如新装或启用首选后端）时，先把未落盘的变更写回旧后端，再从新后端读取会话表整体替换。换后端即换库，不跨后端合并；新表加载完成前的改动仍写回旧后端，旧后端已卸载或停用时写回失败，只记 warn。读取会话表失败时按 1、3、10 秒的间隔重试三次（每次重试前记一条 warn），其间仍用原来的会话表与落盘目标。本插件激活时（启动时，或随 memory 胜者卸载、停用、重载而重新激活时）等读表（含重试）结束才对外提供服务：后端持续不可用时，这次重算约多等 14 秒，拓扑序排在本插件之后的插件随之推迟激活，启动时 `app:ready` 也随之推迟。14 秒是三次重试间隔之和，各次读取本身的耗时另计：如 memory-mongodb 连不上库时，每次读取要等到服务器选择超时（`connectTimeoutMs`，默认 5 秒）。换后端、停用或停机会中止重试等待。重试用尽或被中止时会话列表为空，在这个后端上的会话改动不落盘，以免空表覆盖后端原有记录；重试用尽记 error，被中止（停用、停机或换后端）只记一行 info。清空、读取历史等消息类操作始终走当前胜者

## 平台配置继承

```
全局 defaults → 平台 profile → 受众条目 → 父会话 sessionDefaults → 会话自身 config
```

从左到右优先级递增，右侧覆盖左侧；值为 `undefined` 或 `null` 的字段视为未设置，沿用上一层的值。

平台 profile 可以设置 persona、默认模型（`llm`）、启用的工具分组、think 等字段。工具分组写 `'*'` 表示全部分组；不写则该平台只有无分组的通用工具（带分组的工具默认不暴露）。`npm create aalis` 生成的配置只给 owner 专用的 `cli`、`webui` 两个平台写了 `enabledToolGroups: ['*']`。WebUI 新建根会话且未指定配置时，会把 webui 平台的 profile 拷贝为初始配置；新建子会话时拷贝父会话的生效配置。两种拷贝都去掉白纸与远端代理的房间键（`ROOM_ONLY_CONFIG_KEYS`，见 [api-session-manager](../api/api-session-manager.md)），这些键只经继承链实时解析；`memoryRecallScope` 照常拷贝。

解析会话生效配置时选哪份平台 profile，结果不写回会话：

- IM 房间（会话 id 以 `<平台>:` 开头，子任务按父会话算）按房间的出生平台选档，不论从哪个入口驱动。owner 从 WebUI 往 QQ 群插话，这一轮仍按 onebot 的档选工具组、人设与模型，拿不到 webui 档开放的工具组；会话页的继承提示与 `/session` 的来源显示同一口径。
- 没有出生平台的会话（WebUI、CLI 等 owner 面会话）按调用方传入的入口平台选档。

钉死只管继承链：会话自身 config 里的覆盖仍然优先。

平台 profile 还能写白纸与远端代理的六个键（`paperEnabled`、`paperName`、`remoteAgentTypes`、`remoteAgentUserDailyCents`、`remoteAgentUserDailyTasks`、`remoteAgentRoomDailyCents`）与记忆召回范围 `memoryRecallScope`。这七个键关系到费用与召回范围，加载时逐键核对类型：布尔只收布尔，`paperName` 只收非空字符串，`remoteAgentTypes` 只收字符串数组（非字符串与空串项滤掉），三项上限只收有限且不小于 0 的数，`memoryRecallScope` 只收 `session` / `platform` / `all`。平台档中的两项金额上限若明确写了非法值，会拒绝启用会话管理，避免非法值被丢弃后放宽成不限额；数组中其他不可恢复的错误（如无效受众或缺少平台标识）也会使整组平台档拒绝装载。其余可恢复的无效键仍按原规则丢弃并记 warn。两项金额的 `undefined` 或 `null` 表示未设置；显式空字符串不是合法金额。房间与每人金额未设置时不增加该层限制，显式 0 禁止新远端任务；会话自身不写覆盖值时仍继承上层。房间键写在平台档里，这个平台的所有房间都会继承，一般只写在单个房间的会话配置里。

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

`audience` 取 `group`（群与频道）或 `private`（私聊），WebUI 配置页里是「受众」下拉框，留空为「该平台全部房间」。受众条目只对有出生平台的房间生效，owner 面会话不取。取值不是 `group`、`private` 时拒绝装载整组平台档，不当成不限受众去覆盖整个平台。同一平台同一受众写了多条时，后写的覆盖先写的。服务方法 `getPlatformProfiles()` 只回基础档；会话页的继承来源对受众条目显示为「平台档 `<平台>`（私聊）」或「平台档 `<平台>`（群）」。

## 页面动作

会话页经页面动作读写会话。取继承值用 `getInheritance({ sessionId })`，返回 api-session-manager 的 `SessionInheritance`：

```ts
{
  platform?: string;                                   // 选档用的平台，由服务端推出
  audience?: 'group' | 'private';                      // 选档用的受众，只有 IM 房间带
  values: Omit<SessionConfig, 'sessionDefaults'>;      // 不含会话自身 config 的继承值
  sources: Partial<Record<keyof SessionConfig, 'defaults' | 'platform' | 'audience' | 'parent'>>; // 每个键最终来自哪一层
}
```

平台由服务端推出，动作不收平台参数：IM 房间（含其子任务）按出生平台；没有出生平台的会话按「会话 metadata 记下的平台 → 接管这个会话 id 的平台适配器 → `webui`」推出入口平台。因此 onebot 群会话显示的是 onebot 平台档的继承值。原来的 `getInheritedDefaults` 已删除（它由调用方传平台，WebUI 写死为 `webui`，也不回来源层）。
