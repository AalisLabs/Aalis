# @aalis/plugin-remote-agent-cursor

远端代理 —— Cursor Cloud Agents API 提供者。把任务交给 Cursor 云端代理，跟踪每一轮到终态，按轮取费用，取回成品与工程包。

## 安装

```bash
pnpm add @aalis/plugin-remote-agent-cursor
```

## 提供 / 依赖

`definePlugin` 默认导出，可多实例（多账号或换模型写成 `名:后缀`）：

- provides：`remote-agent`
- uses：`provide`、`lifecycle`、`logger`、`config`

激活时不发任何请求；鉴权与模型参数校验在消费方第一次调 `ready()` 时做。模型参数须写全，并等于 `/v1/models` 列出的某个变体，否则提供者不可用。API key 只在宿主进程里用：错误、日志与结果说明按值去掉 key 的片段，下载报错按值去掉这次预签名链接的查询串，请求路径去掉插件自己拼的查询串，其余照原文。

## 文档

详见 [docs/plugins/plugin-remote-agent-cursor.md](../../docs/plugins/plugin-remote-agent-cursor.md)。

## 许可

见仓库根目录 LICENSE。
