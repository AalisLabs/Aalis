# plugin-cli — 命令行交互

**包名**: `@aalis/plugin-cli`  
**源码**: `packages/plugin-cli/src/index.ts`

## 概述

命令行 REPL 交互平台，同时作为 `CLIService` 和 `PlatformAdapter`。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-cli',
  provides: [cli, platform],
  uses: {
    events,
    logger,
    lifecycle,
    config,
    provide,
    services,
    hostConfig: optional(hostConfig),
    platform: optional(platform),
    app: optional(appService),
    storage: optional(storage),
    persona: optional(persona),
  },
  apply(caps) { /* 见源码 */ },
});
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
- 意图确认（权限模型轴 B）：CLI 不自建确认通道，走 plugin-session-confirm 的公共协调器（authority 的 `'*'` 回调）——声明了 `confirm` 的操作会把提示（含参数摘要）作为消息发进聊天区，在输入框回复 `y`（仅本次）或 `ys`（本会话放行）后回车，其它输入取消；回复在 `inbound:confirm` 相位被拦截，不会当成对话发给模型；多个并发确认按先到先问排队；确认提示只在 chat 视图可见可答；在 logs/status/help 视图下有消息（含确认提示）进入聊天区时，header 的 CHAT 页签会带计数高亮，Ctrl+T 切回 chat 即可看到并回答，60 秒无回复视为取消
- sessionId 默认为 `cli-default`

## 快捷键

CLI 接管终端后的按键（程序内按 `Ctrl+G` 可随时查看）：

| 按键 | 作用 |
|---|---|
| `Ctrl+T` | Chat —— 聊天 / 命令输入 |
| `Ctrl+L` | Logs —— 实时日志（**启动日志在这里**） |
| `Ctrl+S` | Status —— 服务与平台状态 |
| `Ctrl+G` | Help —— 快捷键帮助 |
| `Esc` | 返回上一个视图 |
| `Ctrl+C` | 退出程序 |
| `↑` / `↓` | 日志 / 状态页逐行滚动；chat 视图为历史记录回溯 |
| `PgUp` / `PgDn` | 翻页 |
| `Home` / `End` | 回到顶部 / 到底部 |
| `Ctrl+W` | 日志页：切换换行模式（多行完整展示） |
| `Enter` | 提交输入 |
| `Ctrl+J` | 插入换行（macOS 下的 Ctrl+Enter） |
| `Shift+Enter` | 插入换行（终端支持时） |
