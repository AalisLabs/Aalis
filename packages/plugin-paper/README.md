# @aalis/plugin-paper

白纸枢纽。房间里真人提需求，她调 `paper_task` 把任务交给远端代理（`remote-agent` 提供者，如 `@aalis/plugin-remote-agent-cursor`）；受理后排队、按天记账，由前台自然确认，不额外回显任务原文。运行驱动按白纸依次开轮、跟踪到终态（单轮有时长上限）、把成品取回白纸根（`paper:/`），按轮的实际费用入账，并定期对账（发现代理自己唤醒出来的轮次就取消、删除代理并停开白纸）。明确 `publish: false` 的任务到终态后以宿主通知回到发起房间（远端说明只在那一轮以不可信数据出现，不进历史），她用 `paper_send` 把图片、MP4 或单个网页发回；没发回的成品在之后的对话里一直有待交付提示。owner 在 WebUI 白纸页看白纸、任务、成品、账本与告警，并做换新、归档代理、清空、恢复、取消任务与告警已读；成品在页面里只有位图能直接查看，其余（含 HTML、SVG）只能下载。

新创作默认自动上线：`paper_task({ text, name })` 在任务受理时记录发布意图，完成后按配置审核、部署并核验，再通知作品链接。发布到白纸默认或唯一获准的目标。明确不公开、只交文件或仅交付工程源码时传 `publish: false`；已有任务不会因升级补上发布意图。

## 安装

```bash
pnpm add @aalis/plugin-paper
```

## 提供 / 依赖

`definePlugin` 默认导出：

- 工具（`paper` 分组）：`paper_task`、`paper_status`、`paper_cancel`、`paper_send`
- 钩子：`agent:llm:before`（待交付提示）
- WebUI 页面 `paper`（白纸、任务、创作日志、成品、账本、告警六个标签页）与它的页面动作
- 诊断项 `paper.config`
- uses：`tools`、`session-manager`、`storage`、`events`、`hooks`、`lifecycle`、`logger`、`config`；可选 `remote-agent`、`gateway`、`webui-server`、`doctor`

房间在会话配置里开启白纸（`paperEnabled`、`paperName`、`remoteAgentTypes`、`remoteAgentRoomDailyCents` 等）；白纸的属性（换新、闲置归档、定期清空）、全局每天金额上限、换日时区、单轮时长、成品上限、能否发网页与待交付提示的保留时长在本插件配置里。账本落在 `pluginData:/paper/ledger.json`，读不出时远端任务一律不开、原文件不覆盖。激活时不连网，进行中的任务在激活之后接回。

支持进度的提供者会报告规划、读写文件、执行命令等动作。WebUI 任务表显示最近动作、时间和可用的工具、目标、摘要、退出码；`paper_status` 与聊天只显示固定动作类别和状态，不提供原始日志。动作不代表完成百分比。Cursor 的 thinking 事件只记“规划中”，不记录思维正文。

每件任务的创作日志按事件存于 `pluginData:/paper/task-logs/<任务 id>/`，包括任务原文、实际发送的 prompt、公开的代理回复、工具输入与输出、连接与重连、取回、费用和发布过程。WebUI「创作日志」可看最近记录、下载完整 JSONL，或手动删除已结束且不在发布中的日志；任务表也可下载。WebUI 单次下载上限为 20 MiB，超出时完整记录仍在本机目录。日志长期保留，清空白纸和账本任务过期不会自动删除；旧任务未采集的事件无法补齐，存储故障可能造成缺口并标记不完整。已知密钥和常见凭据会脱敏，但不能保证识别任意秘密。

超时或失败仍会尝试取回已经导出的成品，保留绑定的远端工作区供下一件任务继续。换新需要旧工程包；缺包且提供者未变时先在原工作区继续，换提供者时则停止换新，不从空工程冒充恢复。仅保存在远端工作目录的草稿不等于已有本机备份；清空白纸仍会删除工程与本机成品。

## 文档

详见 [docs/plugins/plugin-paper.md](../../docs/plugins/plugin-paper.md)。

## 许可

见仓库根目录 LICENSE。
