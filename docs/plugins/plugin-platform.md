# plugin-platform — 平台管理聚合

**包名**: `@aalis/plugin-platform`  
**源码**: `packages/plugin-platform/src/index.ts`

## 概述

平台管理聚合服务，收集所有注册了 `platform` 服务的插件信息，提供统一的平台连接状态查询和平台名称发现接口。

## 插件声明

```typescript
meta.name = '@aalis/plugin-platform'
meta.provides = ['platform-manager']
meta.inject = {}
```

## 工作方式

1. 监听 `service:registered` 和 `service:unregistered` 事件
2. 聚合所有 `platform` 类型服务的连接状态
3. 为 WebUI 平台监控页面提供数据源
