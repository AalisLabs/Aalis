# plugin-webui-server — WebUI 服务端

**包名**: `@aalis/plugin-webui-server`  
**源码**: `packages/plugin-webui-server/src/index.ts`

## 概述

Express + WebSocket 实现的 Web 管理后台和聊天平台，提供 REST API 与 WebSocket 实时通信，并作为 `webui` 平台适配器接入聊天。

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
    app: optional(appService),
    plugins: optional(pluginsService),
    source: optional(pluginSource),
    storage: optional(storage),
    authority: optional(authority),
    commands: optional(commands),
    platform: optional(platform),
    process: optional(processService),
    sessionConfirm: optional(sessionConfirm),
    tools: optional(tools),
    llm: optional(llm),
    persona: optional(persona),
    agent: optional(agent),
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
| `autoOpen` | boolean | `true` | 启动时自动打开浏览器：启动时以含 token 的 URL 自动开启默认浏览器；SSH/headless 环境建议关闭 |
| `tokenMode` | select | `'persist'` | Token 策略：ephemeral=每次启动随机；persist=token 写入 data:/webui/token，读取复用；fixed=使用 fixedToken 字段。所有模式都会写出便利文件 data:/webui/access.txt 含访问 URL。 |
| `fixedToken` | string | `''` | 固定 Token（仅 tokenMode=fixed 生效）：请使用足够长的随机字符串；配置文件不支持环境变量插值，写 ${VAR} 会被当作字面量。 |
| `relationGraphDefaultSpacing` | number | `120` | 关系图默认密度：关系图（RelationGraph）布局密度的服务器默认值（约等于理想边长 px，建议 60–250；越大越稀疏）。前端每个用户可在图工具栏现场覆盖并保存到本地浏览器；改完此项后，刷新关系图页面或新会话生效。 |
| `marketplaceRegistry` | string | `'https://registry.npmjs.org'` | 插件市场 npm 源：插件市场检索用的 npm registry 基址。注意 npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），默认官方源；国内可填支持 search 的镜像或代理。安装走 package-manager（遵循本机 npm 配置）。 |

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
- **物理路径**: `data` 存储根对应目录下的 `webui/access.txt`，启动日志 `访问凭据已写入: ... （绝对路径: ...）` 直接给出
- **内容**: 注释 + `URL:` + `Token:` + `一键登录:`（带 `?token=` 的完整 URL）

> 不要再读历史路径 `data/webui-access.txt`，已被 `data/webui/access.txt` 取代。

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

## REST API

