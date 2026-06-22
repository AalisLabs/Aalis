# webui 服务（Web 管理后台 / 前端托管）

## 1. 定位

WebUI 是 Aalis 的 **Web 管理后台**：启动一个 HTTP 服务器，提供 REST API（插件管理 / 配置 / 权限 / 文件 / 市场）+ WebSocket（消息流、日志推送、受限操作确认），并托管前端静态文件。第三方插件通过它**注册侧边栏页面 / 声明式面板 / 配置表单**，也可整体替换前端或替换整个服务实现。

注意服务注册名（DI key）有**两个**，不是 brief 里的裸 `'webui'`：

- `'webui-server'` —— 后端服务，契约 `WebUIService`。`ctx.getService<WebUIService>('webui-server')`，或经 helper `useWebuiService(ctx)`（见 `packages/plugin-webui-api/src/index.ts:237-247`）。
- `'webui-client'` —— 前端「忒修斯之船」provider，契约 `WebuiClientProvider`。一个目录 + 一个 `getClientDir()`，由 webui-server 自动发现并挂载（见 `packages/plugin-webui-api/src/index.ts:328-333`、`packages/plugin-webui-server/src/index.ts:1486-1487`）。

契约包：`@aalis/plugin-webui-api`（`packages/plugin-webui-api/src/index.ts`），**MIT**。它既导出 runtime 服务契约（两个 interface），也导出大量**纯类型**（声明式页面组件 `WebuiComponent`、页面骨架 `WebuiPage`）和**通过 declaration merging 向 core 注入的字段**（`PluginModule.actions/subsystem/extends`、`SchemaField.secret/dynamicOptions/allowCustom`）。

参考实现 `@aalis/plugin-webui-server` 与前端 `@aalis/plugin-webui-client` 均为 **AGPL-3.0-only**（与契约包许可不同，见第 6 节 AGPL 说明）。

> 关键认知：`webui-api` 大半是**契约 + 类型 + 一个 helper**。真正要 `ctx.provide(...)` 的只有 `webui-server` / `webui-client` 两个服务；`WebuiPage` 不是静态 module 字段，而是运行时经 `useWebuiService(ctx).registerPage()` 注册（`packages/plugin-webui-api/src/index.ts:179-181`）。

## 2. 契约

### 后端服务 `WebUIService`（`packages/plugin-webui-api/src/index.ts:19-35`）

```ts
export interface WebUIService {
  getPort(): number;                                                  // :21
  getHost(): string;                                                  // :23
  setClientDir?(dir: string): void;                                   // :28 可选——运行时替换前端目录
  registerPage(page: WebuiPage, pluginName: string): () => void;      // :30 返回 dispose
  getPages(): Array<WebuiPage & { pluginName: string }>;              // :32 含插件归属
  unregisterByPlugin(pluginName: string): void;                       // :34 插件卸载时批量清
}
```

### 前端 provider `WebuiClientProvider`（`packages/plugin-webui-api/src/index.ts:328-333`）

```ts
export interface WebuiClientProvider {
  getClientDir(): string;   // :330 返回含 index.html 的静态目录绝对路径
  label?: string;           // :332 多前端切换时的展示名
}
```

### 页面骨架 `WebuiPage`（`packages/plugin-webui-api/src/index.ts:160-173`）

```ts
export interface WebuiPage {
  key: string;                 // :162 唯一标识，对应前端路由/tab key
  label: string;               // :164 显示名
  icon?: string;               // :166 命名标识 或 内联 SVG（见第 6 节 XSS 坑）
  order?: number;              // :168 排序权重，默认 99
  renderer?: string;           // :170 自定义渲染器标识（非声明式 content 场景）
  content?: WebuiComponent[];  // :172 声明式页面内容；不提供则用客户端内置页面
}
```

### 声明式组件 `WebuiComponent`（`packages/plugin-webui-api/src/index.ts:145-153`）

8 种联合：`stat` / `table` / `form` / `actions` / `info` / `markdown` / `tabs` / `graph`。每种组件的 `source` 字段都是一个**字符串方法名**，前端按它调 `POST /api/page-action/:plugin/:method`（见第 5 节）取数据。

