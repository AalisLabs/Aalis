# api-publish — 作品发布契约

`@aalis/api-publish` 定义 `publish` 服务、作品文件与来源结构、公开路径规则以及网页响应头策略。审核实现由 [plugin-publish-review](../plugins/plugin-publish-review.md) 提供，部署由 [plugin-works-site](../plugins/plugin-works-site.md) 提供。

提名方交付**文件字节快照**，不传宿主磁盘路径、部署网址或 Cloudflare 凭据。`group` 是不透明的隔离组键；同组网页可以同源，不同组使用不同的站点分支。`origin` 只供本机审计、归属和通知使用，不写入公开文件。

## 提名与撤下

插件在 `uses` 中声明 `publish` 或 `optional(publish)`，经 `publish.require()` / `publish.current` 调用提供者。

| 方法 | 行为 |
|---|---|
| `nominate(input)` | 检查来源配额、文字、路径、数量、大小与文件签名；保存快照后返回作品编号，失败返回固定类别及可选 `fileIndex` |
| `get(id)` | 返回本机状态、来源与标题；不能用它决定跨房间授权，调用方须核对来源 |
| `withdraw(id, by, reason)` | 从本机公开账本撤回，再触发展示面更新；`degraded` 表示展示面暂时不能完成下架 |
| `listPublished(surface)` | 某展示面的已审核作品清单；返回快照 |
| `readFile(id, path)` / `readThumbnail(id)` | 只读账本中的公开文件，核对摘要；文件不符会撤下该作品并抛 `IntegrityError` |

`NominateInput` 包含 `origin`、`group`、`groupLabel`、`surfaces`、`title`、`summary`、`credit`、`files` 与可选 `cover`。调用方仍负责自己的用户授权；服务负责审核和发布边界。人工审核是提供者的 `manualReview` 配置，提名方不能覆盖它。

## 展示面

通过绑定门面的 `publish.attachSurface({ name, urlFor, health })` 登记展示面，`publish.onChange(listener)` 订阅已发布集合变化。登记随当前激活撤回、随提供者切换重挂。同名再次登记后，旧句柄不再生效。

展示面部署并核对通过后调用返回句柄的 `live(ids)`。审核服务到此才向来源通知作品网址。`health()` 应如实说明无法部署的原因，使撤下工具不会把“本机已撤回”误报成“网站已下架”。

## 公开文件边界

公开路径按段验证，拒绝绝对路径、点段、控制字符、保留文件名及未支持的扩展名；HTML 入口只能为根目录的 `index.html`。同一作品的路径大小写折叠后不得重复。媒体、HTML、CSS、脚本、SVG、JSON 与字体类型表由本包统一维护。

`workHeaders`、`galleryHeaders` 与 `WORK_IFRAME_SANDBOX` 分别用于作品资源、宿主页面和作品 iframe。作品沙箱不含 `allow-same-origin`；公开作品资源允许匿名跨源读取，使沙箱内的模块脚本与字体可加载，仍禁止脚本发起网络请求和表单提交。完整边界与浏览器残余风险见[安全模型](../concepts/security-model.md)。
