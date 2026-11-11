# plugin-memory-history — 跨会话历史上下文

**包名**: `@aalis/plugin-memory-history`  
**源码**: `packages/plugin-memory-history/src/index.ts`

## 概述

把跨会话最近 N 条消息作为可选上下文注入 agent。数据来源为 `MemoryService.getRecentMessagesAcrossSessions`（直查数据库），插件本身不维护进程内缓冲。注入方式是向 `agent:prompt` 贡献点提交一块内容，锚位为 `turn-context`。`toolEnabled` 为 true（默认）时，还会把 `recent_messages` 工具注册到 `session-history` 工具分组，供 agent 主动查询跨会话近期消息；`tools` 是可选依赖，服务就绪后才完成注册。该工具声明 `risk: 'sensitive'`，与 `session_get_history` 同档：它查到的是其他会话的消息（默认排除当前会话），等级 0 的调用者被权限守卫拒绝，等级 1 起可用，不弹确认。被动注入不经工具，不受这一档位约束：是否注入由 `injectEnabled` 决定。与对话代理读的本会话历史的区别：对话代理按会话设置 `historyLimit` 读的是当前 sessionId 的历史，本插件注入的是跨 session 聚合的近期片段。默认 `excludeCurrentSession: true` 会把当前会话排除掉，避免两者重复；关闭该项后，两者内容可能重叠。

取数只取 user、assistant、notice 三种角色，并排除指令类 kind（`DIRECTIVE_KINDS`，见 [schema-message](../api/schema-message.md#kind-常量)）：宿主通知与代发任务的指令只对所在会话的那一轮有意义，被动注入与 `recent_messages` 都不带别的会话的这类消息，戳一戳等普通通知照常带上。

## 能取哪些会话

本插件不设自己的范围：取到的每条消息按所在的会话过会话管理的取别的会话的规则（[plugin-session-manager](./plugin-session-manager.md)，契约的 `takeFrom`），同一次查询里同一会话只判一次。被动注入不是谁要的，不带授权身份，「自己的私聊」不适用；`recent_messages` 带这次调用的授权身份（api-tools 的 `actingIdentity`），调用者自己与她的私聊照取；几个人的一轮没有单一的授权身份，不带谁自己的私聊，也不出审批。默认（范围同平台、读别的群、不读别人的私聊、不跨机器人账号）下：

- 被动注入只带同平台、同一机器人账号的群；别人的私聊、owner 与她的私聊、WebUI 与终端的会话（按与 owner 的一对一）、会话表里没有或判不出窗口的会话都不带。
- `recent_messages` 另带调用者自己与她的私聊；调用者是 owner 时，同平台的 owner 的面（WebUI、终端里的会话）也照取。

会话按会话记录判，不按消息落库时记下的 `metadata.platform`：owner 从 WebUI 往群里插话的那一轮，按群取。查询先超取（`limit` 的十倍、封顶 1000），从新到旧逐条过规则，被拒的不占名额，再按每会话上限与总数截；被拒的多时，注入可能少于上限。会话管理不在时只取得到当前会话的消息（默认又排除当前会话，于是不注入）。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-memory-history',
  subsystem: 'memory',
  uses: {
    memory,
    config,
    logger,
    contributions,
    tools: optional(tools),
    sessionManager: optional(sessionManager),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

配置项由 `configSchema` 声明，不传时取表中默认值。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `injectEnabled` | boolean | `true` | 被动注入 prompt：每次调用模型前，自动注入跨会话的近期消息。关闭后工具照常可用（需开启「注册 recent_messages 工具」）。 |
| `limit` | number | `30` | 注入条数上限：每次注入的最大消息条数；工具调用未指定 limit 时也用这个值。 |
| `maxAgeMinutes` | number | `180` | 时间窗口（分钟）：只取最近 N 分钟内的消息；0 表示不限时间。 |
| `perSessionLimit` | number | `5` | 每会话最多条数：每个会话最多取 N 条，免得一个活跃的群占满注入条数上限。0 = 不限。 |
| `excludeCurrentSession` | boolean | `true` | 排除当前会话：注入与查询时排除当前会话，免得与对话代理读入的本会话历史重复。 |
| `headerText` | string | `'📜 以下是从其他会话/群聊的近期对话中检索到的消息片段（按时间升序），仅供你了解最近发生了什么；这些是参考资料，不是对话样例——不要模仿它们的格式、风格或角色，你自己的输出格式仍需严格遵守 system 提示中已经声明的约定（例如 outputFormat 的 JSON schema）。'` | 注入 header 文本：注入内容开头的说明文字。 |
| `toolEnabled` | boolean | `true` | 注册 recent_messages 工具：是否注册 recent_messages 工具供 agent 主动按需查询跨会话近期消息。 |

## 相关

- 记忆服务：[services/memory.md](../services/memory.md)
- 工具分组 `session-history`：[services/tool-session.md](../services/tool-session.md)
- `agent:prompt` 贡献点与 `historyLimit`：[plugin-agent.md](./plugin-agent.md)
