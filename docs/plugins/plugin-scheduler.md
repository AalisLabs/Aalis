# plugin-scheduler — 定时任务调度

**包名**: `@aalis/plugin-scheduler`  
**源码**: `packages/plugin-scheduler/src/index.ts`

## 概述

AI 可主动创建的 Cron 定时任务系统，支持 cron 表达式和固定间隔两种调度方式。定时任务触发的消息自动绕过流控和速率限制。

## 插件声明

```typescript
meta.name = '@aalis/plugin-scheduler'
meta.provides = ['scheduler']
meta.inject = { required: ['session-manager'] }
```

## 注册工具

| 工具 | 说明 |
|---|---|
| `schedule_task` | 创建定时任务（cron 表达式或固定间隔） |
| `list_scheduled_tasks` | 列出当前所有定时任务 |
| `cancel_scheduled_task` | 取消指定定时任务 |

## 事件

| 事件 | 说明 |
|---|---|
| `scheduler:job:start` | 定时任务开始执行 |
| `scheduler:job:done` | 定时任务执行完成 |
| `scheduler:job:error` | 定时任务执行出错 |

## 工作方式

1. AI 通过 `schedule_task` 工具创建定时任务
2. 调度器按 cron 表达式或间隔触发任务
3. 触发时向目标会话发送 `inbound:message` 事件，`source` 设为 `scheduler`
4. 调度消息绕过流控中间件的速率限制
