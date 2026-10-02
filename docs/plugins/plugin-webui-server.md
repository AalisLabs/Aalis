# plugin-webui-server — WebUI 服务端

**包名**: `@aalis/plugin-webui-server`  
**源码**: `packages/plugin-webui-server/src/index.ts`

## 概述

Express + WebSocket 实现的 Web 管理后台和聊天平台，提供 REST API 与 WebSocket 实时通信，并作为 `webui` 平台适配器接入聊天。WebSocket 端点 `/session` 是会话协议的传输：已认证的连接接到会话服务（`sessionProtocol`），本插件只依赖契约包 `@aalis/api-session-protocol`，不依赖它的实现。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-webui-server',
  provides: [webuiServer, platform],
  uses: {
    events,
    logger,
    lifecycle,
    config,
    provide,
    services,
    hostConfig: optional(hostConfig),
    paths: optional(hostPaths),
    app: optional(appService),
    plugins: optional(pluginsService),
    source: optional(pluginSource),
    packageManager: optional(packageManager),
    storage: optional(storage),
    authority: optional(authority),
    commands: optional(commands),
    platform: optional(platform),
    process: optional(processService),
    sessionConfirm: optional(sessionConfirm),
    sessionProtocol: optional(sessionProtocol),
    tools: optional(tools),
    llm: optional(llm),
    persona: optional(persona),
    agent: optional(agent),
    archive: optional(messageArchive),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `port` | number | `3000` | 端口：Web 管理界面的 HTTP 端口 |
| `host` | string | `'127.0.0.1'` | 监听地址：绑定的 IP 地址，0.0.0.0 可对外访问。**改绑非回环地址前先读下文「登录身份与权限」**——持有 token 的人等同 owner |
| `fileRoot` | string | `'workspace'` | 文件浏览根：文件管理页面使用的 storage 根 ID，默认 workspace |
| `autoOpen` | boolean | `true` | 每次应用启动后首次监听成功时打开默认浏览器；同一应用内沿用 token 的插件重载不重复打开，重新生成 token 时再次打开以便登录。SSH/headless 环境建议关闭 |
| `tokenMode` | select | `'persist'` | Token 策略：ephemeral=每次启动随机；persist=token 写入 data:/webui/token，读取复用；fixed=使用 fixedToken 字段。所有模式都会写出便利文件 data:/webui/access.txt 含访问 URL。 |
| `fixedToken` | string | `''` | 固定 Token（仅 tokenMode=fixed 生效）：请使用足够长的随机字符串（secret，值存进 `secrets.yaml`，WebUI 不回显）。配置文件不支持环境变量插值，写 ${VAR} 会被当作字面量。 |
| `relationGraphDefaultSpacing` | number | `120` | 关系图默认密度：关系图（RelationGraph）布局密度的服务器默认值（约等于理想边长 px，建议 60–250；越大越稀疏）。前端每个用户可在图工具栏现场覆盖并保存到本地浏览器；改完此项后，刷新关系图页面或新会话生效。 |
| `marketplaceRegistry` | string | `'https://registry.npmjs.org'` | 插件市场 npm 源：插件市场检索用的 npm registry 基址。注意 npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），默认官方源；国内可填支持 search 的镜像或代理。安装走 package-manager（遵循本机 npm 配置），卡片上的最新版与可更新也按安装使用的源查。 |

## 认证 / 访问 token

WebUI 使用单个访问 token + HttpOnly cookie 认证。HTTP 请求与 WebSocket 升级请求的登录判定相同：将 cookie 中的 token 与本进程的 token 做相等比较，没有"一次性"语义——**同一进程内任意多个用户/浏览器都可以反复用同一个 token 登录**。

### tokenMode 三种模式

| 模式 | token 生命周期 | 文件 |
|---|---|---|
| `ephemeral` | 每次进程启动随机生成，重启失效 | 仅写出 `data:/webui/access.txt` |
| `persist`（默认） | 首次生成后写入 `data:/webui/token`，重启沿用 | 同时写出 `data:/webui/access.txt` |
| `fixed` | 来自配置 `fixedToken`，不变；空则降级 persist | 同上 |

persist 模式的读回跟随 storage 服务：storage 晚于 WebUI 上线时（加载顺序、运行时才启用），WebUI 先用临时 token，storage 上线后读回 `data:/webui/token` 并改用它，同时重写 `access.txt`；没有 token 文件时把当前 token 写进去。已用临时 token 登录的浏览器此时需要重新登录。

### 访问凭据文件

- **URI**: `data:/webui/access.txt`
- **物理路径**: `data` 存储根对应目录下的 `webui/access.txt`，即家目录的 `state/webui/access.txt`；启动日志 `访问凭据已写入: ... （绝对路径: ...）` 直接给出
- **内容**: 注释 + `URL:` + `Token:` + `一键登录:`（带 `?token=` 的完整 URL）

> 历史路径 `data/webui-access.txt` 早已被 `data/webui/access.txt` 取代；家目录布局调整后 `data` 根映射到 `state/`，现行文件是 `<家目录>/state/webui/access.txt`（URI 仍是 `data:/webui/access.txt`），不要再读家目录 `data/` 下的旧文件。

### 登录方式

1. **一键登录 URL**：浏览器打开 `http://host:port/?token=<TOKEN>` → 服务端校验后 `Set-Cookie` 并 302 到干净 URL。
2. **手动登录**：访问 `http://host:port/`，在登录页粘贴 token → POST `/api/auth/login` `{ token }`。
3. **登出**：POST `/api/auth/logout` 清除 cookie。

### 登录身份与权限

通过 token 登录后，请求身份被判定为 `webui:console`，而 `cli:console` / `webui:console` 在 authority 里直接视为 **owner（最高等级）**——可以驱动 exec 等受限工具、改配置、装卸插件。也就是说：

> **谁拿到这个 token，谁就等同于这台机器的 owner。**

而默认 `tokenMode=persist` 下 token 长期不变、且明文写在 `data:/webui/access.txt` 里。因此把 `host` 改成 `0.0.0.0`（或经反代暴露到公网）之前：

- 确认处在可信网络，或在前面加一层独立鉴权（反代 Basic Auth / mTLS / 只对内网开放）；
- 改用 `tokenMode=fixed` 配一个足够长的随机 token，并妥善保管 `access.txt`；
- 权限语义详见 [plugin-authority](./plugin-authority.md)。

### Cookie

- 名称：`aalis_webui_token`
- 属性：`HttpOnly; SameSite=Strict; Path=/; Max-Age=30d`
- 进程重启且 tokenMode=ephemeral 时 cookie 自动失效。

### 自动打开浏览器

`autoOpen=true` 时在监听成功后经 process 服务以 detached、`stdio:'ignore'` 方式启动系统默认浏览器（macOS `open`、Windows `cmd /c start ""`、其它平台 `xdg-open`），参数为带 token 的访问 URL，随后 `unref()`；process 服务缺失或启动失败时静默忽略。

每次应用启动都打开一次，包括 persist 读回已有 token 和 fixed 使用配置 token 的情况。同一应用内插件重载沿用 token 时不重复打开；ephemeral 每次激活生成新 token，旧页面失效，因此重载也会打开。persist 写入 token 失败、下次激活重新生成时同样再次打开。去重按 App 身份独立记录；自定义宿主若不提供 app 服务，则每次监听成功都会尝试打开。`autoOpen=false` 时全部不打开。

## REST API

除 `/api/auth/login`、`/api/auth/status`、`/api/auth/logout` 外，所有 `/api/*` 都需登录（cookie），未登录返回 401；未命中的 `/api/*` 路径返回 404 JSON（不落到 SPA 兜底）。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/auth/login` · `/api/auth/logout` · `/api/auth/status` | POST · POST · GET | 登录换 cookie / 登出 / 登录状态 |
| `/api/status` | GET | 系统状态、上传能力检测。`appName` 是全局配置里的应用名称；`name` 是对话对象的显示名，装有人设时为人设名，否则同 `appName` |
| `/api/plugins` | GET | 插件列表（含状态、配置、Schema、错误信息）；配置取配置文档里的形态：宿主提供密钥存储时，`secret` 字段上是引用 `{ $secret: '<键>' }`，不回原值；没有密钥存储的自组装宿主，文档里本就是明文，接口原样返回（表单只遮蔽显示）。顶层另给 `secretRefCounts`（键 → 配置文档里引用它的处数），表单据此提示替换会影响几处。宿主不提供 `host-config` 时给运行态配置并去掉 `secret` 字段。激活超过慢激活阈值、已转入后台的插件带 `slow: true` |
| `/api/plugins/:name/config` | GET / PUT | 单插件配置读写，GET 读配置文档（宿主有密钥存储时 `secret` 字段上是引用）；PUT 体为 `{ config }`，经 `host-config` 的 `applyPluginConfig` 热重载该插件、写回配置文档并落盘。`secret` 字段上原样回传引用表示保持原值，写新值表示替换：新值存进宿主的密钥存储（Node 宿主是 `secrets.yaml`），配置文档里只留引用（写入规则见 [api-host-config](../api/api-host-config.md#改插件配置)）。提交里新引入的悬空引用（键不在密钥存储里、也不是这次写入的）返回 400，运行态与文档都不动。PUT 是部分更新：提交的顶层键整键替换原值（分组、数组整块替换），没提交的保持原值，值为 `null` 的顶层键视为删除；之后按 schema 默认值深合并补齐缺的键，删除的键有默认值时回到默认值（`secret` 字段的默认值不写进文档，删除后由插件解析时补上）。插件有 `configSchema`、且宿主按裁剪政策运行（`host-config` 的 `trimUnknownFields`，Node 宿主缺省开启，`startAalis({ configSync: { trimUnknownFields: false } })` 关闭）时裁掉未声明的字段；宿主保留未知字段时这里同样保留，不附下述点名：本次提交里的在响应 `ignored` 里点名；配置文档里原有、本次没有提交的随写回从配置文件删除，在响应 `removed` 里点名；两者都附在 `message` 末尾。插件运行中、且解析出的配置与运行态相同时，不重载插件，仍把配置文档写回文件（此前保存写文件失败时，原样重试即可补写）；配置文档也没有变化时回复「配置无改动，已写回配置文件」。按新配置重新激活失败、插件转为 `error` 态时，配置照样写回，仍返回 200 与 `{ ok: true }`，`message` 说明激活失败及原因：这个接口回 2xx 即表示配置已写进配置文件，WebUI 据此收起表单、刷新状态，非 2xx 时表单留着供改正。插件处于禁用态时照样换上新配置并写回，插件保持禁用，启用时按新配置激活，回执说明这一点。插件不存在时返回 404（没登记的实例不在这里新建，新建走 `POST /api/plugins/:name/instances`）；插件还在但停机中或正在卸载、拒绝了这次更新时返回 409，配置文件不变 |
| `/api/plugins/:name/enable` · `/api/plugins/:name/disable` | POST | 热启用 / 热禁用，写回 `disabledPlugins`。启用后激活失败、转为 `error` 态时，照样写回启用，仍返回 200 与 `{ ok: true }`，`message` 说明激活失败及原因；停用仍在初始化的插件而它未在宽限内停止、转为 `error` 态时，照样写回禁用，同样返回 200，`message` 说明它未在宽限内停止、已转为 `error` 态。插件不存在时返回 404；停机中或插件正在卸载时拒绝，返回 409，配置文件不变 |
| `/api/plugins/scan` | POST | 经宿主的 `plugin-source` 服务重新扫描插件源（范围由宿主的加载器决定），加载新发现且尚未注册的插件；宿主未提供插件来源时返回 503 |
| `/api/plugins/:name/instances` · `/api/plugins/:instanceId/instance` | POST · DELETE | 多实例插件的创建 / 移除。创建的请求体为 `{ suffix, config? }`，`config` 与 PUT 插件配置同一套处理：按 schema 默认值深合并、按宿主的裁剪政策裁掉未声明的字段（在响应 `ignored` 里点名，附在 `message` 末尾）；有类型不符的值时不创建，返回 400。创建同样经 `applyPluginConfig`：`secret` 字段上的值拆进密钥存储，先写配置文档再登记。停机进行中创建会被拒绝登记，返回 409，配置文档与密钥都撤回、不写入；创建后激活失败、实例转为 `error` 态时，实例与配置照样保留并写入配置文件，仍返回 200 与 `{ ok: true, instanceId }`，`message` 说明激活失败及原因：创建回 2xx 即表示实例已登记、配置已写进配置文件，WebUI 据此收起建实例表单、刷新列表；落盘失败的回执带 `applied: true`（见下文），实例同样已在运行态登记，表单也收起；其余非 2xx 时表单留着；配置文件的 `disabledPlugins` 里已有该实例（手改配置文件留下）时以禁用态登记，回执说明这一点。移除时先从配置文件删掉该实例的配置段与禁用标记（同名重建以启用态登记；不再被任何配置引用的密钥随这次保存从 `secrets.yaml` 删除），落盘成功后再卸载实例；卸载失败时返回 500，说明配置段已从配置文件删除、卸载失败；停机进行中删除时内核不受理卸载，配置段照样删掉，返回 200，`message` 注明停机中、未卸载运行中的实例 |
| `/api/pages` | GET | 所有激活插件注册的 WebUI 页面（按 order 排序） |
| `/api/page-action/:plugin/:method` | POST | 动态调用插件页面处理器（统一 RPC 入口） |
| `/api/config` · `/api/config/save` | GET / PUT · POST | 全局配置：GET 读取整份配置文档（宿主有密钥存储时，插件配置里的 `secret` 字段是引用，不是原值）；PUT 可改 `name`、`logLevel`、`slowThresholdMs`（`CORE_CONFIG_SCHEMA` 的键）；请求体里其余顶层键一律不应用，其中与当前值不同的会在响应 `ignored` 里点名（前端会把整份配置连同可能过期的快照回传，故不按键报错）；文档里没写的核心键按 schema 默认值比较（前端把默认值回填进草稿后回传，不算改动、不写进文件）；`logLevel` 或 `slowThresholdMs` 有变化时保存并自动重启应用（宿主不支持重启时记一条错误日志，响应 `restart: false`，`message` 说明改动已写入文件、下次启动生效），只改 `name` 时保存即生效（仪表盘的应用名称随即更新；装有人设时聊天显示人设名，不随它变）；POST `/api/config/save` 把当前配置写回磁盘（宿主不持久化时不写盘，回执只说「配置已保存」） |
| `/api/services` · `/api/services/:name/prefer` | GET · POST / DELETE | 服务列表 / 设置或清除服务偏好提供者（持久化到 `servicePreferences`） |
| `/api/service-groups` · `/api/tool-groups` · `/api/system-components` | GET | 服务分组 / 工具分组 / 系统组件 |
| `/api/platforms` | GET | 平台连接状态 |
| `/api/models/:service` · `/api/llm-models` · `/api/llm-providers` | GET | 按服务取模型列表 / LLM 模型与提供者 |
| `/api/llm-providers/:contextId/refresh` | POST | 触发该 provider 重新探测模型列表（仅对支持运行时刷新的 provider 有效）。`:contextId` 是提供者的插件实例 id，与 `/api/llm-providers` 返回的 `contextId` 相同。名下的模型都不提供运行时刷新（如关闭了 `discoverModels`）、或名下没有已注册的模型时返回 404，分别说明 |
| `/api/marketplace` · `/api/marketplace/depgraph` | GET | 市场搜索（`?q=`）/ 依赖图。检索走 `marketplaceRegistry`，结果再按搜索词在包名、描述、关键词上过滤（不区分大小写，空格分隔的每个词都要命中）。检索源不可达时只列本地已装的包，同样按搜索词过滤，响应带 `warning` 说明。卡片的最新版（`version`）与 `updatable`、`/api/system-components` 的 `latest`、依赖图里未安装包的依赖与服务，都按包名向安装实际使用的源（`package-manager` 报告的 npm registry）查；`package-manager` 缺席时退回检索源；安装源查不到时不给最新版与可更新，响应带 `warning` 说明原因 |
| `/api/marketplace/install` · `/api/marketplace/uninstall` | POST | 体为 `{ name }`；需 `package-manager` 服务（缺失时 503）。安装后热加载，卸载后热卸载；插件装上但激活失败、转为 `error` 态时仍返回 `{ ok: true }`，`message` 说明激活失败及原因；慢激活转入后台仍在进行、或在等 required 依赖时同样返回 `{ ok: true }`，`message` 说明尚未激活。装卸只接受插件与前端界面包；若有其它插件依赖该包提供的服务，且没有别的插件正在提供该服务，卸载被拒绝。这些拒绝来自 `package-manager` 服务层，以 HTTP 200 返回 `{ ok: false, message }` |
| `/api/marketplace/update` | POST | 体为 `{ targets: [{ name, version }] }`，整批更新，成功后重启进程；需 `package-manager` 服务（缺失时 503） |
| `/api/files*` · `/api/uploaded-files*` | GET / POST | 工作区文件管理 / 上传文件管理 |
| `/api/logs/tail` · `/api/logs/range` | GET | 日志：尾部 N 条（`?limit=`，默认 200，上限 5000）/ 向前翻页（`?before=<seq>&limit=`，返回 seq 小于 before 的记录） |
| `/api/proxy/image` | GET | 图片代理 |
| `/api/media` | GET | 聊天里的图片、视频、音频按存储地址取（`?uri=data:/images/x.png` 这类）：按文件头判定类型，只提供 PNG、JPEG、GIF、WebP、MP4、WebM 与 MP3、WAV、OGG、M4A，其余（含 HTML、SVG、JSON）回 415；响应带 `nosniff` 与 `sandbox` CSP。客户端把消息与会话历史里的存储地址换成这条路由 |

core 的插件管理动作与 `services.prefer` 只改运行态；启停、删除实例与服务偏好要跨重启保留，由对应路由另经 `host-config` 写配置文档并落盘；改插件配置与新建实例经 `host-config` 的 `applyPluginConfig`，运行态、文档、密钥与落盘一步完成。宿主未提供 `host-config` 时，读写配置文档的路由（`/api/config`、`/api/config/save`、`/api/plugins/:name/config`、启停、实例增删）与服务偏好的设置 / 清除路由返回 503。运行态已改、随后落盘被拒（如配置文件有尚未生效的外部修改）时，启停、改插件配置、新建实例与服务偏好路由返回 409 与 `{ error, applied: true }`：改动已在运行态生效，但没有写入配置文件。修好被拒写的文件后，插件配置随热重载回到文件里的值，新建而未写入文件的实例随热重载卸载；启停与服务偏好在重启时以文件为准。修好文件的方式不限，原样改回也会触发这次对账。落盘因其它原因失败（如没有写权限、磁盘写满）时，这些路由返回 500 与 `{ error, applied: true }`：文件没有变化，也不会触发重载，改动保留在配置文档里，下一次保存成功时一并写入。这两种情形下，插件在动作之后没有进入预期状态（激活失败、未在宽限内停止、仍在激活、在等依赖或保持禁用）时，`error` 开头先说明这一点。删除实例先落盘、后卸载：后缀实例由配置段定义，热重载也按文件登记，先卸载后落盘时卸载途中的热重载会按仍带配置段的文件把实例重新登记。落盘被拒返回 409、其它失败返回 500，实例不删除，文档里的配置段与禁用标记还原。全局配置（`PUT /api/config`）落盘失败时撤回文档里的改动，被拒返回 409、其它失败返回 500：`logLevel` 与 `slowThresholdMs` 要重启才生效，`name` 由状态接口实时读取，撤回后都回到修改前。`POST /api/config/save` 同样是被拒返回 409、其它失败返回 500。

启用、改插件配置与新建实例在管理动作之后等插件状态机静置（`plugins.idle()`），再按实例状态写回执：动作撞上在飞的重算时只排队、立即返回，直接读状态会把随后的激活失败报成成功。转入后台的慢激活不等，重算对单个激活至多等到慢激活阈值；这时回执说明插件仍在激活，在等 required 依赖的说明尚未激活，两者都返回 200。市场安装由 `package-manager` 按同一口径回执。

## WebSocket

WebSocket 与 HTTP 同端口，两个端点：`/session` 是会话协议，`/ws` 是下文的旧协议。升级请求的认证与 HTTP 相同（cookie 里的 token），没登录或 token 不对回 401；认证之后只认这两个路径（可以带查询串），其他路径回 404。每条连接都有心跳：每 30 秒 ping 一次，30 到 60 秒内没回 pong 的半开连接被踢掉。插件卸载时各端点的连接以 1001「webui 正在卸载」关闭。

### `/session`：会话协议

协议本身（帧、握手、方法、推送、错误码、条目种类）见 [api-session-protocol](../api/api-session-protocol.md)，实现见 [plugin-session-server](./plugin-session-server.md)。本插件只做传输：

- 一条连接接到会话服务的一次 `sessionProtocol.connect`。对端身份取自认证，即 `{ platform: 'webui', userId: 'console' }`，审批面为 `webui`，握手结果里原样给出。
- 每个文本帧是一个 JSON-RPC 帧，原文转交会话服务；服务端发出的帧原样发回。连接关闭时撤掉会话服务那头的连接。
- 会话服务在每条连接到达时现取，会话服务晚于本插件上线、停用后重新启用，都不用重启本插件。

关闭码：

| 码 | 原因 | 客户端怎么办 |
|---|---|---|
| 1000 | 会话服务断开这条连接，原因由它给出：握手时主版本不合（之前已回 `unsupported` 错误帧），或「会话服务已停止」（停用、重载） | 主版本不合时不重连；其余稍后重连，接到新的提供者 |
| 1001 | `webui 正在卸载` | 稍后重连 |
| 1013 | `会话服务不在`：会话服务没装、停用或没激活成功 | 稍后重连 |

关闭帧的原因最多 123 字节，会话服务给的原因更长时按整字截短（例如握手时客户端报的版本号很长）。帧本身不合规时按 WebSocket 标准的关闭码关闭，例如文本帧里不是合法的 UTF-8 为 1007。

浏览器里的客户端：

```ts
const socket = new WebSocket(`ws://${location.host}/session`); // 同源，cookie 自动带上
socket.onopen = () =>
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1.0', client: { name: 'my-client', version: '0.1.0' } },
  }));