- `WebuiFormComponent`（`:69-75`）复用 core 的 `ConfigSchema`，`save` 是回写方法名。
- `WebuiTableComponent`（`:48-66`）支持 `columns/actions/refresh/searchable`。
- `WebuiGraphComponent`（`:121-142`）基于 Cytoscape，非关系图场景**必须**声明 `nodeKinds/edgeKinds`，否则冒用人物关系图内置三类图例。

### declaration merging 注入 core（`packages/plugin-webui-api/src/index.ts:182-216`）

```ts
declare module '@aalis/core' {
  interface PluginModule {
    subsystem?: string;                                              // :190 仅 WebUI 分组展示，core 不读
    extends?: ExtendDeclaration;                                     // :191 声明扩展事件/钩子，仅展示
    actions?: Record<string,
      (ctx: Context, args: Record<string, unknown>,
       caller?: UserIdentity) => Promise<unknown>>;                  // :201 RPC 动作表，host 路由调用
  }
  interface SchemaField {
    secret?: boolean;          // :210 敏感字段，前端遮蔽显示
    dynamicOptions?: string;   // :212 select/multiselect 动态选项来源服务名（前端调该服务 listModels()）
    allowCustom?: boolean;     // :214 multiselect 允许手动输入自定义值
  }
}
```

> `actions` 是 WebUI 体系的真正业务入口：core 完全不感知此字段，由 host（webui-server）路由层 `POST /api/page-action/:plugin/:method` 在权限闸放行后，以**插件自身的 `entry.context`** 调用 handler，并把解析出的 `caller` 身份作为第三参传入（`packages/plugin-webui-server/src/routes/plugins.ts:106-151`）。

### helper `useWebuiService` 与 `ScopedWebuiService`（`packages/plugin-webui-api/src/index.ts:223-247`）

```ts
export function useWebuiService(ctx: Context): ScopedWebuiService {
  const pluginName = ctx.id || 'unknown';
  return {
    registerPage(page) {
      // 委托 ctx.whenService('webui-server', ...)：每次 webui-server 重新 provide
      // （bounce/replace）都会重新 registerPage，让页面自动重挂；旧 cleanup 在 provider 下线时释放。
      return ctx.whenService<WebUIService>('webui-server', svc => svc.registerPage(page, pluginName));
    },
    get raw() { return ctx.getService<WebUIService>('webui-server'); },
  };
}
```

### 其它导出（纯类型 / 数据）

- `ExtendDeclaration`（`:260-267`）：`events/hooks/mixins` 元数据。
- `SubsystemMetadata` + `DEFAULT_SUBSYSTEM_METADATA`（`:286-319`）：子系统展示目录（中文 label / 排序），唯一消费者是 webui-server 的 `/api/service-groups`；未命中表时前端回退「id 原样展示，order=9999」。

## 3. 谁提供 / 谁消费

**提供方**

- `@aalis/plugin-webui-server` —— 唯一参考实现。`provides = ['webui-server', 'platform']`（`packages/plugin-webui-server/src/index.ts:54`），服务实例在 `:1587-1616` 构造并 `ctx.provide('webui-server', webuiService)`。它同时是一个 `platform` adapter（WebUI 当聊天界面，`:1541-1575`）。
- `@aalis/plugin-webui-client` —— 默认前端（React SPA）。**不是被加载的插件**，而是带 `aalis.client: true` 标记 + `dist/index.html` 的纯静态包，被 webui-server 在 `ready` 时自动发现并注册成 `webui-client` 的一个 provider（`packages/plugin-webui-server/src/index.ts:1453-1498`）。`@aalis/plugin-webui-client-example` 是替换前端的最小示例。

**消费方**（全部经 `useWebuiService(ctx).registerPage(...)` 注册侧边栏页面）：

