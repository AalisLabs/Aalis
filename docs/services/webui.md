# webui 服务（Web 管理后台 / 前端托管）

## 1. 定位

WebUI 是 Aalis 的 **Web 管理后台**：启动一个 HTTP 服务器，提供 REST API（插件管理 / 配置 / 市场 / 日志 / 运行状况（需要处理、平台连接）/ 媒体与文件 / 声明式页面与布局记录）+ WebSocket（`/session` 接会话协议；`/admin` 推管理面事件：日志、插件与页面登记表的变化、页面数据变了、布局记录变了、「需要处理」变了、重启、换前端），并托管前端静态文件。第三方插件通过它**登记页面与提示**（页面默认声明式，需要自绘时用隔离的插件前端），也可整体替换前端或替换整个服务实现。

注意服务注册名（描述符 `name`）有**两个**，而非单个 `'webui'`：

- `'webui-server'` —— 后端服务，契约 `WebUIService`。描述符 `webuiServer`，绑定接口 `BoundWebui`（`packages/api-webui/src/index.ts`）。
- `'webui-client'` —— 前端「忒修斯之船」provider，契约 `WebuiClientProvider`。描述符 `webuiClient`，绑定接口是普通 `ServiceRef`。

契约包：`@aalis/api-webui`（`packages/api-webui/src/index.ts` 与 `page.ts`、`frame.ts`、`theme.ts`、`rest.ts`），**MIT**。它导出运行时服务契约、页面与提示的类型、插件前端的消息通道（消息类型、校验函数与宿主数据能力）、管理面事件、管理面 REST 的路由表与请求和回应类型、主题格式，以及向 `PluginMeta` 注入的 `extends`。

参考实现 `@aalis/plugin-webui-server` 与前端 `@aalis/plugin-webui-client` 均为 **AGPL-3.0-only**（与契约包许可不同，见第 6 节 AGPL 说明）。

