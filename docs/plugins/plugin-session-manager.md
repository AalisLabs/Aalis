# plugin-session-manager — 会话管理器

**包名**: `@aalis/plugin-session-manager`  
**源码**: `packages/plugin-session-manager/src/index.ts`

## 概述

会话生命周期管理，支持会话树形结构和平台配置继承。每个平台可配置独立的 persona、model、工具集等。

## 插件声明

```typescript
meta.name = '@aalis/plugin-session-manager'
meta.provides = ['session-manager']
meta.inject = { optional: ['memory'] }
```

## 功能

- **会话 CRUD**: 创建、更新、切换、删除会话
- **会话树**: 支持父子会话关系（用于子任务系统）
- **平台配置**: 每个平台可独立配置 persona、model、工具白名单等，会话继承平台配置
- **事件发射**: `session:created`、`session:updated`、`session:switched`、`session:deleted`、`session:completed`

## 平台配置继承

```
全局配置 → 平台配置 → 会话配置
```

平台级别可以覆盖 persona、model 等设置，会话创建时自动继承所属平台的配置。
