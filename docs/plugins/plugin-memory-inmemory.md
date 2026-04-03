# plugin-memory-inmemory — 内存消息存储

**包名**: `@aalis/plugin-memory-inmemory`  
**源码**: `packages/plugin-memory-inmemory/src/index.ts`

## 概述

无持久化的内存消息存储，作为 `memory` 服务的 fallback 实现（优先级 -100）。当无 SQLite 或 MongoDB 等持久化存储可用时自动启用。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-inmemory'
meta.provides = ['memory']  // priority: -100
meta.inject = {}
```

## 工作方式

- 消息存储在进程内存中，按命名空间（namespace）隔离
- 应用重启后数据丢失
- 适用于开发/测试环境或无需持久化的场景
