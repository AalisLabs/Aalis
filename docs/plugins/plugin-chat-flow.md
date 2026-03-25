# plugin-chat-flow — 对话流控

**包名**: `@aalis/plugin-chat-flow`  
**源码**: `packages/plugin-chat-flow/src/index.ts`

## 概述

群聊消息流控中间件。通过 `message:before` 中间件拦截消息管道，根据活跃度、间隔、@提及等条件决定何时触发 AI 回复。支持按平台配置不同的流控策略。

## 插件声明

```typescript
meta.name = '@aalis/plugin-chat-flow'
meta.provides = [] // 纯中间件，不提供服务
meta.inject = { optional: ['memory', 'persona'] }
```

## 配置

### 顶层

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `triggerNames` | string | `''` | 额外触发词（逗号分隔） |
| `profiles` | array | `[]` | 流控配置列表（SchemaArray） |

### Profile 字段

每个 profile 对应一套流控策略，通过 `platforms` 匹配平台：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `platforms` | string | `''` | 适用平台（逗号分隔，空=默认配置） |
| `intervalMode` | select | `dynamic` | 触发模式: fixed / dynamic / both |
| `fixedInterval` | number | 5 | 固定间隔（条数） |
| `activityScoreLower` | number | 3.0 | 动态模式下限阈值 |
| `activityScoreUpper` | number | 8.0 | 动态模式上限阈值 |
| `activityDecayMinutes` | number | 5 | 活跃度衰减时间 (分钟) |
| `triggerOnAt` | boolean | true | @bot 时立即触发 |
| `cooldownSeconds` | number | 5 | 回复后冷却时间 (秒) |
| `typingEnabled` | boolean | true | 启用打字延迟 |
| `typingDelayPerChar` | number | 50 | 每字符延迟 (ms) |
| `typingMaxDelay` | number | 5000 | 最大打字延迟 (ms) |
| `enableIdleTrigger` | boolean | false | 启用空闲主动发言 |
| `idleTriggerMinutes` | number | 30 | 空闲触发间隔 (分钟) |
| `idleTriggerStyle` | select | `exponential` | 空闲退避策略 |
| `idleTriggerMaxMinutes` | number | 480 | 最大空闲间隔 (分钟) |
| `idleTriggerJitter` | number | 0.2 | 空闲触发时间抖动系数 |
| `muteKeywords` | string | `''` | 禁言关键词（逗号分隔） |
| `muteTimeSeconds` | number | 300 | 禁言时间 (秒) |

## 工作原理

### Profile 匹配

```
消息平台 → 精确匹配 profiles 中的 platforms → 匹配失败 → 使用 platforms 为空的默认 profile → 无默认 profile → 放行
```

### 触发条件

1. **即时触发**: @bot 或消息包含触发词/人设名称 → 直接放行
2. **间隔触发** (三种模式):
   - `fixed`: 累计收到 `fixedInterval` 条消息后触发
   - `dynamic`: 基于活跃度评分（带时间衰减）达到动态阈值时触发
   - `both`: 满足任一条件即触发
3. **缓冲**: 未触发的消息存入 memory 但不送 Agent（不调用 `next()`，中断管道）

### 附加机制

- **禁言**: 消息含禁言关键词 → 进入禁言期，期间所有消息缓冲
- **冷却**: 回复后设置冷却期，期间继续累计但不触发
- **空闲触发**: 长时间无人说话时主动发起话题（指数退避 / 固定间隔 + 抖动）
- **打字延迟**: `response:before` 中间件（优先级 -100）模拟打字延迟

### 中间件优先级

- `message:before`: **200**（高优先级，在其他中间件之前拦截）
- `response:before`: **-100**（低优先级，在其他后处理之后执行打字延迟）
