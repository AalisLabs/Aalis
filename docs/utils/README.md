# 工具库（utils）

`@aalis/util-*` 是**零服务、零 DI 的工具库**（以 `aalis-util` 关键词标识）。插件在 `package.json`
里依赖它们、直接 `import` 使用——不经服务容器、不参与 DI。多数提供纯函数；持有浏览器等资源的工具对象需要调用方显式关闭。能复用就别重抄（参见框架的「单一消费者别污染通用契约」原则）。

| 工具库 | 定位 |
|---|---|
| [bounded-map](bounded-map.md) | `createBoundedMap({max, ttlMs, onEvict})` —— 有界 LRU + 滑动 TTL Map，给无界缓存封顶。消费者：media 图片描述缓存、office 文档会话、prompt-budget。 |
| [json-repair](json-repair.md) | 从脏 LLM 输出里捞出 JSON **对象**（去代码围栏/散文/尾随噪声）：`extractJsonCandidate`/`tryParseJsonObject`/`parseLLMJsonObject`。**仅对象**——顶层数组不解析（这也是 user-relation 顶层数组场景另写解析器的原因）。 |
| `util-file-signature`（无单独页面） | 按文件内容认定文件类型，不看扩展名、Content-Type 与 data URL 里写的类型：`detectMediaFormat`（按文件头认媒体，返回类型、格式名、扩展名与 MIME）/`checkMediaHead`（按所请求类型核对，给出拒发说明）/`FILE_HEAD_BYTES`（认媒体要读的文件头长度，4 KiB）/`MEDIA_FORMATS`（按格式名查扩展名与 MIME）/`MEDIA_KIND_LABEL`（媒体种类的中文名，给模型看的说明用）/`detectDocumentFormat`（PDF、DOCX 与旧版 Office 的复合文档 OLE）/`decodeUtf8Text`（按 UTF-8 解成文本，不合法的 UTF-8 与含 NUL 的回 `null`：GBK 等编码的文本判成不是文本）/`isAnimatedImage`（多帧的 GIF、APNG、动态 WebP；单帧 GIF 不算）。媒体格式：图片 PNG、JPEG、GIF、WebP、BMP、AVIF、HEIC，音频 MP3、WAV、OGG、FLAC、AMR、SILK、M4A，视频 MP4、MOV、WebM、MKV、AVI。消费者：image-sender 的 `send_attachment`、media（`analyze_image`、判动图、交给模型的音频格式）、onebot 适配器的出站分流与入站落盘、WebUI 的媒体路由、图片代理与附件预览、作品审核、白纸、office 插图、OpenAI 兼容的语音识别、文件读取、会话服务的上传附件、`http_request` 的响应正文。 |
| [util-offline-render](util-offline-render.md) | 浏览器离线渲染与图片重编码；调用方拥有 renderer，并在退出时等待 `dispose()`。 |
| [network-guard](network-guard.md) | SSRF 防护出口：`safeFetch`（逐跳重定向复核）/`assertSafeUrl`/`assertSafeHost`/`isPrivateAddress`/`setNetworkPolicy`。**任何用户/LLM 可影响的 URL 都应经它**。威胁模型见[概念层 security-model](../concepts/security-model.md)。 |
| [text-normalize](text-normalize.md) | 净化 LLM 助手输出：`fixGfmTables`（渲染端修 GFM 表格，只改显示）/`stripLeakedSpecialTokens`（拿到完整回复的一方剥泄漏的特殊 token）。 |
| `util-cron`（无单独页面） | Cron 表达式解析与匹配（POSIX 5 字段 + `@` 别名 + `@every` 间隔）：`validateCronExpr`/`matchesCron`/`parseEverySeconds` 等。消费者：cron-engine、scheduler、workflow；`api-cron-engine` 只转发其类型。 |
| `util-dep-spec`（无单独页面） | npm 依赖声明的来源分档与 semver 版本序比较：`classifyDepSpec`/`isRegistryDep`/`compareVersions`/`isUpgrade`。消费者：package-manager、webui-server 的市场路由。 |

> 其它入口：[概念层](../concepts/README.md) · [服务契约层](../services/README.md) · [脚手架上手](../guide/scaffolding.md) · [插件作者隐式契约指南](../plugin-author-guide.md)
