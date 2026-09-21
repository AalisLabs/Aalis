# @aalis/plugin-session-confirm

会话确认协调器：提供 session-confirm 服务（createChannel）供各平台复用，并经 gateway 总线覆盖 onebot/cli 等会话型平台

## 安装

```bash
pnpm add @aalis/plugin-session-confirm
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：`sessionConfirm`（服务名 `session-confirm`）
- uses：`gateway`、`hooks`、`lifecycle`、`logger`、`provide`；可选 `authority`

## 文档

详见 [docs/plugins/plugin-session-confirm.md](../../docs/plugins/plugin-session-confirm.md)。

## 许可

见仓库根目录 LICENSE。
