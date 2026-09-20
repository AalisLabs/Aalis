# webui 服务（Web 管理后台 / 前端托管）

## 1. 定位

WebUI 是 Aalis 的 **Web 管理后台**：启动一个 HTTP 服务器，提供 REST API（插件管理 / 配置 / 权限 / 文件 / 市场）+ WebSocket（消息流、日志推送、受限操作确认），并托管前端静态文件。第三方插件通过它**登记侧边栏页面 / 声明式面板 / 配置表单**，也可整体替换前端或替换整个服务实现。

注意服务注册名（描述符 `name`）有**两个**，而非单个 `'webui'`：

- `'webui-server'` —— 后端服务，契约 `WebUIService`。描述符 `webuiServer`，绑定接口 `BoundWebui`（`packages/api-webui/src/index.ts`）。
- `'webui-client'` —— 前端「忒修斯之船」provider，契约 `WebuiClientProvider`。描述符 `webuiClient`，绑定接口是普通 `ServiceRef`。

契约包：`@aalis/api-webui`（`packages/api-webui/src/index.ts`），**MIT**。它导出运行时服务契约、声明式页面组件类型、以及向 `PluginMeta` 注入的 `extends`、向 `@aalis/schema-config` 的 `SchemaField` 注入的 `secret/dynamicOptions/allowCustom`。

参考实现 `@aalis/plugin-webui-server` 与前端 `@aalis/plugin-webui-client` 均为 **AGPL-3.0-only**（与契约包许可不同，见第 6 节 AGPL 说明）。

页面与页面动作不是静态模块字段：在 `apply` 里经 `webui.registerPage` / `webui.registerAction` 登记，随本次激活撤回。

## 2. 契约

### 后端服务 `WebUIService`（`packages/api-webui/src/index.ts`）

```ts
export interface WebUIService {
  getPort(): number;
  getHost(): string;
  setClientDir?(dir: string): void;
  registerPage(page: WebuiPage, contextId: string): () => void;
  getPages(): Array<WebuiPage & { pluginName: string }>;
  registerAction(method: string, handler: WebuiActionHandler, contextId: string): () => void;
}

export type WebuiActionHandler = (args: Record<string, unknown>, caller?: UserIdentity) => Promise<unknown>;
```

### 绑定接口 `BoundWebui`

```ts
export interface BoundWebui extends ServiceRef<WebUIService> {
  registerPage(page: WebuiPage): () => void;
  registerAction(method: string, handler: WebuiActionHandler): () => void;
}
```

`registerPage` / `registerAction` 走 `registrar`：同键替换、提供者换人整体重挂、关闭后拒收。插件不要自己传 `contextId`。调用型查询走 `webui.current`（每次读取重新解析）。

### 前端 provider `WebuiClientProvider`

```ts
export interface WebuiClientProvider {
  getClientDir(): string;
  label?: string;
}
```

### 页面骨架 `WebuiPage`

```ts
export interface WebuiPage {
  key: string;
  label: string;
  icon?: string;
  order?: number;
  renderer?: string;
  content?: WebuiComponent[];
}
```

### 声明式组件 `WebuiComponent`

8 种联合：`stat` / `table` / `form` / `actions` / `info` / `markdown` / `tabs` / `graph`。每种组件的 `source` 字段都是一个**字符串方法名**，前端按它调 `POST /api/page-action/:plugin/:method`（见第 5 节）取数据。

- `WebuiFormComponent` 复用 `@aalis/schema-config` 的 `ConfigSchema`，`save` 是回写方法名。
- `WebuiTableComponent` 支持 `columns/actions/refresh/searchable`。
- `WebuiGraphComponent` 基于 Cytoscape，非关系图场景**必须**声明 `nodeKinds/edgeKinds`，否则冒用人物关系图内置三类图例。

`POST /api/page-action/:plugin/:method` 在身份闸放行后调用已登记的 handler，并把 `caller` 作为第二参传入（`packages/plugin-webui-server/src/routes/plugins.ts`）。单 owner 终态下该路由要求 owner 身份。

action 的业务失败**返回** `{ ok: false, error: '原因' }`，HTTP 仍是 200——路由只把 handler 的抛错转成 5xx；前端 form / actions / table 三种组件都据此显示原因，返回其它任何值（含 `undefined`）视为成功；table 的非 danger / confirm 操作若返回不带 `ok` 的普通对象，会被当作详情弹窗内容展示，只想刷新表格就返回 `undefined` 或 `{ ok: true }`。

### SchemaField 注入

