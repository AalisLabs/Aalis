# @aalis/plugin-paper

白纸枢纽。房间里真人提需求，她调 `paper_task` 把任务交给远端代理（`remote-agent` 提供者，如 `@aalis/plugin-remote-agent-cursor`）；宿主先在房间里回显原文，受理后排队、按天记账。

## 安装

```bash
pnpm add @aalis/plugin-paper
```

## 提供 / 依赖

`definePlugin` 默认导出：

- 工具（`paper` 分组）：`paper_task`、`paper_status`、`paper_cancel`
- uses：`tools`、`session-manager`、`storage`、`events`、`lifecycle`、`logger`、`config`；可选 `remote-agent`、`gateway`、`doctor`

房间在会话配置里开启白纸（`paperEnabled`、`paperName`、`remoteAgentTypes`、`remoteAgentRoomDailyCents` 等）；白纸的属性、全局每天金额上限与换日时区在本插件配置里。账本落在 `pluginData:/paper/ledger.json`，读不出时远端任务一律不开、原文件不覆盖。激活时不连网。

## 文档

详见 [docs/plugins/plugin-paper.md](../../docs/plugins/plugin-paper.md)。

## 许可

见仓库根目录 LICENSE。
