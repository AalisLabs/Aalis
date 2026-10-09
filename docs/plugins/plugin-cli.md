# plugin-cli — 命令行交互

**包名**: `@aalis/plugin-cli`  
**源码**: `packages/plugin-cli/src/index.ts`

## 概述

命令行 REPL 交互平台，同时作为 `CLIService` 和 `PlatformAdapter`，并登记 `cli` 审批面：终端在场时，需要 owner 批准的操作以审批卡出现在终端里。

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
    storage: optional(storage),
    persona: optional(persona),
    approvals: optional(approvals),
    plugins: optional(pluginsService),
    commands: optional(commands),
    sessionManager: optional(sessionManager),
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
| `maxLogEntries` | number | `50000` | 日志内存缓冲上限（条）：日志页内存驻留的最大条数，超出后从最旧成块丢弃；完整日志始终在家目录的 logs/latest.log |
| `startupView` | select | `'last'` | 启动视图：CLI 接管终端后的默认视图。last 表示恢复上次视图 |

## 特性

- 注册为 `PlatformAdapter`（平台: `cli`）
- 监听本会话的 `outbound:stream`（流式渲染）与 `outbound:message`（同一轮已流式输出时跳过，避免重复），将 AI 回复显示到终端。发往本会话的消息写出即算送达，CLI 同步认领投递回执，纯文本（如作品通知）也一样；跳过的流式重复正文已经写出，同样算送达
- 附件（`send_attachment`、`paper_send` 等发来的图片、视频、音频、文件）：终端显示不了图片本身，每件写一行说明「[图片] 名称 · 大小 · 本机路径」（取不到本机路径时写存储地址，网址照写），在支持超链接的终端里路径可以点开。写出即算送达：CLI 认领这条消息的投递回执并发出 `outbound:delivered`，附件照常归档。附件消息里的空正文不写成空行
- `app:started` 后接管终端进入全屏界面；stdin / stdout 任一不是 TTY（日志重定向、容器、systemd）时不接管、不画界面，控制台日志照常输出，发往 cli 会话的消息退化为一行日志
- 平台连接：界面在跑时一条在线的连接；不画界面时没有连接（运行状况写「没有连接」，不算离线）
- 欢迎行下面的指路：界面起来后等插件状态静置（`plugins.idle()`），有失败或缺服务的插件时在聊天页加一行「有 N 个插件没起来，输入 /doctor 查看原因与修法」，N 是失败（`error`）的与缺服务的（按 api-doctor 的共享判据 `unmetDependencies`，只在等别的插件启动的不算）之和，与 `/doctor` 的「失败」「未就绪」两项之和一致；`commands` 服务里没有 `doctor` 指令时改说「按 Ctrl+L 看日志」，都起来了不加这一行
- 用户输入经 `inbound:message` 事件发出（`platform: 'cli'`，`userId: 'console'`，即本地终端身份）。发出之前确认配置的会话已建档：会话表里没有它（第一次发消息、会话被删之后）就建档，创建来源写本插件登记的审批面名 `cli`，与 WebUI 新建的会话一样是 owner 的会话；已有的记录不改。没装会话管理时不建档。配置的 id 由别的平台适配器认领（如配成了 OneBot 的群 id）时不建档、不写创建来源，告警一次：配错的 id 不能把别人的窗口变成 owner 自己的会话。提交的各行依次发出，建档期间后一行（如一次粘贴的多行）不越过前一行；一行没发出去记 warn，不挡后面的行
- 斜杠指令不在本插件内解析，由 `commands` 服务（plugin-commands）在 `inbound:command` 相位统一处理（如 `/help`、`/status`），执行结果经 `outbound:message` 回显到终端
- 指令的意图确认（权限模型轴 B）：声明了 `confirm` 的指令由 plugin-commands 把确认提示作为消息发进聊天区，在输入框回复 `y` 后回车即确认，其它输入取消，60 秒无回复视为取消；回复在 `inbound:command` 相位被吞掉，不会当成对话发给模型。在 logs/status/help 视图下有消息（含确认提示）进入聊天区时，header 的 CHAT 页签会带计数高亮，Ctrl+T 切回 chat 即可看到并回答
- sessionId 默认为 `cli-default`
- 欢迎行、头部、回复前的署名与状态页写的人设名，按终端会话生效的「人设」取卡（会话管理的 `resolveConfig`，入口平台 `cli`），与回合同一口径；没装会话管理时是人设服务的主卡
- 审批面：激活时经 `approvals.registerSurface('cli')` 登记 `cli` 审批面，终端界面启动后以本地终端身份（`platform: 'cli'`，`userId: 'console'`）接入，审计里的审批面记为 `cli` 与本插件实例。详见下文「审批卡」
- 切换视图时（help 视图除外）经 `host-config` 把 `lastView` 写回配置文档并落盘；宿主未提供配置文档时不记录，下次启动回到默认视图

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
| `←` / `→` | 审批卡在时：选批准 / 拒绝，`Enter` 确定 |
| `Ctrl+Y` / `Ctrl+N` | 审批卡在时：批准 / 拒绝 |