| 插件 | 注册点 |
| --- | --- |
| `plugin-authority` | `packages/plugin-authority/src/index.ts:40` |
| `plugin-doctor` | `packages/plugin-doctor/src/index.ts:157-158` |
| `plugin-scheduler` | `packages/plugin-scheduler/src/index.ts:374` |
| `plugin-session-manager` | `packages/plugin-session-manager/src/index.ts:944` |
| `plugin-skills` | `packages/plugin-skills/src/index.ts:385` |
| `plugin-tool-browser` | `packages/plugin-tool-browser/src/index.ts:139` |
| `plugin-user-relation` | `packages/plugin-user-relation/src/index.ts:597`（用 `graph` 组件画关系图） |
| `plugin-workflow` | `packages/plugin-workflow/src/index.ts:511` |

脚手架 `create-aalis-plugin` 在勾选 webui 特性时也生成 `useWebuiService(ctx)` 调用（`packages/create-aalis-plugin/src/cli.ts:238,267`）。

> webui-server 内部读取页面用 `ctx.getService<WebUIService>('webui-server').getPages()`（`packages/plugin-webui-server/src/routes/plugins.ts:88`）——即「自己取自己」，因为页面注册在服务实例的内存 Map 里。

## 4. 写一个 provider

绝大多数第三方作者**不替换 webui-server**，只是**注册页面 / 声明 actions**。下面分两类。

### 4a. 消费 WebUI：注册一个声明式页面（最常见）

最小骨架（可编译，省略 import 细节）：

```ts
import type { Context } from '@aalis/core';
import { useWebuiService, type WebuiPage } from '@aalis/plugin-webui-api';

// 子系统归属（可选，仅分组展示）；任意字符串都行，命中 DEFAULT_SUBSYSTEM_METADATA 用其中文 label
export const subsystem = 'tools';

// RPC 动作表：声明式组件的 source/save/method 都指向这里的 key
export const actions = {
  // 第三参 caller 是 webui-server 路由层解析出的调用者；忽略即向后兼容
  async stats(_ctx: Context, _args: Record<string, unknown>) {
    return { total: 42 };
  },
  async refresh(_ctx: Context, args: Record<string, unknown>) {
    return { ok: true, echo: args };
  },
};

const page: WebuiPage = {
  key: 'my-plugin',
  label: '我的插件',
  icon: 'tools',            // 用命名标识，别塞不可信内联 SVG（见第 6 节）
  order: 80,
  content: [
    { type: 'stat', label: '条目数', source: 'stats' },
    { type: 'actions', label: '操作', items: [{ label: '刷新', method: 'refresh' }] },
  ],
};

export function apply(ctx: Context): void {
  // 不要缓存返回值；whenService 已处理 provider bounce 后的自动重挂
  useWebuiService(ctx).registerPage(page);
}
```

**manifest 双源**：`actions/subsystem` 经 declaration merging 注入，无需在 `package.json aalis.service` 里声明。但既然你 `import` 了 `@aalis/plugin-webui-api` 的 helper，运行时其实只依赖 `webui-server` 服务的存在——`useWebuiService` 内部用 `whenService`，**webui-server 缺失时静默不挂、就绪后自动补挂**，所以你**不必**把 `webui-server` 写进 `inject`。若你确实想声明可选依赖，保持 `export const inject` 与 `package.json aalis.service` 两处一致（见 `docs/concepts/manifest-metadata.md`）。

### 4b. 替换前端（`webui-client`）

两条接入（`packages/plugin-webui-api/src/index.ts:321-333`）：

- **纯静态包**：`package.json` 标 `aalis.client: true` + 提供 `dist/index.html`，被 webui-server 自动发现挂载，**无需 `apply`**（runtime 不把它当插件加载）。多前端共存时各成一个 `webui-client` provider，活跃者由「服务偏好」`servicePreferences['webui-client']` 在 WebUI「服务」页切换；卡住可访问 `/__clients` 逃生页切回（`packages/plugin-webui-server/src/index.ts:1434-1440`）。
- **主动覆盖**：插件 `apply` 里 `ctx.provide('webui-client', { getClientDir: () => myDir, label: '我的前端' })`。注册更早 → 默认胜出，仍可被偏好切换。

### 4c. 替换整个后端（`webui-server`）

