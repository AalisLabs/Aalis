# api-publish — 作品发布契约

`@aalis/api-publish` 定义 `publish` 服务、作品文件与来源结构、公开路径规则以及网页响应头策略。审核实现由 [plugin-publish-review](../plugins/plugin-publish-review.md) 提供，部署由 [plugin-works-site](../plugins/plugin-works-site.md) 提供。

提名方交付**文件字节快照**，不传宿主磁盘路径、部署网址或 Cloudflare 凭据。`group` 是不透明的隔离组键；同组网页可以同源，不同组使用不同的站点分支。`origin` 只供本机审计、归属和通知使用，不写入公开文件。

## 提名与撤下

插件在 `uses` 中声明 `publish` 或 `optional(publish)`，经 `publish.require()` / `publish.current` 调用提供者。

| 方法 | 行为 |
|---|---|
| `nominate(input)` | 检查来源配额、文字、路径、数量、大小与文件签名；保存快照后返回作品编号，失败返回固定类别及可选 `fileIndex` |
| `get(id)` | 返回本机状态、来源、标题和可选 `live`；调用方须核对来源，只有 `live === true` 表示展示面已核验上线 |
| `withdraw(id, by, reason)` | 从本机公开账本撤回，再触发展示面更新；`degraded` 表示展示面暂时不能完成下架 |
| `listPublished(surface)` | 某展示面的已审核作品清单；返回快照 |
| `listSurfaces()` | 已登记发布目标的名称、标签、发布目录和可用状态；返回独立快照，不含部署句柄或凭据 |
| `readFile(id, path)` / `readThumbnail(id)` | 只读账本中的公开文件，核对摘要；文件不符会撤下该作品并抛 `IntegrityError` |

`NominateInput` 包含 `origin`、`group`、`groupLabel`、`surfaces`、`title`、`summary`、`files` 与可选 `cover`。后台自动提名可提供 1–128 字符的 `submissionKey`（ASCII 字母、数字、点、下划线、冒号或连字符，以字母或数字开头）。键只在同一 `origin.producer` 内生效；重复提交相同来源、文字、目标和文件字节时返回原作品编号，不再占用配额。相同键对应的输入发生变化会被拒绝，终态也不会被重新提名。未提供键的人工提名保留每次新建作品的行为。调用方仍负责自己的用户授权；服务负责审核和发布边界。审核提供者默认让自动通过的作品继续发布，自动拒绝、拿不准或模型调用失败时转人工；`manualReview: true` 进一步要求每件作品人工批准。结构检查与净化失败不能由人工覆盖，提名方不能绕过审核规则。

有提交键的作品在人工拒绝、超时、审核失败或撤回后，`get(id)` 仍返回对应终态，供后台提名方停止重试。`published` 只表示审核通过并进入本机发布账本；展示面完成部署和内容核对后，`live` 才会持久变为 `true`，与通知是否送达无关。

旧版账本中的多余署名字段仍可读取。旧版提交指纹曾包含署名；当原作品仍在待审或发布账本中时，同键重试可从旧记录核对。旧终态记录没有保存署名和文件摘要，无法可靠核对这类重试，服务会保守拒绝内容变更。

## 展示面

通过绑定门面的 `publish.attachSurface({ name, label, baseUrl, urlFor, health })` 登记展示面，`publish.onChange(listener)` 订阅已发布集合变化。`label` 与 `baseUrl` 可选；`baseUrl` 是规范 HTTPS 发布目录，例如 `https://example.com/draw/`。`publicWorkUrl(baseUrl, id)` 构造目录内的作品地址。登记随当前激活撤回、随提供者切换重挂。同名再次登记后，旧句柄不再生效。

给定 `baseUrl` 后，上线回执中的地址必须精确匹配该目录下的 `w/<id>/`，不能替换域名、增加子域名或换目录。授权一个域名不包含其子域名。本接口不创建 DNS 记录，也不授权提名方新增发布目标。未给 `baseUrl` 的旧展示面仍按根目录 `/w/<id>/` 校验；新网页展示面应明确给出发布目录。

`listSurfaces()` 是宿主服务目录，不替代用户授权。白纸等调用方必须先按自己的目标白名单裁剪，再交给模型或 WebUI；提名时再次检查目标，不能直接把整个目录视为获准列表。目标健康检查抛错时只将该项标为不可用，不泄露异常详情。

展示面部署并核对通过后调用返回句柄的 `live(ids)`。审核服务到此才向来源通知作品网址。`health()` 应如实说明无法部署的原因，使撤下工具不会把“本机已撤回”误报成“网站已下架”。

## 公开文件边界

公开路径按段验证，拒绝绝对路径、点段、控制字符、保留文件名及未支持的扩展名；HTML 入口只能为根目录的 `index.html`。同一作品的路径大小写折叠后不得重复。媒体、HTML、CSS、脚本、SVG、JSON 与字体类型表由本包统一维护。

`workHeaders`、`galleryHeaders` 与 `WORK_IFRAME_SANDBOX` 分别用于作品资源、宿主页面和作品 iframe。作品沙箱不含 `allow-same-origin`；公开作品资源允许匿名跨源读取，使沙箱内的模块脚本与字体可加载，仍禁止脚本发起网络请求和表单提交。完整边界与浏览器残余风险见[安全模型](../concepts/security-model.md)。
