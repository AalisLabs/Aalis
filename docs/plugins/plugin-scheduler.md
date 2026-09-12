# plugin-scheduler — 定时任务调度

**包名**: `@aalis/plugin-scheduler`  
**源码**: `packages/plugin-scheduler/src/index.ts`

## 概述

AI 可主动创建的定时任务系统，支持三种调度方式：cron 表达式（周期）、固定间隔秒数（周期），以及 `runAt` 指定时刻执行一次（一次性）。AI 工具还接受 `delaySeconds`，会换算为 `runAt`。

触发的消息带 `source='scheduler'`：plugin-agent 按来源分开管理生成，不会打断同会话的用户对话；plugin-commands 把它当作受信系统源（命令免交互确认，结果写入日志）。流控不对该来源单独豁免，是否受流控取决于 flow-control 的 `scopes` 能否匹配到该消息（默认 `*:group` 匹配不到）。

## 插件声明

```typescript
meta.name = '@aalis/plugin-scheduler'
meta.provides = ['scheduler']
meta.inject = { required: ['tools', 'cron-engine'], optional: ['agent'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `jobs` | array | `[]` | 计划任务列表：配置定时/周期性任务，让 AI 主动执行计划。 |
| `persistPath` | string | `'data:/scheduler-jobs.json'` | 动态任务存储路径：通过 AI 或 WebUI 创建的任务会持久化到此 storage URI，重启后自动加载。也兼容旧格式 “data/scheduler-jobs.json”。 |

## 注册工具

| 工具 | 说明 |
|---|---|
| `scheduler_create_job` | 创建定时/周期/一次性任务（`cron`、`interval`、`delaySeconds`、`runAt` 四选一；不传 `sessionId`/`platform` 时用当前会话） |
| `scheduler_list_jobs` | 列出任务及状态，可按名称关键词、状态过滤并分页 |
| `scheduler_remove_job` | 删除任务 |
| `scheduler_pause_job` | 暂停任务 |
| `scheduler_resume_job` | 恢复已暂停的任务 |

以上工具均属 `scheduler` 工具组。创建、删除、暂停、恢复为 `dangerous` 级且每次需确认，列表为 `sensitive` 级。

## 事件

| 事件 | 说明 |
|---|---|
| `scheduler:job:start` | 定时任务开始执行 |
| `scheduler:job:done` | 定时任务执行完成 |
| `scheduler:job:error` | 定时任务执行出错 |
| `trigger:fired` | 任务触发时广播的通用触发事件（`source` 为 `scheduler:<任务名>`），供 plugin-workflow 等订阅 |

## 工作方式

1. 任务有三个来源：配置项 `jobs`（静态任务）、WebUI「计划任务」页，以及 AI 调用的 `scheduler_create_job` 工具。后两者创建的是动态任务，会持久化到 `persistPath`。
2. cron 任务订阅 cron-engine 服务的共享 tick（可按 `timeZone` 求值）；interval 任务用固定间隔定时器；runAt 任务到点执行一次，之后动态任务被删除，静态任务被停用。
3. 触发时先广播 `trigger:fired`，再向目标会话发送 `inbound:message` 事件，`source` 设为 `scheduler`。消息的 `actor` 取创建任务时固化的创建者身份，触发的 AI 按该身份的权限执行，缺失则按匿名处理（配置文件中的静态任务缺省为 `webui:console`）。
