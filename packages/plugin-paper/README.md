# @aalis/plugin-paper

白纸枢纽。房间里真人提需求，她调 `paper_task` 把任务交给远端代理（`remote-agent` 提供者，如 `@aalis/plugin-remote-agent-cursor`）；宿主先在房间里回显原文，受理后排队、按天记账。运行驱动按白纸依次开轮、跟踪到终态（单轮有时长上限）、把成品取回白纸根（`paper:/`），按轮的实际费用入账，并定期对账（发现代理自己唤醒出来的轮次就取消、删除代理并停开白纸）。任务到终态后以宿主通知回到发起房间（远端说明只在那一轮以不可信数据出现，不进历史），她用 `paper_send` 把图片、MP4 或单个网页发回；没发回的成品在之后的对话里一直有待交付提示。owner 在 WebUI 白纸页看白纸、任务、成品、账本与告警，并做换新、归档代理、清空、恢复、取消任务与告警已读；成品在页面里只有位图能直接查看，其余（含 HTML、SVG）只能下载。

## 安装

```bash
pnpm add @aalis/plugin-paper
```

## 提供 / 依赖

`definePlugin` 默认导出：

- 工具（`paper` 分组）：`paper_task`、`paper_status`、`paper_cancel`、`paper_send`
- 钩子：`agent:llm:before`（待交付提示）
- WebUI 页面 `paper`（白纸、任务、成品、账本、告警五个表）与它的页面动作
- 诊断项 `paper.config`
- uses：`tools`、`session-manager`、`storage`、`events`、`hooks`、`lifecycle`、`logger`、`config`；可选 `remote-agent`、`gateway`、`webui-server`、`doctor`

房间在会话配置里开启白纸（`paperEnabled`、`paperName`、`remoteAgentTypes`、`remoteAgentRoomDailyCents` 等）；白纸的属性（换新、闲置归档、定期清空）、全局每天金额上限、换日时区、单轮时长、成品上限、能否发网页与待交付提示的保留时长在本插件配置里。账本落在 `pluginData:/paper/ledger.json`，读不出时远端任务一律不开、原文件不覆盖。激活时不连网，进行中的任务在激活之后接回。

## 文档

详见 [docs/plugins/plugin-paper.md](../../docs/plugins/plugin-paper.md)。

## 许可

见仓库根目录 LICENSE。
