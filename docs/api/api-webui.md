# api-webui — WebUI 服务与声明式页面组件契约

**包名**: `@aalis/api-webui`  
**源码**: `packages/api-webui/src/index.ts`  
**实现**: `@aalis/plugin-webui-server`（+ `@aalis/plugin-webui-client` 提供前端）

## 概述

定义 WebUI 后台服务接口、声明式页面组件 schema、按激活绑定的登记门面。插件不需要懂 HTTP/React，只需在 `apply` 里 `uses` 声明 `webuiServer`，调用 `webui.registerPage` / `webui.registerAction`。webui-server 负责渲染并暴露 REST + WebSocket。页面动作随本次激活撤回；同名动作为替换。

`GET /api/plugins` 的 `uses` 是插件 `uses` 声明的完整快照，每项为 `{ key, service, kind }`，`key` 保留 `apply` 参数名；插件页展开后按 `kind` 标为「必需」或「可选」。core 内置服务（`events` / `lifecycle` / `logger` / `config` / `provide` / `services`）和宿主服务（`app` / `plugins` / `host-config` 等）由根激活登记，与第三方服务一样是普通提供者：`/api/services` 里以「宿主」为提供者列出；插件声明了它们同样要经过激活闸，只是这些服务在加载插件前已就绪。`requiredServices` / `optionalServices` 是 `uses` 按是否包 `optional()` 拆出的服务名，包含 core 内置服务。`capabilities` 是工具和指令的敏感可见性标记。经 `services` 动态查询获得的服务不在声明列表中。

## 服务接口

```ts
interface WebUIService {
  getPort(): number;
  getHost(): string;
  setClientDir?(dir: string): void;
  registerPage(page: WebuiPage, contextId: string): () => void;
  getPages(): Array<WebuiPage & { pluginName: string }>;
  registerAction(method: string, handler: WebuiActionHandler, contextId: string): () => void;
}

type WebuiActionHandler = (args: Record<string, unknown>, caller?: UserIdentity) => Promise<unknown>;
```

插件侧走绑定门面，不要自己传 `contextId`。

## 绑定接口

```ts
interface BoundWebui extends ServiceRef<WebUIService> {
  registerPage(page: WebuiPage): () => void;
  registerAction(method: string, handler: WebuiActionHandler): () => void;
}
```

`webuiServer` 的 `registerPage` / `registerAction` 走 `registrar`：同键替换、提供者换人整体重挂、关闭后拒收。调用型查询（`getPort` / `getPages`）走 `current` / `require()`。

另有调用型描述符 `webuiClient`（`WebuiClientProvider`），绑定接口是普通 `ServiceRef`。

## 展示元数据（declaration merging）

本包向 `PluginMeta` 注入 `extends?: ExtendDeclaration`（core 不读，仅 WebUI 展示）。`subsystem` 是 `PluginDefinition` 上的展示字段，写在 `definePlugin({ subsystem })`。

向 `@aalis/schema-config` 的 `SchemaField` 注入 `secret` / `dynamicOptions` / `allowCustom`。

页面与页面动作**不是**静态模块字段：在 `apply` 里经 `webui.registerPage` / `webui.registerAction` 登记。

`POST /api/page-action/:plugin/:method` 在身份闸放行后调用已登记的 handler，并把 `caller` 作为第二参传入（`packages/plugin-webui-server/src/routes/plugins.ts`）。单 owner 终态下该路由要求 owner 身份。

action 的业务失败**返回** `{ ok: false, error: '原因' }`，HTTP 仍是 200——路由只把 handler 的抛错转成 5xx；前端 form / actions / table 三种组件都据此显示原因，返回其它任何值（含 `undefined`）视为成功；table 的非 danger / confirm 操作若返回不带 `ok` 的普通对象，会被当作详情弹窗内容展示，只想刷新表格就返回 `undefined` 或 `{ ok: true }`。

## 页面登记

```ts
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
import { definePlugin, optional } from '@aalis/core';

const page: WebuiPage = {
  key: 'shell',
  label: 'Shell',
  content: [{ type: 'stat', label: '条目数', source: 'stats' }],
};

export default definePlugin({
  name: '@acme/plugin-example-webui',
  subsystem: 'tools',
  uses: { webui: optional(webuiServer) },
  apply({ webui }) {
    webui.registerPage(page);
    webui.registerAction('stats', async () => ({ total: 42 }));
  },
});
```

`webui-server` 未就绪时登记排队，就绪后挂上，缺失时页面不显示。不必把 `webuiServer` 标成 required，除非还要读 `getPort` / `getPages`。

## 声明式页面组件

```ts
type WebuiComponent =
  | WebuiStatComponent
  | WebuiTableComponent
  | WebuiFormComponent
  | WebuiActionsComponent
  | WebuiInfoComponent
  | WebuiMarkdownComponent
  | WebuiTabsComponent
  | WebuiGraphComponent;
```

每种组件都有：

- `source` —— 拉数据的 action 方法名（不是 HTTP 路径；前端调 `POST /api/page-action/:plugin/:method`）
- `save` / `method` —— 提交动作的 action 方法名，同上
- `confirm` —— 行内/按钮确认提示
- `danger` —— 红色样式标记

### 示例：表格 + 操作

```ts
{
  type: 'table',
  label: '后台进程',
  source: 'listProcesses',
  columns: [
    { key: 'pid', label: 'PID' },
    { key: 'cmd', label: '命令' },
    { key: 'startedAt', label: '启动时间', render: 'date' },
  ],
  actions: [
    { label: '终止', method: 'killProcess', confirm: '确定？', danger: true },
  ],
  refresh: 5,
}
```

### 示例：表单复用 ConfigSchema

```ts
{
  type: 'form',
  label: '基础配置',
  source: 'getConfig',
  save: 'saveConfig',
  schema: configSchema,
}
```

## WebuiPage 完整结构

```ts
interface WebuiPage {
  key: string;
  label: string;
  icon?: string;
  order?: number;
  renderer?: string;
  content?: WebuiComponent[];
}
```

## 前端提供者

`WebuiClientProvider`：`getClientDir()` 返回含 `index.html` 的静态目录。两条接入：

- **纯静态包**：`package.json` 标 `aalis.client: true` + 含 `dist/index.html`，被 webui-server 自动发现挂载（无需 `apply`）。
- **主动覆盖**：插件 `apply` 里 `provide(webuiClient, impl)`。`onBehalfOf` 代登记归属被代者身份，不计入代理人 `provides`。

## 实现者

- [@aalis/plugin-webui-server](../plugins/plugin-webui-server.md) — 后端服务 + 静态文件托管
- `@aalis/plugin-webui-client` — 前端 React 应用（独立发布）

## 相关

- ConfigSchema 来自 `@aalis/schema-config`（本包经 declaration merging 向其 `SchemaField` 注入 `secret` / `dynamicOptions` / `allowCustom` 等表单属性）
- 事件 `'tool:execute'` 与 `'token:usage'` 都被 webui-server 转 WebSocket 推送给前端
