# plugin-webui-server — WebUI 服务端

**包名**: `@aalis/plugin-webui-server`  
**源码**: `packages/plugin-webui-server/src/index.ts`

## 概述

Express + WebSocket 实现的 Web 管理后台，提供 REST API 与 WebSocket 实时通信。WebSocket 端点 `/session` 是会话协议的传输：已认证的连接接到会话服务（`sessionProtocol`），本插件只依赖契约包 `@aalis/api-session-protocol`，不依赖它的实现；端点 `/admin` 推会话之外的管理面事件（日志、插件与页面登记表的变化、页面数据变了、布局记录变了、重启、换前端）。插件经 `webuiServer` 登记的声明式页面与提示由本插件收下、按质量门槛核过，页面的数据源与动作经本插件的服务端闸门调用（见下文「声明式页面」）。发往 WebUI 会话的出站消息由本插件写进会话历史（见下文「WebUI 会话的收件箱」）。

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
    commands: optional(commands),
    platform: optional(platform),
    process: optional(processService),
    sessionProtocol: optional(sessionProtocol),
    approvals: optional(approvals),
    sessions: optional(sessionManager),
    tools: optional(tools),
    llm: optional(llm),
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
| `autoOpen` | boolean | `true` | 每次应用启动后首次监听成功时打开默认浏览器；同一应用内沿用 token 的插件重载不重复打开，重新生成 token 时再次打开以便登录。SSH/headless 环境建议关闭 |
| `tokenMode` | select | `'persist'` | Token 策略：ephemeral=每次启动随机；persist=token 写入 data:/webui/token，读取复用；fixed=使用 fixedToken 字段。所有模式都会写出便利文件 data:/webui/access.txt 含访问 URL。 |
| `fixedToken` | string | `''` | 固定 Token（仅 tokenMode=fixed 生效）：至少 32 个字符的随机字符串（去掉首尾空白后计），短了插件不启动；留空按 persist 处理（secret，值存进 `secrets.yaml`，WebUI 不回显）。配置文件不支持环境变量插值，写 ${VAR} 会被当作字面量。 |
| `marketplaceRegistry` | string | `'https://registry.npmjs.org'` | 插件市场 npm 源：插件市场检索用的 npm registry 基址。注意 npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），默认官方源；国内可填支持 search 的镜像或代理。安装走 package-manager（遵循本机 npm 配置），卡片上的最新版与可更新也按安装使用的源查。 |

## 认证 / 访问 token

WebUI 使用单个访问 token + HttpOnly cookie 认证。HTTP 请求与 WebSocket 升级请求的登录判定相同：将 cookie 中的 token 与本进程的 token 做定时安全比较（两边先取 SHA-256 摘要再逐字节比，耗时与 token 的内容和长度都无关），没有"一次性"语义——**同一进程内任意多个用户/浏览器都可以反复用同一个 token 登录**。`?token=` 与登录接口的比较方式相同。

### tokenMode 三种模式

| 模式 | token 生命周期 | 文件 |
|---|---|---|
| `ephemeral` | 每次进程启动随机生成，重启失效 | 仅写出 `data:/webui/access.txt` |
| `persist`（默认） | 首次生成后写入 `data:/webui/token`，重启沿用 | 同时写出 `data:/webui/access.txt` |
| `fixed` | 来自配置 `fixedToken`，不变；至少 32 个字符，短了插件激活失败并写明原因；空则降级 persist | 同上 |

persist 模式的读回跟随 storage 服务：storage 晚于 WebUI 上线时（加载顺序、运行时才启用），WebUI 先用临时 token，storage 上线后读回 `data:/webui/token` 并改用它，同时重写 `access.txt`；没有 token 文件时把当前 token 写进去。已用临时 token 登录的浏览器此时需要重新登录。

### 访问凭据文件

- **URI**: `data:/webui/access.txt`
- **物理路径**: `data` 存储根对应目录下的 `webui/access.txt`，即家目录的 `state/webui/access.txt`；启动日志 `访问凭据已写入: ... （绝对路径: ...）` 直接给出
- **内容**: 注释 + `URL:` + `Token:` + `一键登录:`（带 `?token=` 的完整 URL）

> 历史路径 `data/webui-access.txt` 早已被 `data/webui/access.txt` 取代；家目录布局调整后 `data` 根映射到 `state/`，现行文件是 `<家目录>/state/webui/access.txt`（URI 仍是 `data:/webui/access.txt`），不要再读家目录 `data/` 下的旧文件。

### 登录方式

1. **一键登录 URL**：浏览器打开 `http://host:port/?token=<TOKEN>` → 服务端校验后 `Set-Cookie` 并 302 到干净 URL。
2. **手动登录**：访问 `http://host:port/`，在登录页粘贴 token → POST `/api/auth/login` `{ token }`。登录页不带内联脚本，脚本由不需登录的 `GET /api/auth/login.js` 给出（见下文「文档级 CSP」）。登录页的颜色取默认主题（偏中性深色与浅色，`@aalis/api-webui` 的 `DEFAULT_THEMES`）的令牌，深浅跟随系统，与前端同一套写法：不用卡片、不加阴影，圆角用小档。
3. **登出**：POST `/api/auth/logout` 清除 cookie。

