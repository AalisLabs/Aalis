# @aalis/plugin-image-sender

图片发送：将生成/本地图片经平台发出

`send_attachment` 等待目标适配器确认后才返回 `ok: true`；下载、连接或平台发送失败返回 `error`，不写入“已发送图片”的归档。图源失效时可重新选图，不能把调用工具当成已送达。

存储库里的媒体按受众判能不能发：有别人在场的会话里、以及授权身份不是 owner 的回合里，只能发本会话收到或产生的媒体（判据见 `@aalis/api-media` 的 `mediaInScope`）。同样在这些会话里，带 markup 的正文（她的回复）里存储地址的媒体标记由本插件在出站前按同一个判据转成附件，其余不是网址的去掉；网址的留在正文里，由适配器下载、核对文件头后内联。

OneBot 的成功表示平台接口已确认接受；WebUI 表示至少一个在线客户端的 WebSocket 已接受数据，不代表用户已阅读或浏览器已加载外部图片。未提供确认的第三方适配器不能返回成功。

## 安装

```bash
pnpm add @aalis/plugin-image-sender
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：无
- uses：`events`、`logger`；可选 `tools`、`hooks`、`storage`、`media`、`memory`、`archive`（`message-archive`）、`sessionManager`（`session-manager`）、`authority`

## 文档

详见 [docs/services/media.md](../../docs/services/media.md)。

## 许可

见仓库根目录 LICENSE。
