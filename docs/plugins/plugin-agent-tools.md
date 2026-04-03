# plugin-agent-tools — Agent 工具管理

**包名**: `@aalis/plugin-agent-tools`  
**源码**: `packages/plugin-agent-tools/src/index.ts`

## 概述

Agent 工具注册与管理服务，处理工具的权限/安全等级覆盖（authority override、safety override），为 Agent 提供统一的工具执行入口。

## 插件声明

```typescript
meta.name = '@aalis/plugin-agent-tools'
meta.provides = ['agent-tools']
meta.inject = { required: ['authority'] }
```

## 工作方式

1. 收集所有插件注册的工具
2. 应用 authority/safety 覆盖配置
3. 为 Agent 提供过滤后的工具列表和执行接口
