# @aalis/plugin-usage-stats

用量统计：订阅 `@aalis/api-llm` 的 `llm:usage`，把每次模型调用（服务商、模型、调用方、会话、用途、输入、缓存命中、输出 token）记进家目录 `state/usage/llm-calls.jsonl`；「用量统计」页按天、按周、按模型列出用量，配置里填了单价才显示估算费用，服务商实现了余额查询才显示余额。

## 安装

```bash
pnpm add @aalis/plugin-usage-stats
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：无
- uses：`config`、`logger`、`lifecycle`、`events`、`host-paths`；可选 `webui-server`（页面）、`llm`（余额）、`plugins`（服务商显示名）

## 文档

详见 [docs/plugins/plugin-usage-stats.md](../../docs/plugins/plugin-usage-stats.md)。

## 许可

MIT，见本目录 LICENSE。