除 `/api/auth/login`、`/api/auth/status`、`/api/auth/logout` 外，所有 `/api/*` 都需登录（cookie），未登录返回 401；未命中的 `/api/*` 路径返回 404 JSON（不落到 SPA 兜底）。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/auth/login` · `/api/auth/logout` · `/api/auth/status` | POST · POST · GET | 登录换 cookie / 登出 / 登录状态 |
| `/api/status` | GET | 系统状态、上传能力检测 |
| `/api/plugins` | GET | 插件列表（含状态、配置、Schema、错误信息） |
| `/api/plugins/:name/config` | GET / PUT | 单插件配置读写；PUT 体为 `{ config }`，热重载该插件后写回配置文档 |
| `/api/plugins/:name/enable` · `/api/plugins/:name/disable` | POST | 热启用 / 热禁用，写回 `disabledPlugins` |
| `/api/plugins/scan` | POST | 经宿主的 `plugin-source` 服务重新扫描插件源（范围由宿主的加载器决定），加载新发现且尚未注册的插件；宿主未提供插件来源时返回 503 |
| `/api/plugins/:name/instances` · `/api/plugins/:instanceId/instance` | POST · DELETE | 多实例插件的创建 / 移除 |
| `/api/pages` | GET | 所有激活插件注册的 WebUI 页面（按 order 排序） |
| `/api/page-action/:plugin/:method` | POST | 动态调用插件页面处理器（统一 RPC 入口） |
| `/api/config` · `/api/config/save` | GET / PUT · POST | 全局配置：GET 读取；PUT 可改 `name`、`logLevel`（`CORE_CONFIG_SCHEMA` 的键）；请求体里其余顶层键一律不应用，其中与当前值不同的会在响应 `ignored` 里点名（前端会把整份配置连同可能过期的快照回传，故不按键报错）；可改键的值有变化时保存并自动重启应用；POST `/api/config/save` 把当前配置写回磁盘 |
| `/api/services` · `/api/services/:name/prefer` | GET · POST / DELETE | 服务列表 / 设置或清除服务偏好提供者（持久化到 `servicePreferences`） |
| `/api/service-groups` · `/api/tool-groups` · `/api/system-components` | GET | 服务分组 / 工具分组 / 系统组件 |
| `/api/platforms` | GET | 平台连接状态 |
| `/api/models/:service` · `/api/llm-models` · `/api/llm-providers` | GET | 按服务取模型列表 / LLM 模型与提供者 |
| `/api/llm-providers/:contextId/refresh` | POST | 触发该 provider 重新探测模型列表（仅对支持运行时刷新的 provider 有效） |
| `/api/marketplace` · `/api/marketplace/depgraph` | GET | 市场搜索（`?q=`）/ 依赖图 |
| `/api/marketplace/install` · `/api/marketplace/uninstall` | POST | 体为 `{ name }`；需 `package-manager` 服务（缺失时 503）。安装后热加载，卸载后热卸载。装卸只接受插件与前端界面包；若有其它插件依赖该包提供的服务且无其他提供者，卸载被拒绝。这些拒绝来自 `package-manager` 服务层，以 HTTP 200 返回 `{ ok: false, message }` |
| `/api/marketplace/update` | POST | 体为 `{ targets: [{ name, version }] }`，整批更新，成功后重启进程 |
| `/api/files*` · `/api/uploaded-files*` | GET / POST | 工作区文件管理 / 上传文件管理 |
| `/api/logs/tail` · `/api/logs/range` | GET | 日志：尾部 N 条（`?limit=`，默认 200，上限 5000）/ 向前翻页（`?before=<seq>&limit=`，返回 seq 小于 before 的记录） |
| `/api/proxy/image` | GET | 图片代理 |

core 的插件管理动作与 `services.prefer` 只改运行态；启停、改配置、实例增删与服务偏好要跨重启保留，由对应路由另经 `host-config` 写配置文档并落盘。宿主未提供 `host-config` 时，读写配置文档的路由（`/api/config`、`/api/config/save`、`/api/plugins/:name/config`、启停、实例增删）与服务偏好的设置 / 清除路由返回 503。

## WebSocket

### 入站消息类型 (Client → Server)

| 类型 | 说明 |
|---|---|
| `message` | 用户发送聊天消息 |
| `subscribe_logs` | 订阅实时日志推送 |
| `subscribe_session` | 订阅指定会话更新 |
| `unsubscribe_session` | 取消会话订阅 |
| `abort` | 中断当前生成 |
| `compress` | 手动触发会话上下文压缩 |

### 出站消息类型 (Server → Client)

| 类型 | 说明 |
|---|---|
| `message` | 完整消息推送 |
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

## 流式缓冲管理

服务端为每个会话维护流式缓冲 `streamBuffers`，记录累积的 `content`、`reasoningContent`、按时序排列的 `segments`（文本、推理、工具调用）、进行中的工具调用进度和 `generating` 状态。客户端重连（如页面刷新）后发送 `subscribe_session`，若缓冲非空，服务端以 `stream_resume` 下发全部累积内容；回合结束后缓冲保留 10 秒再清理。

## 前端挂载与切换

前端不内置在 server 里——它是 `webui-client` 服务的 **provider**：每个前端包用 `package.json` 标 `aalis.client: true` + 构建出 `dist/index.html`，server 启动时由 `client-discovery.ts` 按标记**动态发现**并各注册一个 provider（无硬编码包名，第三方可自带前端）。

**挂载哪个**：`servicePreferences['webui-client']` > provider 优先级 > 注册顺序。改偏好（`POST /api/services/webui-client/prefer` `{contextId}`，owner 闸）后**实时重挂静态目录 + 广播 WebSocket `reload`**，无需重启进程。

### 切换逃生页 `/__clients`

前端切换的下拉框位于前端界面内；一旦切到不含该 UI 的极简前端，就没有切回去的入口。为此 server 在 `GET /__clients` 直出一个独立恢复页（源码 `client-switch-page.ts`），它不依赖当前前端，切到任何前端后都可访问。

- 受全局 auth 中间件保护（须先登录，同源 cookie 自动鉴权）；列表走 `GET /api/services`、切换走 `POST /api/services/webui-client/prefer`（owner 闸），**零新增后端逻辑**。
- **用法**：浏览器开 `http://<host>:<port>/__clients` → 选目标前端 → 点「切换并刷新」→ 成功后自动跳回 `/`。检测到多个前端时，启动日志也会打印此 URL。
- **手动恢复**：直接改 `aalis.config.yaml` 的 `servicePreferences.webui-client`（或删该项回退默认）后重启。
