# plugin-tool-session — 会话历史读取工具

**包名**: `@aalis/plugin-tool-session`  
**源码**: `packages/plugin-tool-session/src/index.ts`

## 概述

注册 `session_get_history` 工具与 `session-history` 服务，按 Aalis sessionId 读取指定会话最近若干条消息。默认仅允许读取同平台范围内的会话，避免被当作全局搜索工具误用（语义检索请用 `memory_recall`）。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-session'
meta.subsystem = 'session'
meta.provides = ['session-history']
meta.inject = { optional: ['memory'] }
```

## 注册工具组

`session-history`

| 工具 | 说明 |
|---|---|
| `session_get_history` | 按 sessionId 读取近期消息（受 scope 限制） |

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 启用工具与服务 |
| `maxLimit` | number | 30 | 单次最多读取条数（1-100） |
| `scope` | `'current' \| 'platform' \| 'all'` | `platform` | 允许读取范围 |
| `includeArchivedDefault` | boolean | false | 调用未显式指定时是否包含已归档消息 |

## 提供的服务

`session-history`

```typescript
interface SessionHistoryService {
  getHistory(
    options: { sessionId: string; limit?: number; includeArchived?: boolean },
    callCtx: ToolCallContext,
  ): Promise<{ ok: true; ... } | { error: string }>;
}
```

## 历史

会话历史读取从 `plugin-session-tools`（现 `plugin-subtask`）拆出独立成包。