## 审批卡

需要 owner 批准的工具调用（契约见 [api-approval](../api/api-approval.md)）在终端在场时推到这里：

- **在场**：终端界面里每次按键都向审批服务上报在场，任何视图都算；最近一次按键在审批服务的时限内（默认实现是 10 分钟，见 [plugin-session-server](./plugin-session-server.md#审批)）才算在场。界面刚启动、还没按过键时不算在场。stdin / stdout 不是 TTY、不起界面时，终端不接入审批面，从不算在场。权限服务不认本地终端身份是 owner 时，终端按了键也不算在场，审批不推到这里。没有任何在场的审批面时，审批由审批服务立即按没人在场拒绝，模型收到原因后继续。
- **显示**：审批推来时，输入框的位置换成审批卡，任何视图都显示。卡上写工具名与会话，下面是事实：命令、工作目录、文件与改动（按工具声明的展示种类取，如 file_edit、file_write、file_append 的 diff；疑似含密钥的只给文件名）、其余参数；没声明展示种类的工具逐字列出全部参数。事实显示前一律经 `sanitizeForCard` 清洗：控制符与 ANSI 转义序列转义成 `\x1B` 的样子，双向控制符与零宽字符换成 `⟨U+202E⟩` 的样子，制表符按空格显示，原样的控制符不会写到终端。每项事实超过 1000 字时保留首尾、写明省略了多少字；卡片最多高到聊天区只剩 3 行，放不下的保留首尾几行、写明省略了多少行。
- **模态应答**：卡片在时，除了切换视图（`Ctrl+T`/`Ctrl+L`/`Ctrl+S`/`Ctrl+G`/`Esc`）与退出（`Ctrl+C`），按键只用来应答。卡片推出时两项都不选中：`←` 选批准、`→` 选拒绝，`Enter` 确定选中的一项；也可以直接按 `Ctrl+Y` 批准、`Ctrl+N` 拒绝。没选中时按 `Enter` 不算应答；打字不进输入框、也不算应答，免得正在打字时误批。终端原本不在场、按键让它变为在场而补推来的卡，不接这次按键（这次按键照常处理），从下一次按键起才算应答。卡片之前输入框里的内容保留，卡片关掉后接着编辑。终端里的拒绝不附说明，要附说明在 WebUI 里应答。
- **几张卡**：不同会话的审批可以同时在，按推来的先后排，卡上只显示第一张并写明还有几张；答完或它在别处结算后显示下一张，下一张从不选中开始。
- **结算**：审批结算了（在这里或别的审批面应答、等满时限、回合结束或中止、审批服务停止），卡片关掉，聊天区留一行「审批 工具名：已批准 / 已拒绝 / 没有人应答，按拒绝处理 / 已撤销」。应答被审批服务拒绝时（例如卡片推出之后 owner 名单变了，权限服务不再认本地终端身份是 owner）同样关卡，并写明原因，审批照旧等别的审批面应答。

## 配置校验

`startupView` 还支持 `help`。`sessionId` 的显式无效值会拒绝激活，避免改接默认会话；`maxLogEntries` 接受数字字符串，0 仍取默认值，小于 1000 时仍夹到 1000。`lastView` 不在已知视图内时仍回落 `chat`。