socket.onmessage = event => {
  const frame = JSON.parse(event.data); // 带 id 的是回应，不带 id 的是推送
};
```

### `/ws`：旧协议

#### 入站消息类型 (Client → Server)

| 类型 | 说明 |
|---|---|
| `message` | 用户发送聊天消息 |
| `subscribe_logs` | 订阅实时日志推送 |
| `subscribe_session` | 订阅指定会话更新 |
| `unsubscribe_session` | 取消会话订阅 |
| `abort` | 中断当前生成；回合里正在跑的 `exec` 与代码执行随之停掉（见 [plugin-tool-system](./plugin-tool-system.md)、[plugin-tool-code-runner](./plugin-tool-code-runner.md)） |
| `compress` | 手动触发会话上下文压缩 |

#### 出站消息类型 (Server → Client)

| 类型 | 说明 |
|---|---|
| `message` | 完整消息推送。发往 WebUI 自己会话的消息由本插件认领投递回执：会话历史是收件箱，回执成功表示这条消息已进会话历史，有在线页面时同时推送（不等页面写出）。agent 的文字回复由 agent 存档；其余由本插件经 message-archive 写进会话历史，不取决于 image-sender 是否在场：不是她说的文字（系统提示、指令回复、宿主通知）与文件记成事件标记，回看时显示成分隔条，不进模型上下文；图片、视频、音频按 `outboundMediaMessage` 的格式记，带 `skipArchive` 的（`history_ref` 重发，原图已在历史里）不记。随后发出的 `outbound:delivered` 快照给附件标上 `skipArchive`，image-sender 不再记一份，因此发往 WebUI 的网址图片与视频不由它补视觉描述。存档服务不在场且没有在线页面时回执失败；写入失败而推送到了页面时仍算送达。一条消息要写多条记录（如正文加几个文件）时逐条写入，中途失败且没有在线页面时回执失败，已写成的几条不撤回，发起方重发后这几条会重复 |
| `stream` | 流式增量推送（contentDelta / reasoningDelta） |
| `stream_resume` | 页面刷新后恢复中断的流（累积缓冲内容） |
| `tool_call` | 工具调用开始/结束事件 |
| `state_changed` | 插件/服务状态变化 |
| `sessions_changed` | 会话列表更新 |
| `history_changed` | 会话历史变更（如回滚），前端应重新拉取历史 |
| `todo_updated` | 待办事项变化 |
| `token_usage` | 本会话 token 用量与分项明细 |
| `compressing` | 会话压缩状态 |
| `restarting` | 应用即将重启通知 |
| `reload` | 前端应重新加载 |
| `page_refresh` | 通知前端刷新某插件的动态页面数据（`pluginName` 缺省表示全部） |
| `confirm` | 受限操作的交互式确认请求（由 session-confirm 服务驱动；用户在聊天框回复即作答） |
| `log` | 实时日志推送 |

#### token 用量快照

客户端订阅会话而服务端没有缓存的用量时，以及手动压缩完成后，服务端发 `token:request` 请 agent 重算快照，结果经 `token_usage` 推给客户端。请求只带 `sessionId`，不带 `platform`：WebUI 能订阅任何平台的会话，快照按哪个平台算由 plugin-agent 决定（IM 房间按出生平台，其余按 `webui`，见 [plugin-agent](./plugin-agent.md) 的「Token 预算追踪与日志」），webui-server 不自己解析会话 id 猜平台。

## 流式缓冲管理

服务端为每个会话维护流式缓冲 `streamBuffers`，记录累积的 `content`、`reasoningContent`、按时序排列的 `segments`（文本、推理、工具调用）、进行中的工具调用进度和 `generating` 状态。客户端重连（如页面刷新）后发送 `subscribe_session`，若缓冲非空，服务端以 `stream_resume` 下发全部累积内容；回合结束后缓冲保留 10 秒再清理。

## 前端挂载与切换

前端不内置在 server 里——它是 `webui-client` 服务的 **provider**：每个前端包用 `package.json` 标 `aalis.client: true` + 构建出 `dist/index.html`，server 启动时由 `client-discovery.ts` 按标记**动态发现**并各注册一个 provider（无硬编码包名，第三方可自带前端）。

扫描的目录是安装集（`host-paths` 的 `app`）下的 `packages/` 与 `node_modules/@aalis`，另按安装集 `package.json` 的依赖解析前端包。宿主不提供 `host-paths` 时没有可扫的目录，发现不到任何前端，整个 WebUI 前端不可用，页面路径回 404「前端未就绪」，只剩 HTTP 接口；同时市场列表（`/api/marketplace`）与系统组件（`/api/system-components`）判断不了已装的包，返回 503。Node 宿主 `@aalis/runtime` 总会提供 `host-paths`。

**挂载哪个**：`servicePreferences['webui-client']` > provider 优先级 > 注册顺序。改偏好（`POST /api/services/webui-client/prefer` `{contextId}`，owner 闸）后**实时重挂静态目录 + 广播 WebSocket `reload`**，无需重启进程。

### 切换逃生页 `/__clients`

前端切换的下拉框位于前端界面内；一旦切到不含该 UI 的极简前端，就没有切回去的入口。为此 server 在 `GET /__clients` 直出一个独立恢复页（源码 `client-switch-page.ts`），它不依赖当前前端，切到任何前端后都可访问。

- 受全局 auth 中间件保护（须先登录，同源 cookie 自动鉴权）；列表走 `GET /api/services`、切换走 `POST /api/services/webui-client/prefer`（owner 闸），**零新增后端逻辑**。
- **用法**：浏览器开 `http://<host>:<port>/__clients` → 选目标前端 → 点「切换并刷新」→ 成功后自动跳回 `/`。检测到多个前端时，启动日志也会打印此 URL。
- **手动恢复**：直接改 `aalis.config.yaml` 的 `servicePreferences.webui-client`（或删该项回退默认）后重启。
