# plugin-webui-client — WebUI 前端

**包名**: `@aalis/plugin-webui-client`  
**源码**: `packages/plugin-webui-client/src/index.ts`

## 概述

WebUI 前端静态资源挂载插件，将打包好的 React 前端文件挂载到 webui-server 的 Express 静态目录。

## 插件声明

```typescript
meta.name = '@aalis/plugin-webui-client'
meta.provides = ['webui-client']
meta.inject = { required: [{ service: 'webui-server', capabilities: ['api-v1'] }] }
```

## 配置

无配置项。

## 工作方式

1. 计算 `../client/dist` 路径（相对于编译后的 JS 文件位置）
2. 调用 `webui-server` 的 `setClientDir()` 将前端打包产物挂载到 Express
3. 对外提供 `webui-client` 服务（暴露 `getClientDir()`）

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

## 主题变体

`@aalis/plugin-webui-client-kawaii` 是独立的前端主题包，提供粉色系 Kawaii 风格 UI，包含樱花飘落动效。两者共享相同组件架构，仅 CSS 变量和部分样式不同。

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
