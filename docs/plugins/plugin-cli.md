# plugin-cli — 命令行交互

**包名**: `@aalis/plugin-cli`  
**源码**: `packages/plugin-cli/src/index.ts`

## 概述

命令行 REPL 交互平台，同时作为 `CLIService` 和 `PlatformAdapter`。

## 插件声明

```typescript
meta.name = '@aalis/plugin-cli'
meta.provides = ['cli', 'platform']
meta.inject = { optional: ['llm'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `prompt` | string | `You` | 输入提示符 |

## 特性

- 注册为 `PlatformAdapter`（平台: `cli`）
- 监听 `outbound:message` 打印 AI 回复到终端
- `ready` 事件后启动 readline 循环
- 用户输入经 `inbound:message` 事件送给 Agent 处理
- 支持斜杠指令（`/help`、`/status` 等）解析
- 高危操作确认（通过 `setConfirmHandler` 注册终端交互）
- sessionId 默认为 `cli-default`
