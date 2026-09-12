# plugin-cli — 命令行交互

**包名**: `@aalis/plugin-cli`  
**源码**: `packages/plugin-cli/src/index.ts`

## 概述

命令行 REPL 交互平台，同时作为 `CLIService` 和 `PlatformAdapter`。

## 插件声明

```typescript
meta.name = '@aalis/plugin-cli'
meta.provides = ['cli', 'platform']
meta.inject = { optional: ['llm', 'authority', 'commands'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sessionId` | string | `'cli-default'` | 默认会话 ID：CLI 聊天所在的会话标识。 |
| `lastView` | string | `'chat'` | 上次视图：运行时自动写回；startupView=last 时启动恢复到这里记录的视图。 |
| `prompt` | string | `'You'` | 提示符：命令行输入提示符前缀 |
| `maxLogEntries` | number | `50000` | 日志内存缓冲上限（条）：日志页内存驻留的最大条数，超出后从最旧成块丢弃；完整日志始终在 data/latest.log |
| `startupView` | select | `'last'` | 启动视图：CLI 接管终端后的默认视图。last 表示恢复上次视图 |

## 特性

- 注册为 `PlatformAdapter`（平台: `cli`）
- 监听本会话的 `outbound:stream`（流式渲染）与 `outbound:message`（同一轮已流式输出时跳过，避免重复），将 AI 回复显示到终端
- `app:started` 后接管终端进入全屏界面；stdin / stdout 任一不是 TTY（日志重定向、容器、systemd）时不接管、不画界面，控制台日志照常输出，发往 cli 会话的消息退化为一行日志
- 用户输入经 `inbound:message` 事件发出（`platform: 'cli'`，`userId: 'console'`，即本地终端身份）
- 斜杠指令不在本插件内解析，由 `commands` 服务（plugin-commands）在 `inbound:command` 相位统一处理（如 `/help`、`/status`），执行结果经 `outbound:message` 回显到终端
- 意图确认（权限模型轴 B）：TUI 启动后经 `whenService('authority')` 注册终端确认通道 `setConfirmHandler('cli', …)`——跟着 authority 的胜者走，authority 后到或 bounce 后自动重挂，TUI 停止时注销并把在飞的确认按取消结算；声明了 `confirm` 的操作在 CLI 会话里按 y 确认、其他键取消，多个并发确认先到先问；非交互终端下不注册，CLI 会话落到 `'*'` 兜底通道
- sessionId 默认为 `cli-default`
