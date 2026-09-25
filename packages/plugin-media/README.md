# @aalis/plugin-media

媒体处理：音视频/图片的转码与收发支撑

## 安装

```bash
pnpm add @aalis/plugin-media
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`media`
- uses：`logger`、`config`、`lifecycle`、`events`、`hooks`、`provide`、`proc`（`process`）、`storage`；可选 `llm`、`agent`、`asr`、`tools`、`memory`、`sessionManager`（`session-manager`）

## 文档

详见 [docs/plugins/plugin-media.md](../../docs/plugins/plugin-media.md)。

## 许可

见仓库根目录 LICENSE。