页面与提示不是静态模块字段：在 `apply` 里经 `webui.definePage` / `webui.notify` 登记，随本次激活撤回。契约的全文（组件、动作、会话面板、质量门槛、路由）见 [api-webui](../api/api-webui.md#声明式页面)。

## 2. 契约

### 后端服务 `WebUIService`（`packages/api-webui/src/index.ts`）

```ts
export interface WebUIService {
  getPort(): number;
  getHost(): string;
  addPage(page: PageDefinition, instance: string): () => void;
  invalidate(instance: string, pageKey: string, componentId?: string, sessionId?: string): void;
  addNotice(notice: Notice, instance: string): () => void;
}
```

### 绑定接口 `BoundWebui`

```ts
export interface BoundWebui extends ServiceRef<WebUIService> {
  definePage(page: PageDefinition): PageHandle; // 泛型推断动作输入与引用，见 api-webui
  notify(notice: Notice): NoticeHandle;
}
```

`definePage` / `notify` 走 `registrar`：同键替换（页面按 key，提示按 id）、提供者换人整体重挂、关闭后拒收。插件不要自己传实例 id。`definePage` 返回的 `invalidate` 推给打开着这一页的界面；`notify` 返回的 `clear` 撤回这条提示。

### 前端 provider `WebuiClientProvider`

```ts
export interface WebuiClientProvider {
  getClientDir(): string;
}
```

### 声明式页面（`packages/api-webui/src/page.ts`）

一个页面 = key、标题、lucide 图标名、位置（插件详情、设置的一节、会话面板）、内容（组件数组或标签页）与动作。组件只有五样：`table`、`graph`、`info`、`markdown`、`actions`；表格与关系图可带详情。数据源与处理函数写在声明里，返回形状按组件种类推出；动作带 `effect`（`read`、`write`、`destructive`）、可选的 `input`（一组 schema-config 字段）与 `row`（行动作）。登记时 webui-server 按质量门槛校验，数据源与动作经服务端闸门调用。详见 [api-webui](../api/api-webui.md#声明式页面)。

声明式表达不了的页面用插件前端：`definePage` 写 `frame`（不写 `content`），插件包的 `webui/` 里放一份静态网页，webui-server 在 `/frames/` 下托管，宿主画进与宿主页面不同源的 iframe；它只能经消息通道调这一页声明过的数据源（`sources`）与动作，位置只有插件详情与会话面板。详见 [api-webui](../api/api-webui.md#插件前端)。

### 配置表单用到的字段属性

本包不向 `SchemaField` 注入属性。`secret`（值是凭据）与影响取值判定的 `dynamicOptions` / `allowCustom`（`parseConfig` / `validateConfig` 据此决定是否查选项成员资格）都由 `@aalis/schema-config` 声明，插件用到它们不必引入本包。动作的 `input` 用同一套字段。`secret` 字段在 WebUI 里的呈现见第 5 节。

`subsystem` 写在 `definePlugin({ subsystem })`（`PluginDefinition` 字段，core 不读）。`extends` 经本包 declaration merging 挂到 `PluginMeta`。

## 3. 谁提供 / 谁消费

**提供方**

- `@aalis/plugin-webui-server` —— 参考实现。`provides: [webuiServer, platform]`（`packages/plugin-webui-server/src/index.ts`），`provide(webuiServer, impl)`。它同时以 `webui` 平台名登记一个 `platform` adapter：平台名标明说话的是从 WebUI 来的 owner，连接状态数的是打开着的 `/session` 连接；WebUI 的会话不经它收发。`sessionProtocol`、`approvals` 等为 optional。
- `@aalis/plugin-webui-client` —— 默认前端（React SPA）。**不是被加载的插件**，而是带 `aalis.client: true` 标记 + `dist/index.html` 的纯静态包，被 webui-server 在 `app:ready` 时自动发现并登记成 `webui-client` 的一个 provider（可用 `onBehalfOf` 让偏好认前端包名；代登记不计入代理人 `provides`）。

**消费方**（经 `webui.definePage` / `notify`）：

| 插件 | 页面 |
| --- | --- |
| `plugin-paper` | 白纸（插件详情）与本群白纸（会话面板），另发未读告警与账本读取失败的提示 |
| `plugin-publish-review` | 作品审核，另发待裁决数与账本读取失败的提示 |
| `plugin-works-site` | 作品站（每个实例一页），健康状况不正常时发提示 |
| `plugin-scheduler` | 计划任务 |
| `plugin-authority` | 权限（设置） |
| `plugin-skills` | 技能（设置） |
| `plugin-doctor` | 诊断，另按每次运行的结果发出或撤回提示 |
| `plugin-workflow` | 工作流 |
| `plugin-tool-browser` | 浏览器 |
| `plugin-user-relation` | 人物关系图（`graph` 组件，疏密取本插件的 `graphSpacing`）与原始数据 |
| `plugin-file-reader` | 本会话上传的文件（会话面板） |
| `plugin-usage-stats` | 用量统计（按天、按周、按模型，服务商实现了余额查询时另有余额） |
| `plugin-mcp-client` | 没有页面；连不上的 MCP 服务器各发一条提示，改好配置重载后撤回 |

页面登记在 webui-server 实例的内存登记表里，路由按这张表分派。

## 4. 写一个 provider

绝大多数第三方作者**不替换 webui-server**，只是**登记页面与提示**。

### 4a. 消费 WebUI：登记一个声明式页面（最常见）

```ts
import { webuiServer } from '@aalis/api-webui';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-my-webui',
  subsystem: 'tools',
  uses: { webui: optional(webuiServer) },
  apply({ webui }) {
    const page = webui.definePage({
      key: 'my-plugin',
      title: '我的插件',
      icon: 'wrench',
      actions: { reset: { label: '清空', effect: 'destructive', confirm: '清空全部条目？', handler: async () => store.clear() } },
      content: [
        { type: 'info', id: 'summary', data: () => [{ label: '条目数', value: store.size }] },
        { type: 'actions', actions: ['reset'] },
      ],
    });
    store.onChange(() => page.invalidate('summary'));
  },
});
```

`webui-server` 缺失时登记排队、就绪后挂上，页面不显示。不必把 `webuiServer` 标成 required。

不要把 `webui.current` 存进字段：提供者换人后旧引用失效（有失效逻辑则抛，无则静默成功）；关停边不保护缓存引用。登记门面本身会随提供者换人重挂。

### 4b. 替换前端（`webui-client`）

- **纯静态包**：`package.json` 标 `aalis.client: true` + 提供 `dist/index.html`，被 webui-server 自动发现挂载，**无需 `apply`**。多前端共存时各成一个 `webui-client` provider，活跃者由「服务偏好」在 WebUI 设置「系统」里切换；卡住可访问 `/__clients` 逃生页切回。
- **主动覆盖**：插件 `apply` 里 `provide(webuiClient, { getClientDir: () => myDir }, { label: '我的前端' })`，展示名优先取提供方插件的 `displayName`，没有时取 provide 的 `label` 选项。`onBehalfOf` 代登记归属被代者，不计入代理人 `provides`。

### 4c. 替换整个后端（`webui-server`）

罕见。实现全部 `WebUIService` 必须方法（`addPage`、`addNotice` 要真正维护登记表，`invalidate` 要推给界面），用更高的 priority 或 `services.prefer` 压过默认实现。`definePlugin({ provides: [webuiServer], uses: { provide }, apply({ provide }) { provide(webuiServer, impl); } })`。同名胜出规则见 `docs/concepts/service-model.md`：偏好 > priority > 注册顺序。

## 5. 标准消费方式

- **登记**：始终经 `BoundWebui.definePage` / `notify`，不要绕过门面直接调 `WebUIService.addPage(..., instance)`——否则提供者换人时不会自动重挂，激活撤回也不会按条目退订。
- **服务缺失**：`webui.current` 在未就绪时为 `undefined`。登记用门面即可。
- **错误边界**：数据源或处理函数抛错，路由回 `500 { error }`，界面在那一块或操作的人那里显示原因；处理函数成功时可以返回一句话，宿主用 Toast 显示。
- **动态选项**：表单字段标 `dynamicOptions: '<serviceName>'`，前端经 webui-server 聚合调该服务的 `listModels()`（`llm` 走 per-model entry 枚举）。
- **密钥字段**：`secret: true` 的字段，宿主提供密钥存储时 `GET /api/plugins` 回的是配置文档里的引用 `{ $secret: '<键>' }`，不回原值（没有密钥存储的自组装宿主，文档里本就是明文，接口原样返回）。表单对已设置的字段显示「已设置」和键名，不显示值；输入新值即替换，不动（或输入后删空、点撤销）则原样回传引用、保持原值，点清除则清空。顶层与分组里的字段，键被几处配置共用时提示替换会一并影响它们；数组元素里的字段替换时另建新键，不影响共用者，不提示。标在 map、list 上的字段整个值算一个密钥，只写不回显，要改就整份重填。存放与写入规则见 [`docs/core/config.md`](../core/config.md#密钥配置) 的「密钥配置」一节。

## 6. 能力 / 风险 → 影响

### 鉴权：所有需登录 REST 路由 = owner-only

单 owner 终态下「持 token ⟺ `webui:console` ⟺ owner」。`createRouteGate`（`packages/plugin-webui-server/src/gate.ts`）只做身份解析：解析得到放行，否则 403。多账户 / 能力委托已剥离，**没有 per-route 档位裁决**。

- 数据源与处理函数只有 owner 能调用，由 webui-server 的闸门保证，收到的 `ctx.caller` 即 owner 身份，处理函数不另核调用者；在线用户能进 WebUI 时，契约会另给按调用者身份裁剪的办法。`write` 与 `destructive` 的动作每次调用 webui-server 记一行 info 日志。
- 工具的 owner 审批经 `/session` 连接（会话协议的 `approval/*`）送达与应答，webui-server 登记 `webui` 审批面；指令的意图确认是同一会话里的一问一答，不经 webui-server。鉴权双轴见 `docs/plugins/plugin-authority.md`、`docs/concepts/security-model.md`。

### SSRF：图片代理走 safeFetch

`/api/proxy/image` 用 `@aalis/util-network-guard` 的 `safeFetch`（`packages/plugin-webui-server/src/routes/proxy.ts`）。该函数**逐跳 `redirect:'manual'` + 每跳重新校验协议与 host**，并强制 `content-type: image/*`、20MB 上限、15s 超时、`x-content-type-options: nosniff` + `content-security-policy: sandbox`。任何 egress 都应走 `safeFetch`，别直接 `fetch` 用户给的 URL。

### 跨会话隔离

会话的条目只推给订阅了这个会话的 `/session` 连接（见 [api-session-protocol](../api/api-session-protocol.md)）。`/admin` 的事件不按会话分：日志推给订阅了的连接，其余推给全部连接；日志里可能带会话内容。

## 7. 注意事项与边界情形

- **页面表是 webui-server 实例内存态**：webui-server 被替换或重载会清空页面与提示的登记表；这正是绑定门面用 `registrar` 自动重挂的原因。owner 的布局记录（固定的页面、会话面板的标签）存在插件数据里，不随之丢失。

## 8. 交叉链接

- 概念：[`docs/concepts/service-model.md`](../concepts/service-model.md)、[`docs/concepts/lazy-service-access.md`](../concepts/lazy-service-access.md)、[`docs/concepts/manifest-metadata.md`](../concepts/manifest-metadata.md)、[`docs/concepts/security-model.md`](../concepts/security-model.md)、[`docs/concepts/storage-uri-grammar.md`](../concepts/storage-uri-grammar.md)。
- 核心：[`docs/plugins/plugin-authority.md`](../plugins/plugin-authority.md)、[`docs/core/service.md`](../core/service.md)、[`docs/core/context.md`](../core/context.md)、[`docs/core/config.md`](../core/config.md)、[`docs/core/plugin.md`](../core/plugin.md)。
- 相关服务：[`docs/services/platform.md`](./platform.md)、[`docs/services/gateway.md`](./gateway.md)、[`docs/services/storage.md`](./storage.md)、[`docs/services/llm.md`](./llm.md)、[`docs/services/embedding.md`](./embedding.md)。
