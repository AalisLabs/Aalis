# plugin-webui-client — WebUI 前端

**包名**: `@aalis/plugin-webui-client`  
**源码**: `packages/plugin-webui-client/src/main.tsx`（前端入口；托管方见 `packages/plugin-webui-server/src/client-discovery.ts`）

## 概述

Aalis 默认 WebUI 前端：React SPA 的**纯静态资源包**。它**不是插件**——没有 `apply`、没有 `meta`，
runtime 不加载它；打包产物由 `@aalis/plugin-webui-server` 托管。

## 包声明

```jsonc
// package.json
{
  "aalis": { "client": true },   // 前端标记：webui-server 据此发现
  "keywords": ["aalis", "aalis-interface"],
  "files": ["dist"]              // 构建产物 dist/index.html + 静态资源
}
```

## 配置

无配置项。

## 工作方式

1. `vite build` 产出 `dist/index.html` 及静态资源
2. webui-server 在 `ready` 时由 `client-discovery.ts` 扫描：`package.json` 标了
   `aalis.client: true` 且存在 `dist/index.html` 的包即为前端候选（不认任何具体包名）
3. webui-server 把每个候选注册成一条 `webui-client` 服务 provider（`getClientDir()`）
4. 活跃前端 = `webui-client` 的服务解析结果（`servicePreferences['webui-client']` 偏好 >
   provider 优先级 > 注册顺序），由 webui-server 挂成 Express 静态目录；在 WebUI「服务」页
   切换偏好即实时重挂 + 广播 `reload`，无需重启

第三方要换前端，正解就是照上面打 `aalis.client` 标记（详见 `docs/services/webui.md` 第 4b 节），
不需要写插件。

## 前端技术栈

前端源码位于 `packages/plugin-webui-client/src/`：
- React + TypeScript
- Vite 构建
- WebSocket 实时通信（useWebSocket hook）

## 前端页面

| 页面 | 说明 |
|---|---|
| Chat | 实时对话、流式输出、内联工具调用展示、待办事项面板 |
| Plugins | 插件列表、启用/禁用、配置编辑 |
| Platforms | 平台连接状态监控 |
| Files | 文件管理器（拖拽上传、下载、预览） |
| Logs | 实时日志流 |
| DynamicPage | 插件注册的动态页面（技能库等） |

## 流恢复 (Stream Resume)

前端通过 `stream_resume` WebSocket 消息类型支持页面刷新后的流恢复。当用户刷新页面时，服务端将已缓冲的流式内容一次性推送，实现无缝续流体验。

## 动效系统

前端内置多种 CSS 动画：
- `msg-in` — 消息入场（fade + 向上滑入）
- `page-fade` — 页面切换过渡
- `modal-scale` — 弹窗缩放入场
- `fade-in` — 通用淡入
- `typingBounce` — 打字指示器跳动
- `cursor-blink` — 光标闪烁
- `pulse` — 脉冲效果
- 按钮 `:active` 按压反馈（scale 0.97）
