# plugin-webui-client-kawaii — WebUI Kawaii 主题

**包名**: `@aalis/plugin-webui-client-kawaii`  
**源码**: `packages/plugin-webui-client-kawaii/src/`

## 概述

WebUI 前端的 Kawaii（可爱）主题变体，粉色系配色方案，包含樱花飘落等特色动效。与主题包 `plugin-webui-client` 共享相同的组件架构。

## 插件声明

```typescript
meta.name = '@aalis/plugin-webui-client-kawaii'
meta.provides = ['webui-client']
meta.inject = { required: [{ service: 'webui-server', capabilities: ['api-v1'] }] }
```

## 主题差异

| 特性 | 主版本 | Kawaii 版本 |
|---|---|---|
| 主色调 | 紫色 (`#7c6ff7`) | 粉色 (`#f472b6`) |
| 特色动效 | — | 樱花飘落 (`sakura-fall`, `sakura-sway`) |
| 整体风格 | 深色专业 | 粉色可爱 |

## 使用方式

在配置中启用此插件并禁用 `plugin-webui-client` 即可切换主题。两者提供相同的 `webui-client` 服务，不可同时启用。
