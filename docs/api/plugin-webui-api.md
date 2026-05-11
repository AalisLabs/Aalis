# plugin-webui-api — WebUI 服务与声明式页面组件契约

**包名**: `@aalis/plugin-webui-api`  
**源码**: `packages/plugin-webui-api/src/index.ts`  
**实现**: `@aalis/plugin-webui-server`（+ `@aalis/plugin-webui-client` 提供前端）

## 概述

定义 WebUI 后台服务接口、声明式页面组件 schema、`webuiPages` 插件字段类型。插件不需要懂 HTTP/React，只需在 PluginModule 上声明 `webuiPages: WebuiPage[]`，由 webui-server 自动渲染并暴露 REST + WebSocket。

## 服务接口

```ts
interface WebUIService {
  getPort(): number;
  getHost(): string;
  setClientDir?(dir: string): void;      // 允许替换前端
}
```

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
  permission?: PermissionId;         // 进入页面所需权限
}
```

在 `PluginModule` 上：

```ts
export const webuiPages: WebuiPage[] = [
  { key: 'shell', label: 'Shell', components: [...] },
];
```

## 实现者

- [@aalis/plugin-webui-server](../plugins/plugin-webui-server.md) — 后端服务 + 静态文件托管
- `@aalis/plugin-webui-client` — 前端 React 应用（独立发布）

## 相关

- ConfigSchema 来自 `@aalis/core`
- 事件 `'tool:execute'` 与 `'token:usage'` 都被 webui-server 转 WebSocket 推送给前端