罕见。核心要求此服务必须运行（`packages/plugin-webui-api/src/index.ts:16`）。实现全部 `WebUIService` 必须方法（`registerPage` 必须真正维护页面表，否则所有插件页面丢失），用 `ServicePriority`（Override50 / System200）或服务偏好压过默认实现。注册：`ctx.provide('webui-server', impl)`，并在 `package.json aalis.service.provides` 与 `export const provides` 双源写 `'webui-server'`（参考 `packages/plugin-webui-server/package.json` 的 `aalis.service` 块）。同名服务胜出规则见 `docs/concepts/service-model.md`：偏好 > priority > 注册顺序。

## 5. 标准消费姿势

- **lazy 取用**：始终经 `useWebuiService(ctx)` 而非缓存 `getService` 结果。webui-server 在存储插件 bounce 时**不会**级联重启（它把 `storage/authority/...` 都标成 `optional`，`packages/plugin-webui-server/src/index.ts:55-61`），但它自身仍可能被替换/重挂；`whenService` 保证页面自动重挂。见 `docs/concepts/lazy-service-access.md`。
- **服务缺失 / 可选依赖**：`raw` getter 在 webui-server 未就绪时返回 `undefined`；不要假定它一定在。注册页面用 `registerPage` 即可——它内部用 `whenService`，webui 没装也不报错，只是页面不显示。
- **错误边界**：`actions` handler 抛错会被路由层 catch 成 `500 {error}`（`packages/plugin-webui-server/src/routes/plugins.ts:147-150`），前端展示错误。handler 内别吞致命异常但要给出可读 message。
- **动态选项**：表单字段标 `dynamicOptions: '<serviceName>'`，前端经 webui-server `/api/.../models` 路由聚合调该服务的 `listModels()`（`packages/plugin-webui-server/src/index.ts:904-924`；`llm` 走 per-model entry 枚举，embedding 等仍走 `listModels()`）。前端消费见 `packages/plugin-webui-client/src/components/SchemaForm.tsx:293-372`。

## 6. 能力 / 风险 → 影响

### 鉴权：所有需登录 REST 路由 = owner-only

单 owner 终态下「持 token ⟺ `webui:console` ⟺ owner」。`createRouteGate`（`packages/plugin-webui-server/src/gate.ts:28-36`）只做身份解析：解析得到放行，否则 403。多账户 / 能力委托已剥离，**没有 per-route 档位裁决**。

- 你的 `actions` handler 拿到的 `caller` 即 owner 身份（`packages/plugin-webui-server/src/routes/plugins.ts:138-145`）。涉及敏感操作（如改他人档位）时应在 handler 内自检 `caller`，不要假设路由层替你做了细粒度授权。
- 受限操作的**交互式确认**走 `session-confirm` 协调器：webui-server 只注入自己的 WS 投递（`type:'confirm'`），按 `request.sessionId` 定向推送（`packages/plugin-webui-server/src/index.ts:952-963`）。鉴权双轴（level + confirm）见 `docs/core/authority.md`、`docs/concepts/security-model.md`。

### SSRF：图片代理走 safeFetch

`/api/proxy/image` 用 `@aalis/util-network-guard` 的 `safeFetch`（`packages/plugin-webui-server/src/routes/proxy.ts:31`）。该函数**逐跳 `redirect:'manual'` + 每跳重新校验协议与 host**（`packages/util-network-guard/src/index.ts:159,166-170`），并强制 `content-type: image/*`、20MB 上限、15s 超时、`x-content-type-options: nosniff` + `content-security-policy: sandbox`（防 `image/svg+xml` 反射型 XSS）。任何 egress 都应走 `safeFetch`，别直接 `fetch` 用户给的 URL。详见 `docs/services/gateway.md` 与 `docs/concepts/security-model.md`。

> brief 里「image proxy 只校验初始 host」的旧审计结论已**不成立**：当前实现每跳都重校验。

### 存储不是沙盒

webui-server 的文件管理页基于 storage 根（默认 `workspace`，`fileRoot` 配置），用 `'<root>:/path'` 文法（`packages/plugin-webui-server/src/index.ts:73-80`）。storage 限定可达根但**不是沙盒**，参考实现的各文件路由都在 owner 闸之后。文法见 `docs/concepts/storage-uri-grammar.md`、`docs/services/storage.md`。