### 登录失败限速

`?token=` 与 POST `/api/auth/login` 按来源地址（TCP 连接的对端地址）记失败次数：从这个地址第一次失败算起的 10 分钟内失败满 10 次，到这 10 分钟结束前它的这两种登录一律回 429，带 `Retry-After`（秒），正确的 token 也不收；窗口结束后自动解除，计数从零重来。登录成功时这个地址的计数清零。

- **别的网页发起的登录不比对、不计数。** 带 `Origin` 而与本服务不同源的 POST `/api/auth/login` 回 403（与所有改状态的请求一样，见下文「改状态的请求校验来源」），不带 `Origin` 的（脚本、命令行）照常比对。`Sec-Fetch-Site` 为 `cross-site` 或 `same-site` 的 `?token=`，即别的网页里的链接或图片，不认 URL 里的 token，按没带 token 处理：已登录的照常放行，没登录的回登录页。粘贴链接、书签与启动时自动打开的一键登录链接是 `none`，照常登录。这样同一台机器其他端口上的网页，或 owner 打开的任意网页，都没法借她的浏览器替她把来源地址锁住。
- **带 cookie 的请求不计数，也不受锁定。** 已登录的页面照常使用。按 cookie 逐个猜 token 不现实：自动生成的 token 是 24 字节随机数，`fixedToken` 至少 32 个字符。反过来，对 cookie 也锁定的话，共用一个来源地址（同一个反向代理）的已登录页面会被别人一起锁住。所以防猜靠 token 的长度，限速只是登录入口的又一道关。
- **本机回环地址同样计数。** 经同一台机器上的反向代理来的请求，对端地址都是回环地址，豁免回环就等于不限速。owner 在本机输错满额，等到窗口结束即可，不会被一直锁住。
- **经反向代理时所有访问者共用代理的地址。** 本插件不读 `X-Forwarded-For`：没有反向代理时这个头由访问者任意填写，按它计数等于让人自报地址。代价是一个人连续输错，会让经同一代理登录的其他人也等到窗口结束。
- **失败计数最多记 10000 个地址。** 满了再记新地址时丢掉最早的那条，内存不随来源地址的数量增长。

### 登录身份与权限

通过 token 登录后，请求身份被判定为 `webui:console`，而 `cli:console` / `webui:console` 在 authority 里直接视为 **owner（最高等级）**——可以驱动 exec 等受限工具、改配置、装卸插件。也就是说：

> **谁拿到这个 token，谁就等同于这台机器的 owner。**

而默认 `tokenMode=persist` 下 token 长期不变、且明文写在 `data:/webui/access.txt` 里。因此把 `host` 改成 `0.0.0.0`（或经反代暴露到公网）之前：

- 确认处在可信网络，或在前面加一层独立鉴权（反代 Basic Auth / mTLS / 只对内网开放）；
- 经反向代理访问时，代理要把原始的 `Host` 转给本插件，WebSocket 与登录请求的来源校验按它比对（见下文「WebSocket」）；
- 改用 `tokenMode=fixed` 配一个至少 32 个字符的随机 token，并妥善保管 `access.txt`；
- 权限语义详见 [plugin-authority](./plugin-authority.md)。

### 改状态的请求校验来源

所有改状态的请求（方法不是 GET、HEAD、OPTIONS：页面动作、配置写入、插件启停与安装、登录与注销等）先过来源校验，判定与 WebSocket 握手的同一个（`originAllowed`，见下文「WebSocket」）：带 `Origin` 而与本服务不同源的回 403，带着有效的 cookie 也不放行；同源的照常处理；不带 `Origin` 的（脚本、命令行）照常按 token 认证。原因是 `SameSite=Strict` 按站判、不分端口：同一主机别的端口上的网页发一个 `text/plain` 的简单 POST，浏览器就会带上 cookie。GET 不看来源，它们不改状态。

### 文档级 CSP

每个响应都带文档级 CSP，前端的 HTML（首页与任意地址上的刷新）、登录页与切换恢复页都在其中：

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

- 脚本只许同源：本插件直出的登录页与恢复页不内联脚本，脚本分别由 `GET /api/auth/login.js`（不需登录）与 `GET /__clients.js` 给出。
- 样式放开内联：Mermaid 的输出带内联样式。
- 图片只认同源、`blob:` 与 `data:`：外站图片不加载，前端把它们显示成链接。
- 不许被别的页面嵌入（`frame-ancestors 'none'`）。
- `/api/media` 另设更严的 `sandbox; default-src 'none'`。

### Cookie

