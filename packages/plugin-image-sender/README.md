# @aalis/plugin-image-sender

图片发送：将生成/本地图片经平台发出

`send_attachment` 等待目标适配器确认后才返回 `ok: true`；下载、连接或平台发送失败返回 `error`。图源失效时可重新选图，不能把调用工具当成已送达。发出的附件（`history_ref` 重发的、回复里转出的也一样）不由本插件记进会话历史：送达之后由 message-archive 的 `recordOutbound` 记，网址的图片与视频在后台补识图描述（见 [plugin-message-archive](../../docs/plugins/plugin-message-archive.md)）。出站消息带这次调用的回合 id 与 `callId`。

存储库里的媒体先过媒体判据再发（`@aalis/api-media` 的 `mediaScopeOf`）：本会话收到或产生的能发；别的会话的媒体按会话管理的取用规则，带这次调用的授权身份；不属于任何会话的本机文件只在这一轮的主体是 owner（或 owner 授权的自动运行在没有别人的会话里）时能发。带 markup 的正文（她的回复）里存储地址的媒体标记由本插件在出站前转成附件，不带授权身份过同一份判据，受众只有 owner 的会话不过判据；不装本插件时发不出，规则见[文档](../../docs/services/media.md#媒体判据)的「出站转换」。

OneBot 的成功表示平台接口已确认接受；WebUI 表示已经记进会话历史，不代表用户已阅读或浏览器已加载外部图片。未提供确认的第三方适配器不能返回成功。

## 安装

```bash
pnpm add @aalis/plugin-image-sender
```

## 提供 / 依赖

`definePlugin` 默认导出：

- provides：无
- uses：`events`、`logger`；可选 `tools`、`hooks`、`storage`、`media`、`memory`、`sessionManager`（`session-manager`）、`authority`

## 文档

详见 [docs/services/media.md](../../docs/services/media.md)。

## 许可

见仓库根目录 LICENSE。