### 跨会话隔离

WS 推送按 `sessionId` 分桶（`sessions: Map<sessionId, Set<ws>>`），`subscribe_session` 注册（`packages/plugin-webui-server/src/index.ts:996-1037`）。确认消息已按 `request.sessionId` 定向（仅在该会话无 socket 时回退广播，`:957-958`）。

> brief 里「`pendingConfirm` 全局布尔忽略 sessionId」的旧审计结论已**不成立**：确认协调逻辑现已下沉到 `session-confirm` 服务并按 `request.sessionId` 路由。

## 7. 边界与坑

- **插件 icon → 内联 SVG XSS（真实存留）**：默认前端 `resolveIcon` 在 `WebuiPage.icon` 以 `<svg` 开头时，直接 `dangerouslySetInnerHTML` 渲染（`packages/plugin-webui-client/src/App.tsx:716-717`）。`icon` 来自第三方插件声明，**一个恶意市场插件可借此注入脚本**（SVG 内 `<script>` / 事件属性）。规避：你写的插件 `icon` 一律用**命名标识**（如 `'tools'`），别从不可信源透传内联 SVG；替换前端时应对 icon 做 DOMPurify 净化或拒绝内联 SVG。
- **Mermaid（已收口）**：聊天 markdown 里的 Mermaid 图用 `securityLevel: 'strict'`（启用内置 DOMPurify、禁 click/callback，`packages/plugin-webui-client/src/components/MermaidBlock.tsx:24`），随后 `dangerouslySetInnerHTML` 注入净化后的 SVG（`:107-108`）。brief 提到的 `securityLevel:'loose'` 已被改为 `strict`，不再是 XSS 入口。
- **manifest 双源轻微漂移**：`package.json aalis.service.optional` 含 `session-confirm`，而 `export const inject.optional`（`packages/plugin-webui-server/src/index.ts:60`）未列 `session-confirm`。功能上无碍（`whenService` 处理），但属双源不同步，写自己的插件时务必两处一致。
- **页面表是 webui-server 实例内存态**：webui-server 被替换/重启会清空 `registeredPages`；这正是 `useWebuiService` 用 `whenService` 自动重挂的原因——别绕过 helper 直接 `getService().registerPage()`，否则重挂逻辑丢失。
- **`renderer` 自定义渲染器**：内置 renderer（dashboard/marketplace/...）由默认前端 `App.tsx:744-753` 写死 switch。第三方插件声明 `renderer: 'xxx'` 而前端无对应 case 时 `renderCustomPage` 返回 `null`（白页）。第三方页面应优先用声明式 `content`，`renderer` 仅在你同时控制前端时使用。

## 8. 交叉链接

- 概念：[`docs/concepts/service-model.md`](../concepts/service-model.md)（DI 按名、priority/偏好胜出）、[`docs/concepts/lazy-service-access.md`](../concepts/lazy-service-access.md)（`whenService`/不缓存）、[`docs/concepts/manifest-metadata.md`](../concepts/manifest-metadata.md)（provides/inject 双源）、[`docs/concepts/security-model.md`](../concepts/security-model.md)、[`docs/concepts/storage-uri-grammar.md`](../concepts/storage-uri-grammar.md)、[`docs/concepts/message-llm-pipeline.md`](../concepts/message-llm-pipeline.md)。
- 核心：[`docs/core/authority.md`](../core/authority.md)（level + confirm 双轴、owner=∞）、[`docs/core/service.md`](../core/service.md)、[`docs/core/context.md`](../core/context.md)、[`docs/core/config.md`](../core/config.md)（`ConfigSchema` / `SchemaField`）、[`docs/core/plugin.md`](../core/plugin.md)（`PluginModule`）。
- 相关服务：[`docs/services/platform.md`](./platform.md)（webui-server 同时是 platform adapter）、[`docs/services/gateway.md`](./gateway.md)（safeFetch / SSRF）、[`docs/services/storage.md`](./storage.md)（文件管理根）、[`docs/services/llm.md`](./llm.md) 与 [`docs/services/embedding.md`](./embedding.md)（dynamicOptions 的 listModels 来源）。
