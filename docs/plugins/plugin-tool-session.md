# plugin-tool-session — 会话工具

**包名**: `@aalis/plugin-tool-session`  
**源码**: `packages/plugin-tool-session/src/index.ts`

## 概述

注册 `session-history` 服务与 `session_get_history` 工具，按 Aalis sessionId 读取指定会话的消息，支持按条数读取最近消息，或按时间区间（`within_minutes` 或 `since`/`until`）检索。不要把它当作全局搜索工具（语义检索请用 `memory_recall`）。读出的消息不含事件标记（schema-message 的 `CONTROL_KINDS`，如压缩分隔线、指令的回复）：它们不是对话内容，不交给模型；按条数读时多读一倍再去掉它们，取最后 `limit` 条；还是凑不满 `limit` 条时，结果带 `omittedNonConversation`，写明略去了几条非对话记录（没略去的不带）。

能读哪些会话按会话管理的取别的会话的规则（[plugin-session-manager](./plugin-session-manager.md)），本插件不另设范围：每次读都调契约的 `takeFrom`，当前会话取调用所在的会话，经工具调用上下文的 `approveFor` 逐个参与者判：都过照常读，某个参与者自己私聊里的、别人过不了的发一道参与者审批由他本人批，都过不了回原因。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-tool-session',
  subsystem: 'session',
  provides: [sessionHistory],
  uses: {
    tools: optional(tools),
    logger,
    config,
    provide,
    memory: optional(memory),
    sessionManager: optional(sessionManager),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 注册工具组

| 工具组 | 工具 | 说明 |
|---|---|---|
| `session-history` | `session_get_history` | 按 sessionId 读取近期消息（按会话管理的跨会话规则） |

`enabled` 为 false 时本插件不注册任何服务与工具。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用会话历史读取工具 |
| `maxLimit` | number | `100` | 单次最多读取条数：读取会话历史一次最多返回的条数，模型要的更多时按这个值算。建议 50~200。 |
| `defaultLimit` | number | `20` | 默认读取条数：模型没指定条数时读取的条数，不能超过「单次最多读取条数」。调高能给模型更多上下文，也更耗 token。 |
| `includeArchivedDefault` | boolean | `false` | 默认包含已归档消息 |
| `perMessageMaxChars` | number | `0` | 每条消息截断字数：返给模型的每条历史消息的字符上限；0 = 不截断（推荐）。超出的部分截掉，末尾标「…[已截断，还剩 N 个字符未展示]」。 |

## 提供的服务

`session-history`

```typescript
interface SessionHistoryService {
  getHistory(
    options: {
      sessionId: string;
      limit?: number;
      includeArchived?: boolean;
      sinceTs?: number;
      untilTs?: number;
    },
    callCtx: ToolCallContext,
  ): Promise<SessionHistoryReadResult>;
}
```

读别的会话的结果：规则放行时照常读出；不放行时回 `{ error: 原因 }`，原因是会话管理给的一句（如「取别的会话的范围限于同平台」）。会话管理不在、目标不在会话表里或判不出窗口时只读得到当前会话。`session_get_history` 与 plugin-tool-onebot 的 `onebot_get_session_history` 都经这个服务读取，同一条规则。