```ts
declare module '@aalis/schema-config' {
  interface SchemaField {
    secret?: boolean;
    dynamicOptions?: string;
    allowCustom?: boolean;
  }
}
```

`subsystem` 写在 `definePlugin({ subsystem })`（`PluginDefinition` 字段，core 不读）。`extends` 经本包 declaration merging 挂到 `PluginMeta`。

## 3. 谁提供 / 谁消费

**提供方**

- `@aalis/plugin-webui-server` —— 参考实现。`provides: [webuiServer, platform]`（`packages/plugin-webui-server/src/index.ts`），`provide(webuiServer, impl)`。它同时是一个 `platform` adapter（WebUI 当聊天界面）。`sessionConfirm` 等为 optional。
- `@aalis/plugin-webui-client` —— 默认前端（React SPA）。**不是被加载的插件**，而是带 `aalis.client: true` 标记 + `dist/index.html` 的纯静态包，被 webui-server 在 `app:ready` 时自动发现并登记成 `webui-client` 的一个 provider（可用 `onBehalfOf` 让偏好认前端包名；代登记不计入代理人 `provides`）。

**消费方**（经 `webui.registerPage` / `registerAction`）：

| 插件 | 注册点 |
| --- | --- |
| `plugin-authority` | `packages/plugin-authority/src/index.ts` |
| `plugin-doctor` | `packages/plugin-doctor/src/index.ts` |
| `plugin-scheduler` | `packages/plugin-scheduler/src/index.ts` |
| `plugin-session-manager` | `packages/plugin-session-manager/src/index.ts` |
| `plugin-skills` | `packages/plugin-skills/src/index.ts` |
| `plugin-tool-browser` | `packages/plugin-tool-browser/src/index.ts` |
| `plugin-user-relation` | `packages/plugin-user-relation/src/index.ts`（用 `graph` 组件画关系图） |
| `plugin-workflow` | `packages/plugin-workflow/src/index.ts` |
| `plugin-todo-list` | `packages/plugin-todo-list/src/index.ts` |

webui-server 内部读页面用当前服务实例上的 `getPages()`——页面登记在该实例的内存 Map 里。

## 4. 写一个 provider

绝大多数第三方作者**不替换 webui-server**，只是**登记页面与页面动作**。

### 4a. 消费 WebUI：登记一个声明式页面（最常见）

```ts
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
import { definePlugin, optional } from '@aalis/core';

const page: WebuiPage = {
  key: 'my-plugin',
  label: '我的插件',
  icon: 'tools',
  order: 80,
  content: [
    { type: 'stat', label: '条目数', source: 'stats' },
    { type: 'actions', label: '操作', items: [{ label: '刷新', method: 'refresh' }] },
  ],
};

export default definePlugin({
  name: '@acme/plugin-my-webui',
  subsystem: 'tools',
  uses: { webui: optional(webuiServer) },
  apply({ webui }) {
    webui.registerPage(page);
    webui.registerAction('stats', async () => ({ total: 42 }));
    webui.registerAction('refresh', async args => ({ ok: true, echo: args }));
  },
});
```

`webui-server` 缺失时登记排队、就绪后挂上，页面不显示。不必把 `webuiServer` 标成 required，除非还要读 `getPort` / `getPages`。

不要把 `webui.current` 存进字段：提供者换人后旧引用失效（有失效逻辑则抛，无则静默成功）；关停边不保护缓存引用。登记门面本身会随提供者换人重挂。

### 4b. 替换前端（`webui-client`）

- **纯静态包**：`package.json` 标 `aalis.client: true` + 提供 `dist/index.html`，被 webui-server 自动发现挂载，**无需 `apply`**。多前端共存时各成一个 `webui-client` provider，活跃者由「服务偏好」在 WebUI「服务」页切换；卡住可访问 `/__clients` 逃生页切回。
- **主动覆盖**：插件 `apply` 里 `provide(webuiClient, { getClientDir: () => myDir, label: '我的前端' })`。`onBehalfOf` 代登记归属被代者，不计入代理人 `provides`。

### 4c. 替换整个后端（`webui-server`）

罕见。核心要求此服务必须运行。实现全部 `WebUIService` 必须方法（`registerPage` / `registerAction` 必须真正维护表），用更高的 priority 或 `services.prefer` 压过默认实现。`definePlugin({ provides: [webuiServer], uses: { provide }, apply({ provide }) { provide(webuiServer, impl); } })`。同名胜出规则见 `docs/concepts/service-model.md`：偏好 > priority > 注册顺序。

## 5. 标准消费方式

