# plugin-session-tools — 子任务工具集

**包名**: `@aalis/plugin-session-tools`  
**源码**: `packages/plugin-session-tools/src/index.ts`

## 概述

为 AI Agent 提供子任务创建与并行协调工具，支持在独立子会话中执行任务并等待结果。

## 插件声明

```typescript
meta.name = '@aalis/plugin-session-tools'
meta.inject = { required: ['session-manager'] }
```

## 注册工具

| 工具 | 说明 |
|---|---|
| `create_subtask` | 创建子会话并启动子任务，可指定目标 persona/model |
| `wait_subtasks` | 等待一个或多个子任务完成，返回各子任务结果 |

## 工作方式

1. `create_subtask` 在当前会话下创建子会话，向子会话发送 `message:received` 事件
2. 子任务在独立上下文中执行，拥有自己的工具集和消息历史
3. `wait_subtasks` 轮询子会话状态，直到所有指定的子任务完成
4. 子任务完成后触发 `session:completed` 事件

## 使用场景

- 文档操作：使用共享 `docId` 让多个子任务协同编辑同一文档
- 复杂调研：并行执行多个搜索/分析子任务
- 任务拆分：将大任务分解为可并行执行的小步骤
