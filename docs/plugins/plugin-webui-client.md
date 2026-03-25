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

前端源码位于 `packages/plugin-webui-client/client/`：
- React + TypeScript
- Vite 构建
- WebSocket 实时通信
