# plugin-tool-session — 会话工具

**包名**: `@aalis/plugin-tool-session`  
**源码**: `packages/plugin-tool-session/src/index.ts`

## 概述

注册 `session-history` 服务与 `session_get_history` 工具，按 Aalis sessionId 读取指定会话的消息，支持按条数读取最近消息，或按时间区间（`within_minutes` 或 `since`/`until`）检索。默认仅允许读取同平台范围内的会话，避免被当作全局搜索工具误用（语义检索请用 `memory_recall`）。「同平台」比较当前会话的平台与目标会话 ID 第一个 `:` 之前的一段：当前会话是 IM 房间（群与私聊，含其子任务）时取房间的出生平台（[api-gateway](../api/api-gateway.md#出生平台解析) 的 `resolveSessionOrigin`），不论这一轮从哪个入口驱动；没有出生平台的会话（WebUI、CLI 等）取入口平台。房间的召回范围（会话配置 `memoryRecallScope`）为 `platform` 时的裁决同一取法。

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
| `session-history` | `session_get_history` | 按 sessionId 读取近期消息（受 scope 限制） |

`enabled` 为 false 时本插件不注册任何服务与工具。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用会话历史读取工具 |
| `maxLimit` | number | `100` | 单次最多读取条数：session_get_history 一次能返回的硬上限；LLM 传入 limit 超过此值会被 cap。建议 50~200。 |
| `defaultLimit` | number | `20` | 默认读取条数（LLM 不传 limit 时）：不能超过 maxLimit。调高可让 agent 被动获取更多上下文，代价是 token 预算。 |
| `scope` | select | `'platform'` | 允许读取范围 |
| `includeArchivedDefault` | boolean | `false` | 默认包含已归档消息 |
| `perMessageMaxChars` | number | `0` | 每条消息截断字数：返给 LLM 的每条历史消息的字符上限；0 = 不截断（推荐）。超出会以「剩余 N 字符未展示」明示。 |

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
  registerAccessChecker(checker: AccessChecker): AccessCheckerDisposer;
}
```

平台插件可用 `registerAccessChecker` 按平台前缀注入访问规则，同平台多个 checker 任一返回 deny 即拒绝。

读取别的会话时依次裁决，前一步拒绝即止：

1. **房间的召回范围**：当前会话的会话配置 `memoryRecallScope`（见 [api-session-manager](../api/api-session-manager.md)）为 `session` 时，目标不是当前会话一律拒绝（「本房间的召回范围限于本会话」）；为 `platform` 时，目标平台与当前平台不同就拒绝。未设置或 session-manager 不在场时跳过这一步。房间范围每次读取时现算。
2. **插件的 `scope`**：`current` / `platform` / `all` 粗筛。
3. **平台规则**：匹配目标平台的 checker 链，任一 deny 即拒绝。

平台规则只能在前两步放行之后再收窄。`session_get_history` 与 plugin-tool-onebot 的 `onebot_get_session_history` 都经这个服务读取，房间的召回范围一处管住两个工具。

## 历史

本包由原 `plugin-session-tools` 拆分而来（另一部分为 `plugin-subtask`），跨会话委派工具随后也并入本包。

跨会话委派工具组 `session-delegate`（`list_known_sessions` 与 `delegate_to_session`）与配置项 `crossSessionEnabled` / `crossSessionDefaultTimeoutSec` 已删除：`list_known_sessions` 不按调用者过滤，把各会话的最近一条消息交给任何触发者；`delegate_to_session` 让多人平台上的任何人都能把任务派进其他会话（包括 owner 的 WebUI 会话），并把目标会话的回复带回来源会话。会话之间的协作将以「会话间消息」重新设计：权限跟随消息链的源头，工具取接收会话自己的，会话之间互不信任。迁移说明见 CHANGELOG。
