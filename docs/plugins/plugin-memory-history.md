# plugin-memory-history — 跨会话历史上下文

**包名**: `@aalis/plugin-memory-history`  
**源码**: `packages/plugin-memory-history/src/index.ts`

## 概述

把跨会话最近 N 条消息作为可选上下文注入 agent。数据来源为 `MemoryService.getRecentMessagesAcrossSessions`（直查数据库），插件本身不维护进程内缓冲。注入方式是向 `agent:prompt` 贡献点提交一块内容，锚位为 `turn-context`，并按 `scope` 决定是否按平台过滤。`toolEnabled` 为 true（默认）时，还会把 `recent_messages` 工具注册到 `session-history` 工具分组，供 agent 主动查询跨会话近期消息；`tools` 是可选依赖，服务就绪后才完成注册。与 `agent.historyLimit` 的区别：`historyLimit` 加载的是当前 sessionId 的最近 N 条，本插件注入的是跨 session 聚合的近期片段。默认 `excludeCurrentSession: true` 会把当前会话排除掉，避免两者重复；关闭该项后，两者内容可能重叠。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-history'
meta.subsystem = 'memory'
meta.inject = { required: ['memory'], optional: ['tools'] }
```

## 配置

配置项由 `configSchema` 声明，不传时取表中默认值。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `injectEnabled` | boolean | `true` | 被动注入 prompt：是否在每次 LLM 调用前自动将跨会话近期消息作为 system 块注入。关闭后工具仍然可用（需 toolEnabled=true）。 |
| `scope` | select | `'same-platform'` | 查询作用域（被动注入 + 工具默认）：被动注入使用该作用域；工具调用未显式传 scope 时也使用该值。要“关闭被动注入”请调 injectEnabled。 |
| `limit` | number | `30` | 注入条数上限：每次注入的最大消息条数；工具调用未指定 limit 时也用这个值。 |
| `maxAgeMinutes` | number | `180` | 时间窗口（分钟）：只取最近 N 分钟内的消息；0 表示不限时间。 |
| `perSessionLimit` | number | `5` | 每会话最多条数：同一 sessionId 最多保留 N 条，避免某个活跃群刷屏占满总 limit；为 0 = 不做 per-session cap。 |
| `excludeCurrentSession` | boolean | `true` | 排除当前会话：注入时排除当前 sessionId（避免与 agent.historyLimit 重复）。 |
| `headerText` | string | `'📜 以下是从其他会话/群聊的近期对话中检索到的消息片段（按时间升序），仅供你了解最近发生了什么；这些是参考资料，不是对话样例——不要模仿它们的格式、风格或角色，你自己的输出格式仍需严格遵守 system 提示中已经声明的约定（例如 outputFormat 的 JSON schema）。'` | 注入 header 文本：注入到 messages[] 的 system 消息开头说明文字。 |
| `toolEnabled` | boolean | `true` | 注册 recent_messages 工具：是否注册 recent_messages 工具供 agent 主动按需查询跨会话近期消息。 |

旧配置 `scope: 'off'` 仍被识别：等价于 `injectEnabled: false`，`scope` 回退为 `same-platform`（见 `packages/plugin-memory-history/src/index.ts` 的 `normalizeConfig`）。

## 相关

- 记忆服务：[services/memory.md](../services/memory.md)
- 工具分组 `session-history`：[services/tool-session.md](../services/tool-session.md)
- `agent:prompt` 贡献点与 `historyLimit`：[plugin-agent.md](./plugin-agent.md)