- **登记**：始终经 `BoundWebui.registerPage` / `registerAction`，不要绕过门面直接调 `WebUIService.registerPage(..., contextId)`——否则提供者换人时不会自动重挂，激活撤回也不会按条目退订。
- **服务缺失**：`webui.current` 在未就绪时为 `undefined`。登记用门面即可。
- **错误边界**：action handler 抛错会被路由层 catch 成 `500 {error}`，前端展示错误。
- **动态选项**：表单字段标 `dynamicOptions: '<serviceName>'`，前端经 webui-server 聚合调该服务的 `listModels()`（`llm` 走 per-model entry 枚举）。

## 6. 能力 / 风险 → 影响

### 鉴权：所有需登录 REST 路由 = owner-only

单 owner 终态下「持 token ⟺ `webui:console` ⟺ owner」。`createRouteGate`（`packages/plugin-webui-server/src/gate.ts`）只做身份解析：解析得到放行，否则 403。多账户 / 能力委托已剥离，**没有 per-route 档位裁决**。

- 你的 action handler 拿到的 `caller` 即 owner 身份。涉及敏感操作时应在 handler 内自检 `caller`，不要假设路由层替你做了细粒度授权。
- 受限操作的**交互式确认**走 `session-confirm` 协调器：webui-server 只注入自己的 WS 投递（`type:'confirm'`），按 `request.sessionId` 定向推送。鉴权双轴见 `docs/plugins/plugin-authority.md`、`docs/concepts/security-model.md`。

### SSRF：图片代理走 safeFetch

`/api/proxy/image` 用 `@aalis/util-network-guard` 的 `safeFetch`（`packages/plugin-webui-server/src/routes/proxy.ts`）。该函数**逐跳 `redirect:'manual'` + 每跳重新校验协议与 host**，并强制 `content-type: image/*`、20MB 上限、15s 超时、`x-content-type-options: nosniff` + `content-security-policy: sandbox`。任何 egress 都应走 `safeFetch`，别直接 `fetch` 用户给的 URL。

### 存储不是沙盒

webui-server 的文件管理页基于 storage 根（默认 `workspace`，`fileRoot` 配置），用 `'<root>:/path'` 文法。storage 限定可达根但**不是沙盒**。文法见 `docs/concepts/storage-uri-grammar.md`、`docs/services/storage.md`。

### 跨会话隔离

WS 推送按 `sessionId` 分桶，`subscribe_session` 注册。确认消息按 `request.sessionId` 定向（仅在该会话无 socket 时回退广播）。

## 7. 注意事项与边界情形

- **插件 icon → 内联 SVG XSS（真实存留）**：默认前端 `resolveIcon` 在 `WebuiPage.icon` 以 `<svg` 开头时，直接 `dangerouslySetInnerHTML` 渲染（`packages/plugin-webui-client/src/App.tsx`）。`icon` 来自第三方插件声明，**一个恶意市场插件可借此注入脚本**。规避：你写的插件 `icon` 一律用**命名标识**（如 `'tools'`），别从不可信源透传内联 SVG。
- **Mermaid**：聊天 markdown 里的 Mermaid 图用 `securityLevel: 'strict'`（`packages/plugin-webui-client/src/components/MermaidBlock.tsx`）。
- **页面表是 webui-server 实例内存态**：webui-server 被替换会清空 `registeredPages`；这正是绑定门面用 `registrar` 自动重挂的原因。
- **`renderer` 自定义渲染器**：内置 renderer 由默认前端写死 switch。第三方页面应优先用声明式 `content`。

## 8. 交叉链接

- 概念：[`docs/concepts/service-model.md`](../concepts/service-model.md)、[`docs/concepts/lazy-service-access.md`](../concepts/lazy-service-access.md)、[`docs/concepts/manifest-metadata.md`](../concepts/manifest-metadata.md)、[`docs/concepts/security-model.md`](../concepts/security-model.md)、[`docs/concepts/storage-uri-grammar.md`](../concepts/storage-uri-grammar.md)。
- 核心：[`docs/plugins/plugin-authority.md`](../plugins/plugin-authority.md)、[`docs/core/service.md`](../core/service.md)、[`docs/core/context.md`](../core/context.md)、[`docs/core/config.md`](../core/config.md)、[`docs/core/plugin.md`](../core/plugin.md)。
- 相关服务：[`docs/services/platform.md`](./platform.md)、[`docs/services/gateway.md`](./gateway.md)、[`docs/services/storage.md`](./storage.md)、[`docs/services/llm.md`](./llm.md)、[`docs/services/embedding.md`](./embedding.md)。
