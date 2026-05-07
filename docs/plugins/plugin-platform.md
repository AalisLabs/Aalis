# plugin-platform — 平台管理聚合

**包名**: `@aalis/plugin-platform`  
**源码**: `packages/plugin-platform/src/index.ts`

## 概述

平台管理聚合服务（同名 facade）。以 `provides:['platform']` + `capability:['router']`
注册到 `platform` 服务名下，对外作为聚合层 `PlatformService` 暴露所有平台适配器的连接、
身份和分组信息；底层各平台插件（cli/webui/onebot 等）仍以 `ctx.provide('platform', adapter)`
方式注册自己的适配器实例。与 storage-router / llm-router 同模式。

## 插件声明

```typescript
meta.name = '@aalis/plugin-platform'
meta.provides = ['platform']
meta.inject = { optional: ['platform'] }
```

## 工作方式

1. 监听 `service:registered` 和 `service:unregistered` 事件
2. 聚合所有 `platform` 类型服务的连接状态
3. 为 WebUI 平台监控页面提供数据源
