# plugin-webui-api — WebUI 服务与声明式页面组件契约

**包名**: `@aalis/plugin-webui-api`  
**源码**: `packages/plugin-webui-api/src/index.ts`  
**实现**: `@aalis/plugin-webui-server`（+ `@aalis/plugin-webui-client` 提供前端）

## 概述

定义 WebUI 后台服务接口、声明式页面组件 schema、页面注册 helper。插件不需要懂 HTTP/React，只需在 `apply(ctx)` 中调用 `useWebuiService(ctx).registerPage(page)`，由 webui-server 自动渲染并暴露 REST + WebSocket。

## 服务接口

```ts
interface WebUIService {
  getPort(): number;
  getHost(): string;
  setClientDir?(dir: string): void;      // 允许替换前端
  // 页面注册（一般通过 `useWebuiService(ctx)` helper 间接调用）
  registerPage(page: WebuiPage, pluginName: string): () => void;
  getPages(): Array<WebuiPage & { pluginName: string }>;
  unregisterByPlugin(pluginName: string): void;
}
```

## PluginModule 注入槽位（declaration merging）

本包向 core 的 `PluginModule` 合并注入以下字段（core 不读取，仅 webui 消费）：

- `subsystem?: string` / `extends?: ExtendDeclaration` —— 纯展示元数据；
- `actions?: Record<string, (ctx, args, caller?: UserIdentity) => Promise<unknown>>` ——
  插件 RPC 动作表，webui-server 经 `POST /api/page-action/:plugin/:method` 调起。
  第三参 caller 为权限闸放行后的调用者身份（登录账户或单 token 模式的
  `webui:console`），handler 可用它做业务级检查；忽略即向后兼容；
- `actionsMeta?: Record<string, { authority?: number }>` —— action 所需最低权限等级。
  **未声明的 action 默认要求 owner（默认拒绝）**；闸的 capability 形状为
  `action:<plugin>:<method>`，支持 per-user grant/deny（见 plugin-authority-api）。

```ts
export const actions: PluginModule['actions'] = {
  async getStats(ctx) { /* ... */ },
};
export const actionsMeta = { getStats: { authority: 1 } }; // 显式降门槛才对低等级开放
```

## 页面注册 helper

```ts
import { useWebuiService } from '@aalis/plugin-webui-api';

export function apply(ctx: Context) {
  const webui = useWebuiService(ctx);
  webui.registerPage({ key: 'shell', label: 'Shell', content: [/* ... */] });
}
```

helper 内部先 `ctx.getService('webui-server')` 取服务；未就绪时自动 `whenService` 延迟。`registerPage` 返回 disposer，插件 `ctx.dispose()` 时自动取消注册。

## 声明式页面组件

```ts
type WebuiComponent =
  | WebuiStatComponent       // 数字统计卡
  | WebuiTableComponent      // 表格 + 行内操作
  | WebuiFormComponent       // 配置表单（复用 ConfigSchema）
  | WebuiActionsComponent    // 按钮组
  | WebuiInfoComponent       // 键值面板
  | WebuiMarkdownComponent   // Markdown 内容
  | WebuiTabsComponent;      // 子标签页容器
```

每种组件都有：

- `source` —— 从后端拉数据的 REST 端点（GET）
- `save / method` —— 提交动作的 REST 端点（POST）
- `confirm` —— 行内/按钮确认提示
- `danger` —— 红色样式标记

### 示例：表格 + 操作

```ts
{
  type: 'table',
  label: '后台进程',
  source: '/plugins/shell/processes',
  columns: [
    { key: 'pid', label: 'PID' },
    { key: 'cmd', label: '命令' },
    { key: 'startedAt', label: '启动时间', render: 'date' },
  ],
  actions: [
    { label: '终止', method: 'POST:/plugins/shell/processes/:id/kill', confirm: '确定？', danger: true },
  ],
  refresh: 5000,   // 5 秒自动刷新
}
```

### 示例：表单复用 ConfigSchema

```ts
{
  type: 'form',
  label: '基础配置',
  source: '/plugins/my-plugin/config',
  save: '/plugins/my-plugin/config',
  schema: ctx.configSchema,
}
```

## WebuiPage 完整结构

```ts
interface WebuiPage {
  key: string;                       // URL 段
  label: string;
  icon?: string;
  components: WebuiComponent[];
  permission?: PermissionId;         // 进入页面所需权限（PermissionId 从 @aalis/plugin-authority-api 导入）
}
```

在插件 `apply()` 中注册：

```ts
import { useWebuiService } from '@aalis/plugin-webui-api';

const PAGES: WebuiPage[] = [
  { key: 'shell', label: 'Shell', content: [/* ... */] },
];

export function apply(ctx: Context) {
  const webui = useWebuiService(ctx);
  for (const p of PAGES) webui.registerPage(p);
}
```

## 实现者

- [@aalis/plugin-webui-server](../plugins/plugin-webui-server.md) — 后端服务 + 静态文件托管
- `@aalis/plugin-webui-client` — 前端 React 应用（独立发布）

## 相关

- ConfigSchema 来自 `@aalis/core`
- 事件 `'tool:execute'` 与 `'token:usage'` 都被 webui-server 转 WebSocket 推送给前端
