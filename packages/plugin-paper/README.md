# @aalis/plugin-paper

白纸枢纽。房间里真人提需求，她调 `paper_task` 把任务交给远端代理（`remote-agent` 提供者，如 `@aalis/plugin-remote-agent-cursor`）；宿主先在房间里回显原文，受理后排队、按天记账。运行驱动按白纸依次开轮、跟踪到终态（单轮有时长上限）、把成品取回白纸根（`paper:/`），按轮的实际费用入账，并定期对账（发现代理自己唤醒出来的轮次就取消、删除代理并停开白纸）。

## 安装

```bash
pnpm add @aalis/plugin-paper
```

## 提供 / 依赖

`definePlugin` 默认导出：

- 工具（`paper` 分组）：`paper_task`、`paper_status`、`paper_cancel`
- uses：`tools`、`session-manager`、`storage`、`events`、`lifecycle`、`logger`、`config`；可选 `remote-agent`、`gateway`、`doctor`

房间在会话配置里开启白纸（`paperEnabled`、`paperName`、`remoteAgentTypes`、`remoteAgentRoomDailyCents` 等）；白纸的属性（换新、闲置归档、定期清空）、全局每天金额上限、换日时区、单轮时长与成品上限在本插件配置里。账本落在 `pluginData:/paper/ledger.json`，读不出时远端任务一律不开、原文件不覆盖。激活时不连网，进行中的任务在激活之后接回。

## 文档

详见 [docs/plugins/plugin-paper.md](../../docs/plugins/plugin-paper.md)。

## 许可

见仓库根目录 LICENSE。
