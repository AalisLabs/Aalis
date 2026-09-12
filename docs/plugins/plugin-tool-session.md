# plugin-tool-session — 会话工具

**包名**: `@aalis/plugin-tool-session`  
**源码**: `packages/plugin-tool-session/src/index.ts`

## 概述

注册 `session-history` 服务与 `session_get_history` 工具，按 Aalis sessionId 读取指定会话的消息，支持按条数读取最近消息，或按时间区间（`within_minutes` 或 `since`/`until`）检索；启用跨会话委派时另注册 `list_known_sessions` 与 `delegate_to_session`，用于向其他已存在的会话派发任务。默认仅允许读取同平台范围内的会话，避免被当作全局搜索工具误用（语义检索请用 `memory_recall`）。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-session'
meta.subsystem = 'session'
meta.provides = ['session-history']
meta.inject = { optional: ['memory'] }
```

## 注册工具组

| 工具组 | 工具 | 说明 |
|---|---|---|
| `session-history` | `session_get_history` | 按 sessionId 读取近期消息（受 scope 限制） |
| `session-delegate` | `list_known_sessions` | 列出最近活跃过的会话，供派发前发现目标 sessionId |
| `session-delegate` | `delegate_to_session` | 向指定目标会话派发一次任务，可选等待结果 |

`session-delegate` 组仅在 `enabled` 与 `crossSessionEnabled` 均为 true 时注册；`enabled` 为 false 时本插件不注册任何服务与工具。

## 跨会话委派的防雪崩

委派深度随消息走：`delegate_to_session` 给目标会话注入的 `IncomingMessage` 带 `proactiveDepth`（首跳为 1），目标会话处理这条消息的那一个回合内不能再委派，调用会以「本回合由委派消息驱动，不能再委派」被拒。回合结束（`agent:turn:after`）即解除；该会话之后由下一条不带 `proactiveDepth` 的入站消息（真人消息、idle/interval 自动触发都算）驱动的回合不受影响。没有时间窗——等多久都不会自动解除，解除只来自回合结束或该会话的下一条不带 `proactiveDepth` 的入站消息。登记点在 `agent:input:before`，因此经 `inbound:message` 事件与直接调 `gateway.ingressMessage()` 两条投递路径同样生效。

锁按 sessionId 记，是按会话近似回合：同会话不同 source 的并行回合共用同一把锁，后开始的回合会覆盖前一个的登记，先结束的回合会替所有人解锁。

另有两道与深度无关的闸门：平台适配器可声明 `checkAndRecordProactiveSend` 做主动发送限速；同一目标会话 60 秒内的重复派发会在任务前注入 META 提醒（提醒型，不拦截派发本身）。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用会话历史读取工具 |
| `maxLimit` | number | `100` | 单次最多读取条数：session_get_history 一次能返回的硬上限；LLM 传入 limit 超过此值会被 cap。建议 50~200。 |
| `defaultLimit` | number | `20` | 默认读取条数（LLM 不传 limit 时）：不能超过 maxLimit。调高可让 agent 被动获取更多上下文，代价是 token 预算。 |
| `scope` | select | `'platform'` | 允许读取范围 |
| `includeArchivedDefault` | boolean | `false` | 默认包含已归档消息 |
| `perMessageMaxChars` | number | `0` | 每条消息截断字数：返给 LLM 的每条历史消息的字符上限；0 = 不截断（推荐）。超出会以「剩余 N 字符未展示」明示。 |
| `crossSessionEnabled` | boolean | `true` | 启用跨会话委派 (delegate_to_session / list_known_sessions)：允许 agent 列出其他活跃会话并向其派发任务（如私聊→群聊、跨平台委派）。受 proactive-depth 与平台限速保护。 |
| `crossSessionDefaultTimeoutSec` | number | `60` | 跨会话委派默认等待秒数：delegate_to_session 在未显式指定 timeout_seconds 时使用的等待上限。 |

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

## 历史

本包由原 `plugin-session-tools` 拆分而来（另一部分为 `plugin-subtask`），跨会话委派工具随后也并入本包。