- 名称：`aalis_webui_token`
- 属性：`HttpOnly; SameSite=Strict; Path=/; Max-Age=30d`
- 进程重启且 tokenMode=ephemeral 时 cookie 自动失效。

### 自动打开浏览器

`autoOpen=true` 时在监听成功后经 process 服务以 detached、`stdio:'ignore'` 方式启动系统默认浏览器（macOS `open`、Windows `cmd /c start ""`、其它平台 `xdg-open`），参数为带 token 的访问 URL，随后 `unref()`；process 服务缺失或启动失败时静默忽略。

每次应用启动都打开一次，包括 persist 读回已有 token 和 fixed 使用配置 token 的情况。同一应用内插件重载沿用 token 时不重复打开；ephemeral 每次激活生成新 token，旧页面失效，因此重载也会打开。persist 写入 token 失败、下次激活重新生成时同样再次打开。去重按 App 身份独立记录；自定义宿主若不提供 app 服务，则每次监听成功都会尝试打开。`autoOpen=false` 时全部不打开。

## REST API

除 `/api/auth/login`、`/api/auth/status`、`/api/auth/logout` 与登录页的脚本 `/api/auth/login.js` 外，所有 `/api/*` 都需登录（cookie），未登录返回 401；未命中的 `/api/*` 路径返回 404 JSON（不落到 SPA 兜底）。改状态的请求另校验来源，见上文。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/auth/login` · `/api/auth/logout` · `/api/auth/status` | POST · POST · GET | 登录换 cookie / 登出 / 登录状态 |
| `/api/plugins` | GET | 插件列表（含状态、配置、Schema、错误信息）；配置取配置文档里的形态：宿主提供密钥存储时，`secret` 字段上是引用 `{ $secret: '<键>' }`，不回原值；没有密钥存储的自组装宿主，文档里本就是明文，接口原样返回（表单只遮蔽显示）。顶层另给 `secretRefCounts`（键 → 配置文档里引用它的处数），表单据此提示替换会影响几处。宿主不提供 `host-config` 时给运行态配置并去掉 `secret` 字段。激活超过慢激活阈值、已转入后台的插件带 `slow: true` |
| `/api/plugins/:name/config` | GET / PUT | 单插件配置读写，GET 读配置文档（宿主有密钥存储时 `secret` 字段上是引用）；PUT 体为 `{ config }`，经 `host-config` 的 `applyPluginConfig` 热重载该插件、写回配置文档并落盘。`secret` 字段上原样回传引用表示保持原值，写新值表示替换：新值存进宿主的密钥存储（Node 宿主是 `secrets.yaml`），配置文档里只留引用（写入规则见 [api-host-config](../api/api-host-config.md#改插件配置)）。提交里新引入的悬空引用（键不在密钥存储里、也不是这次写入的）返回 400，运行态与文档都不动。PUT 是部分更新：提交的顶层键整键替换原值（分组、数组整块替换），没提交的保持原值，值为 `null` 的顶层键视为删除；之后按 schema 默认值深合并补齐缺的键，删除的键有默认值时回到默认值（`secret` 字段的默认值不写进文档，删除后由插件解析时补上）。插件有 `configSchema`、且宿主按裁剪政策运行（`host-config` 的 `trimUnknownFields`，Node 宿主缺省开启，`startAalis({ configSync: { trimUnknownFields: false } })` 关闭）时裁掉未声明的字段；宿主保留未知字段时这里同样保留，不附下述点名：本次提交里的在响应 `ignored` 里点名；配置文档里原有、本次没有提交的随写回从配置文件删除，在响应 `removed` 里点名；两者都附在 `message` 末尾。插件运行中、且解析出的配置与运行态相同时，不重载插件，仍把配置文档写回文件（此前保存写文件失败时，原样重试即可补写）；配置文档也没有变化时回复「配置无改动，已写回配置文件」。按新配置重新激活失败、插件转为 `error` 态时，配置照样写回，仍返回 200 与 `{ ok: true }`，`message` 说明激活失败及原因：这个接口回 2xx 即表示配置已写进配置文件，WebUI 据此收起表单、刷新状态，非 2xx 时表单留着供改正。插件处于禁用态时照样换上新配置并写回，插件保持禁用，启用时按新配置激活，回执说明这一点。插件不存在时返回 404（没登记的实例不在这里新建，新建走 `POST /api/plugins/:name/instances`）；插件还在但停机中或正在卸载、拒绝了这次更新时返回 409，配置文件不变 |
| `/api/plugins/:name/enable` · `/api/plugins/:name/disable` | POST | 热启用 / 热禁用，写回 `disabledPlugins`。启用后激活失败、转为 `error` 态时，照样写回启用，仍返回 200 与 `{ ok: true }`，`message` 说明激活失败及原因；停用仍在初始化的插件而它未在宽限内停止、转为 `error` 态时，照样写回禁用，同样返回 200，`message` 说明它未在宽限内停止、已转为 `error` 态。插件不存在时返回 404；停机中或插件正在卸载时拒绝，返回 409，配置文件不变 |
| `/api/plugins/scan` | POST | 经宿主的 `plugin-source` 服务重新扫描插件源（范围由宿主的加载器决定），加载新发现且尚未注册的插件；宿主未提供插件来源时返回 503 |
| `/api/plugins/:name/instances` · `/api/plugins/:instanceId/instance` | POST · DELETE | 多实例插件的创建 / 移除。创建的请求体为 `{ suffix, config? }`，`config` 与 PUT 插件配置同一套处理：按 schema 默认值深合并、按宿主的裁剪政策裁掉未声明的字段（在响应 `ignored` 里点名，附在 `message` 末尾）；有类型不符的值时不创建，返回 400。创建同样经 `applyPluginConfig`：`secret` 字段上的值拆进密钥存储，先写配置文档再登记。停机进行中创建会被拒绝登记，返回 409，配置文档与密钥都撤回、不写入；创建后激活失败、实例转为 `error` 态时，实例与配置照样保留并写入配置文件，仍返回 200 与 `{ ok: true, instanceId }`，`message` 说明激活失败及原因：创建回 2xx 即表示实例已登记、配置已写进配置文件，WebUI 据此收起建实例表单、刷新列表；落盘失败的回执带 `applied: true`（见下文），实例同样已在运行态登记，表单也收起；其余非 2xx 时表单留着；配置文件的 `disabledPlugins` 里已有该实例（手改配置文件留下）时以禁用态登记，回执说明这一点。移除时先从配置文件删掉该实例的配置段与禁用标记（同名重建以启用态登记；不再被任何配置引用的密钥随这次保存从 `secrets.yaml` 删除），落盘成功后再卸载实例；卸载失败时返回 500，说明配置段已从配置文件删除、卸载失败；停机进行中删除时内核不受理卸载，配置段照样删掉，返回 200，`message` 注明停机中、未卸载运行中的实例 |
| `/api/pages` · `/api/session-pages` | GET | 登记着的声明式页面（声明去掉函数，带上实例与位置）/ 这个会话（`?sessionId=`）适用的会话面板页面。见下文「声明式页面」 |
| `/api/pages/:instance/:pageKey/data/:componentId` · `/api/pages/:instance/:pageKey/actions/:action` | GET · POST | 页面组件的数据源 / 页面动作，经服务端闸门调用，见下文「声明式页面」 |
| `/api/page-file` | GET | 页面单元格里的文件按句柄下载（`?handle=<文件单元格的 handle>`），句柄由本插件签发；下发方式与错误同 `/api/session-file` |
| `/api/layout` | GET · POST | owner 的布局记录（图标栏上固定的页面、会话面板的标签）/ 按一个操作改它，见下文「布局记录」 |
| `/api/config` · `/api/config/save` | GET / PUT · POST | 全局配置：GET 读取整份配置文档（宿主有密钥存储时，插件配置里的 `secret` 字段是引用，不是原值）；PUT 可改 `name`、`logLevel`、`slowThresholdMs`（`CORE_CONFIG_SCHEMA` 的键）；请求体里其余顶层键一律不应用，其中与当前值不同的会在响应 `ignored` 里点名（前端会把整份配置连同可能过期的快照回传，故不按键报错）；文档里没写的核心键按 schema 默认值比较（前端把默认值回填进草稿后回传，不算改动、不写进文件）；`logLevel` 或 `slowThresholdMs` 有变化时保存并自动重启应用（宿主不支持重启时记一条错误日志，响应 `restart: false`，`message` 说明改动已写入文件、下次启动生效），只改 `name` 时只保存、不重启（它只是显示用的应用名称）；POST `/api/config/save` 把当前配置写回磁盘（宿主不持久化时不写盘，回执只说「配置已保存」） |
| `/api/services` · `/api/services/:name/prefer` | GET · POST / DELETE | 服务列表 / 设置或清除服务偏好提供者（持久化到 `servicePreferences`） |
| `/api/service-groups` · `/api/system-components` | GET | 服务分组 / 系统组件 |
| `/api/platforms` | GET | 平台连接状态。`webui` 平台的连接数是打开着的 `/session` 连接数 |
| `/api/models/:service` · `/api/llm-providers` | GET | 按服务取模型列表 / LLM 提供者与各自的模型 |
| `/api/llm-providers/:contextId/refresh` | POST | 触发该 provider 重新探测模型列表（仅对支持运行时刷新的 provider 有效）。`:contextId` 是提供者的插件实例 id，与 `/api/llm-providers` 返回的 `contextId` 相同。名下的模型都不提供运行时刷新（如关闭了 `discoverModels`）、或名下没有已注册的模型时返回 404，分别说明 |
| `/api/marketplace` · `/api/marketplace/depgraph` | GET | 市场搜索（`?q=`）/ 依赖图。检索走 `marketplaceRegistry`，结果再按搜索词在包名、描述、关键词上过滤（不区分大小写，空格分隔的每个词都要命中）。检索源不可达时只列本地已装的包，同样按搜索词过滤，响应带 `warning` 说明。卡片的最新版（`version`）与 `updatable`、`/api/system-components` 的 `latest`、依赖图里未安装包的依赖与服务，都按包名向安装实际使用的源（`package-manager` 报告的 npm registry）查；`package-manager` 缺席时退回检索源；安装源查不到时不给最新版与可更新，响应带 `warning` 说明原因 |
| `/api/marketplace/install` · `/api/marketplace/uninstall` | POST | 体为 `{ name }`；需 `package-manager` 服务（缺失时 503）。安装后热加载，卸载后热卸载；插件装上但激活失败、转为 `error` 态时仍返回 `{ ok: true }`，`message` 说明激活失败及原因；慢激活转入后台仍在进行、或在等 required 依赖时同样返回 `{ ok: true }`，`message` 说明尚未激活。装卸只接受插件与前端界面包；若有其它插件依赖该包提供的服务，且没有别的插件正在提供该服务，卸载被拒绝。这些拒绝来自 `package-manager` 服务层，以 HTTP 200 返回 `{ ok: false, message }` |
| `/api/marketplace/update` | POST | 体为 `{ targets: [{ name, version }] }`，整批更新，成功后重启进程；需 `package-manager` 服务（缺失时 503） |
| `/api/logs/tail` · `/api/logs/range` | GET | 日志：尾部 N 条（`?limit=`，默认 200，上限 5000）/ 向前翻页（`?before=<seq>&limit=`，返回 seq 小于 before 的记录）。实时日志在 `/admin` 上订阅 |
| `/api/proxy/image` | GET | 图片代理 |
| `/api/media` | GET | 聊天里的图片、视频、音频按存储地址取（`?uri=data:/images/x.png` 这类）：按文件头判定类型，只提供 PNG、JPEG、GIF、WebP、MP4、WebM 与 MP3、WAV、OGG、M4A，其余（含 HTML、SVG、JSON）回 415；响应带 `nosniff` 与 `sandbox` CSP。文件不存在回 404；其余读不出的（含存储拒绝的越界路径）回 500 并记告警。客户端把消息与会话历史里的存储地址换成这条路由 |
| `/api/session-file` | GET | 会话条目里的文件按句柄下载（`?sessionId=<会话>&handle=<附件的 src>`）。句柄由会话服务签发，先经 `sessionProtocol.resolveFile` 核验，再按核验出的存储地址读出，一律以 `application/octet-stream`、`Content-Disposition: attachment`（文件名取句柄里的名字，`filename*` 按 RFC 8187 编码，另带 ASCII 的 `filename` 退路）与 `nosniff` 下发。句柄核验不过（伪造、改动过、别的会话的、会话服务重启之前签发的，或会话服务不在）回 403，文件已不在回 404，其余读不出的回 500 并记告警。这条路由不接受存储地址，哪些文件不签发见 [plugin-session-server](./plugin-session-server.md#文件句柄) |

core 的插件管理动作与 `services.prefer` 只改运行态；启停、删除实例与服务偏好要跨重启保留，由对应路由另经 `host-config` 写配置文档并落盘；改插件配置与新建实例经 `host-config` 的 `applyPluginConfig`，运行态、文档、密钥与落盘一步完成。宿主未提供 `host-config` 时，读写配置文档的路由（`/api/config`、`/api/config/save`、`/api/plugins/:name/config`、启停、实例增删）与服务偏好的设置 / 清除路由返回 503。运行态已改、随后落盘被拒（如配置文件有尚未生效的外部修改）时，启停、改插件配置、新建实例与服务偏好路由返回 409 与 `{ error, applied: true }`：改动已在运行态生效，但没有写入配置文件。修好被拒写的文件后，插件配置随热重载回到文件里的值，新建而未写入文件的实例随热重载卸载；启停与服务偏好在重启时以文件为准。修好文件的方式不限，原样改回也会触发这次对账。落盘因其它原因失败（如没有写权限、磁盘写满）时，这些路由返回 500 与 `{ error, applied: true }`：文件没有变化，也不会触发重载，改动保留在配置文档里，下一次保存成功时一并写入。这两种情形下，插件在动作之后没有进入预期状态（激活失败、未在宽限内停止、仍在激活、在等依赖或保持禁用）时，`error` 开头先说明这一点。删除实例先落盘、后卸载：后缀实例由配置段定义，热重载也按文件登记，先卸载后落盘时卸载途中的热重载会按仍带配置段的文件把实例重新登记。落盘被拒返回 409、其它失败返回 500，实例不删除，文档里的配置段与禁用标记还原。全局配置（`PUT /api/config`）落盘失败时撤回文档里的改动，被拒返回 409、其它失败返回 500：撤回后 `logLevel`、`slowThresholdMs` 与 `name` 都回到修改前。`POST /api/config/save` 同样是被拒返回 409、其它失败返回 500。

启用、改插件配置与新建实例在管理动作之后等插件状态机静置（`plugins.idle()`），再按实例状态写回执：动作撞上在飞的重算时只排队、立即返回，直接读状态会把随后的激活失败报成成功。转入后台的慢激活不等，重算对单个激活至多等到慢激活阈值；这时回执说明插件仍在激活，在等 required 依赖的说明尚未激活，两者都返回 200。市场安装由 `package-manager` 按同一口径回执。

## WebSocket

WebSocket 与 HTTP 同端口，两个端点：`/session` 是会话协议，`/admin` 是管理面推送。升级请求先校验来源，再认证，最后认路径，两个端点都一样：

- **来源**：带 `Origin` 的握手只收与本服务同源的，即 `Origin` 的主机与端口等于请求的 `Host`（两边都去掉协议的默认端口再比，代理转来的 `Host` 写成 `x:443` 也认），否则回 403。同一主机别的端口上的网页与 WebUI 同站，`SameSite=Strict` 的 cookie 会随它发起的握手一起发出，这一关把它拦下。浏览器发起的握手一律带 `Origin`；不带的是脚本、命令行等浏览器之外的客户端，不会被别的网页借用户的浏览器发起，只按 token 认证。经反向代理访问时，代理要把原始的 `Host` 转过来，否则浏览器的握手都会被当成跨源。没有额外放行来源的配置项：WebUI 的页面由本服务提供，或经转发原始 `Host` 的代理访问（前端开发时的开发服务器代理也是这样），握手都是同源的。
- **认证**：与 HTTP 相同（cookie 里的 token），没登录或 token 不对回 401。
- **路径**：只认这两个路径（可以带查询串），其他路径回 404。

每条连接都有心跳：每 30 秒 ping 一次，30 到 60 秒内没回 pong 的半开连接被踢掉。插件卸载时各端点的连接以 1001「webui 正在卸载」关闭。

### `/session`：会话协议

协议本身（帧、握手、方法、推送、错误码、条目种类）见 [api-session-protocol](../api/api-session-protocol.md)，实现见 [plugin-session-server](./plugin-session-server.md)。本插件只做传输：

- 一条连接接到会话服务的一次 `sessionProtocol.connect`。对端身份取自认证，即 `{ platform: 'webui', userId: 'console' }`。
- 本插件启动时经 `approvals.registerSurface('webui')` 登记 `webui` 审批面（见 [api-approval](../api/api-approval.md)），每条连接的对端都带着这个登记句柄：连接上的在场上报与审批应答记在 `webui` 与本插件实例名下，连接自己报不了别的面。握手结果里的审批面是登记名 `webui`。审批服务晚于本插件上线也不用重启本插件。
- 每个文本帧是一个 JSON-RPC 帧，原文转交会话服务；服务端发出的帧原样发回。连接关闭时撤掉会话服务那头的连接。
- 会话服务在每条连接到达时现取，会话服务晚于本插件上线、停用后重新启用，都不用重启本插件。
- 条目里图片、音频、视频的 `src` 是存储地址或网址，经 `/api/media` 取；其他文件的 `src` 是会话服务签发的句柄，经 `/api/session-file` 下载（见上文 REST API）。

关闭码：

| 码 | 原因 | 客户端怎么办 |
|---|---|---|
| 1000 | 会话服务断开这条连接，原因由它给出：握手时主版本不合（之前已回 `unsupported` 错误帧），或「会话服务已停止」（停用、重载） | 主版本不合时不重连；其余稍后重连，接到新的提供者 |
| 1001 | `webui 正在卸载` | 稍后重连 |
| 1013 | `会话服务不在`：会话服务没装、停用或没激活成功 | 稍后重连 |

关闭帧的原因最多 123 字节，会话服务给的原因更长时按整字截短（例如握手时客户端报的版本号很长）。帧本身不合规时按 WebSocket 标准的关闭码关闭，例如文本帧里不是合法的 UTF-8 为 1007。

浏览器里的客户端：

```ts
const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/session`); // 同源，cookie 自动带上
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

### `/admin`：管理面推送

事件与消息的类型、前端怎么处理见 [api-webui](../api/api-webui.md) 的「管理面推送」一节。本插件的推送来源：

| 事件 | 来源 | 推给谁 |
|---|---|---|
| `log` | 进程级日志中枢的每条新日志，与写进 `logs:/latest.log` 的是同一份 | 发过 `log.subscribe`、还没退订的连接 |
| `plugins.changed` | core 每次重算插件状态之后的 `plugins:changed`；页面登记表的每次登记与撤回 | 全部 `/admin` 连接 |
| `page.invalidate` | 插件调页面的 `invalidate`，以及页面登记时（插件重载后打开着的页面换成新一次激活的数据）；按实例、页面、组件与会话合并：同一组第一次立即推，一秒内再来的并成窗口结束时的一次 | 全部 `/admin` 连接 |
| `layout.changed` | `POST /api/layout` 改动了记录（没有变化的操作不推） | 全部 `/admin` 连接 |
| `app.restarting` | core 的 `app:restarting` | 全部 `/admin` 连接 |
| `client.reload` | 改或清除 `webui-client` 的服务偏好之后；装卸包后重新发现前端、摘掉了已不在的前端包之后 | 全部 `/admin` 连接 |

前端发来的只有 `log.subscribe` 与 `log.unsubscribe`；认不出的消息记一行告警「WebUI /admin 收到认不出的消息，已忽略」，连接照常。连接关闭时它的日志订阅随之撤掉。本插件只在卸载时主动关闭连接（1001），客户端稍后重连。

## 声明式页面

插件经 `webuiServer` 的 `definePage` 与 `notify` 登记页面与提示（契约见 [api-webui](../api/api-webui.md#声明式页面)），本插件按插件实例收下，插件停用时同一拍撤回。

- **登记时的质量门槛**（`page-check.ts`）：嵌套、一屏组件数与标签数、组件 id、动作的引用与放置、不认识的字段，不过就不登记，记一条错误日志「页面 <key>（<实例>）没过登记校验，未登记：…」，列出每个问题与位置。提示的 `open` 要指向本实例已登记、位置为 `plugin` 或 `settings` 的页面，否则同样不登记、记错误日志。
- **服务端闸门**（`pages.ts`）：数据源与动作按实例、页面与组件或动作分派，只许调声明过的；参数只收用得上的键（`sessionId` 给会话面板，`rowKey` 给详情里的组件与行动作，`input` 给声明了输入的动作），多的、缺的回 400；`input` 按声明的字段校验并解析，没过时回 400 与 `issues`。会话面板的 `sessionId` 经会话管理（`session-manager`，可选使用）核过存在，把规范化后的 id 交给插件；会话不存在回 404，会话管理不在回 503。页面的数据源与动作要把调用者交给插件，这两条路由自己解析身份（与其余路由的 owner 闸同一判定），不是 owner 回 403。
- **审计**：`write` 与 `destructive` 的动作每次调用记一行 info 日志「页面动作 <名>（<效果>）：<实例> 的页面 <key>，来自 <来源地址>」。结构化审计随设备分级另做。
- **调用的结果**：数据源或处理函数抛错回 500 与原因。数据源返回的形状不对（表格行缺 `rowKey` 或重复、`visibleWhen` 指名的字段不是布尔值、图片与文件列不是存储地址、关系图的边连着不存在的节点、文字不是字符串等）、处理函数返回的不是一句话，回 500 并记告警。
- **单元格里的图片与文件**：图片列的存储地址换成 `/api/media?uri=…`；文件列换成本插件签发的句柄（`page-files.ts`），经 `/api/page-file` 下载。句柄是「载荷.签名」：载荷是存储地址与文件名，签名是每次激活随机生成的密钥对载荷的 HMAC-SHA256，本插件重载后旧句柄失效，界面重新取数就拿到新的。哪些文件不签发与会话条目的句柄同一条规则（api-storage 的 `canIssueFileHandle`）：`data`、`pluginData` 两类根里的不签发，只给名字。会话条目的句柄由会话服务签发、绑定会话；页面的文件不属于哪个会话，会话服务也可能没启用，所以页面的句柄由本插件另设签发器。
- **会话面板**：`GET /api/session-pages` 按会话一次算完，`applies` 并行地问，抛错、超过 2 秒或没回布尔值按不适用处理，记一条告警。
- **invalidate**：按实例、页面、组件与会话合并，同一组一秒内最多推一次 `page.invalidate`；本插件卸载时清掉合并窗口。

### 布局记录

图标栏上固定的页面与会话面板的标签存在本插件的插件数据里（`pluginData:/webui-server/layout.json`，Node 宿主在家目录的 `state/plugins/webui-server/`），跟着 owner 走，换设备、换浏览器一致。不放进插件配置：保存配置会重载本插件、断开会话连接。

- 按操作写（`POST /api/layout`）：固定、取消、上移、下移带 `page`（`{ op, page }`），会话面板标签的打开、关闭、上移、下移带 `tab`（`{ op, tab }`，`tab` 是宿主标签 `{ host }` 或页面）。操作排队逐个应用，每个操作落盘成功才算数，两台设备同时改各自生效；落盘失败回 500，记录不变。
- 固定只收此刻登记着、位置为 `plugin` 的页面，打开插件标签只收位置为 `session` 的页面；其余只动记录，所属插件停用时也能改。关闭只把标签标为关、位置不动，插件标签第一次打开时追加在末尾。每个列表最多 50 条（会话面板的标签连同宿主标签算），满了回 409。
- 文件读出时只留形状对的、不重复的条目，认不出的宿主标签一并丢掉；缺的宿主标签按宿主的顺序补在末尾、开着。内容坏了记告警，按没有记录起步，下次改动时覆盖；读不出来（权限、存储不可用）回 500，下次再读。存储服务不在时两条路由回 503。
- 记录变了推 `layout.changed`。只有 owner 能读写：只有 owner 能登录 WebUI，在线用户能进 WebUI 时再按身份分开存。

## WebUI 会话的收件箱

发往 WebUI 自己会话的出站消息（`outbound:message` 的 `platform` 为 `webui`，会话 id 不带别的平台前缀）由本插件认领投递回执：会话历史就是 WebUI 的收件箱，页面只是查看器，打开着的页面由会话服务推送。回执成功表示这条消息已进会话历史，不看有没有页面在线。owner 从 WebUI 驱动的房间（会话 id 以别的平台名开头）由那个平台的适配器认领；不带 `platform` 的出站消息本插件不认领；已有回执的消息不覆盖。

- agent 的文字回复由 agent 存档，这里不再记；
- 不是她说的文字（系统提示、指令回复、宿主通知）经 message-archive 记成事件标记，回看时显示成分隔条，不进模型上下文；
- 图片、视频、音频按 `outboundMediaMessage` 的格式记，会话服务据此还原成附件；
- 给的是存储地址的文件同样按这个格式记（描述位记文件名，`metadata` 另记原样的 `ref` 与 `name`），会话服务给它签发下载句柄。这样的文件以 `[文件: 名称 | ref:…]` 进入模型上下文与记忆，与 QQ 等平台不同：image-sender 只归档图片、音频、视频，那些平台上发出的文件不进历史；
- 不是存储地址的文件（网址、data URL）签不出句柄，记成事件标记 `[文件] 名称`，内容不进历史；
- 带 `skipArchive` 的附件（`history_ref` 重发，原图已在历史里）不记。

记完之后发出的 `outbound:delivered` 快照给附件标上 `skipArchive`，image-sender 不再记一份，因此发往 WebUI 的网址图片与视频不由它补视觉描述。存档服务不在场或写入失败时回执失败。一条消息要写多条记录（如正文加几个文件）时逐条写入，中途失败时回执失败，已写成的几条不撤回，发起方重发后这几条会重复。

本插件仍以 `webui` 平台名登记一个平台适配器，平台档、会话范围的候选与用户关系认的平台名里才有它；连接状态数的是打开着的 `/session` 连接。WebUI 的会话不经这个适配器收发，它的 `sendMessage` 一律拒绝并写明原因。

## 前端挂载与切换

前端不内置在 server 里——它是 `webui-client` 服务的 **provider**：每个前端包用 `package.json` 标 `aalis.client: true` + 构建出 `dist/index.html`，server 启动时由 `client-discovery.ts` 按标记**动态发现**并各注册一个 provider（无硬编码包名，第三方可自带前端）。

扫描的目录是安装集（`host-paths` 的 `app`）下的 `packages/` 与 `node_modules/@aalis`，另按安装集 `package.json` 的依赖解析前端包。宿主不提供 `host-paths` 时没有可扫的目录，发现不到任何前端，整个 WebUI 前端不可用，页面路径回 404「前端未就绪」，只剩 HTTP 接口；同时市场列表（`/api/marketplace`）与系统组件（`/api/system-components`）判断不了已装的包，返回 503。Node 宿主 `@aalis/runtime` 总会提供 `host-paths`。

**挂载哪个**：`servicePreferences['webui-client']` > provider 优先级 > 注册顺序。改偏好（`POST /api/services/webui-client/prefer` `{contextId}`，owner 闸）后**实时重挂静态目录，向 `/admin` 推 `client.reload`**，无需重启进程。

**SPA 兜底**：活跃前端的目录里没有的路径（不在 `/api/` 下）一律回它的 `index.html`，在 `/s/:id` 这类地址上刷新也能加载；`/assets/` 下缺失的文件回 404，不回 `index.html`，免得旧页面引用的、换了构建就不在的脚本被当成 HTML 执行。页面只在源的根上提供，不支持挂在反向代理的子路径下。

### 切换逃生页 `/__clients`

前端切换的下拉框位于前端界面内；一旦切到不含该 UI 的极简前端，就没有切回去的入口。为此 server 在 `GET /__clients` 直出一个独立恢复页（源码 `client-switch-page.ts`），它不依赖当前前端，切到任何前端后都可访问。

- 受全局 auth 中间件保护（须先登录，同源 cookie 自动鉴权）；脚本是同源的 `GET /__clients.js`；列表走 `GET /api/services`、切换走 `POST /api/services/webui-client/prefer`（owner 闸），**零新增后端逻辑**。
- **用法**：浏览器开 `http://<host>:<port>/__clients` → 选目标前端 → 点「切换并刷新」→ 成功后自动跳回 `/`。检测到多个前端时，启动日志也会打印此 URL。
- **手动恢复**：直接改 `aalis.config.yaml` 的 `servicePreferences.webui-client`（或删该项回退默认）后重启。
