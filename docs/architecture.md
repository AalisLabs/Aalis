# Aalis 架构总览

本文档描述 Aalis 框架的整体架构设计、核心流程和扩展机制。

## 系统分层

```
┌──────────────────────────────────────────────────────────────┐
│                    平台层 (Platform Layer)                    |
│   CLI  ·  WebUI (Express+WS+React)  ·  OneBot v11/v12        |
├──────────────────────────────────────────────────────────────┤
│                    对话编排层 (Agent Layer)                    |
│   DefaultAgent: 消息构建 → LLM 调用 → 工具循环 → 上下文截断   │
├──────────────────────────────────────────────────────────────┤
│                    服务层 (Service Layer)                      │
│   LLM · Memory · Embedding · VectorStore · Persona · Tools   │
├──────────────────────────────────────────────────────────────┤
│                    核心框架层 (Core Layer)                     │
│   App · Context · ServiceContainer · PluginManager            │
│   EventBus · HookRegistry · CommandRegistry · ToolRegistry    │
│   ConfigManager · AuthorityManager · Logger                   │
└──────────────────────────────────────────────────────────────┘
```

## 消息处理完整流程

```
用户输入 (CLI / WebUI / OneBot)
  │
  ▼
Platform 适配器接收 → 发出 message:received 事件
  │
  ▼
App 路由 → DefaultAgent.handleMessage(incoming)
  │
  ├─ 1. hooks.run('message:before')  ← 插件可修改/拦截消息
  │
  ├─ 2. buildMessages()
  │     └─ [系统提示词] + [历史消息(≤50)] + [当前用户消息]
  │
  ├─ 3. hooks.run('llm-call:before')
  │     ├─ plugin-memory-vector: 注入语义记忆上下文
  │     └─ plugin-tool-search: 替换工具列表为搜索层
  │
  ├─ 4. trimMessages() ← 按 token 预算裁剪
  │
  ├─ 5. LLM.chatStream() → 流式输出 → message:stream 事件
  │
  ├─ 6. hooks.run('llm-call:after')
  │
  ├─ 7. 工具调用循环 (最多 maxToolIterations 次)
  │     ├─ hooks.run('tool-call:before')
  │     ├─ ctx.tools.execute() ← 权限检查 + 执行
  │     ├─ hooks.run('tool-call:after')
  │     └─ 追加工具结果 → 继续调用 LLM
  │
  ├─ 8. hooks.run('response:before')
  │     └─ plugin-persona: outputFormat JSON 解析
  │
  ├─ 9. 保存到 memory (用户+助手消息)
  │
  └─ 10. emit('message:send') → 各平台输出给用户
```

## 服务 IoC 与能力匹配

### 服务注册

```typescript
// 插件提供服务
ctx.provide('llm', deepseekService, {
  capabilities: ['chat', 'tool_calling', 'streaming', 'thinking'],
  priority: 10,
});
```

### 服务消费

```typescript
// 按能力查找
const llm = ctx.getService<LLMService>('llm', ['tool_calling']);
```

### 多实现优先级

同一服务可有多个提供者。框架按优先级降序排列，`getService()` 返回满足所需能力的最高优先级实例。

```
llm 服务:
  [0] plugin-deepseek (priority=10, caps=[chat, tool_calling, streaming])
  [1] plugin-openai   (priority=0,  caps=[chat, tool_calling, streaming])
```

### 服务偏好

用户可通过配置或 WebUI 切换首选提供者（`preferService`）。

## 插件生命周期

```
register
  │
  ▼
pending ──(所有 required 依赖满足)──→ activating ──→ active
  ▲                                                    │
  │                                                    │
  └───(依赖服务被移除)────────────────────────────────┘

disabled ←─(手动禁用)─ active
  │
  └─(手动启用)─→ pending → ...
```

### Soft Reload 机制

当服务注册/移除时触发 soft reload（固定点迭代）：

1. **Phase 1**: 停用所有 required 依赖不满足的 active 插件 → pending
2. **Phase 2**: 尝试激活所有 pending 插件
3. **Phase 3**: 检查必需服务缺失时自动恢复（`ensureServiceProvider`）
4. **Phase 4**: 发出 `plugins:changed` 事件

### 依赖与服务恢复

`ensureServiceProvider(serviceName)` 会搜索所有 pending 插件中能 `provides` 该服务的插件，并尝试递归激活其依赖链。

## 中间件钩子管道

钩子（Hook）是有序的中间件管道，插件可拦截核心流程的各阶段：

| 钩子名 | 数据 | 用途 |
|---|---|---|
| `message:before` | `{ message }` | 修改/拦截收到的消息 |
| `llm-call:before` | `{ messages, tools }` | 修改发给 LLM 的消息列表和工具 |
| `llm-call:after` | `{ response, messages }` | 处理 LLM 返回的响应 |
| `tool-call:before` | `{ name, args, toolCallContext }` | 修改工具调用参数 |
| `tool-call:after` | `{ name, result, toolCallContext }` | 处理工具返回结果 |
| `response:before` | `{ content, sessionId }` | 修改最终回复内容 |

中间件按优先级降序执行，通过调用 `next()` 传递控制权。不调用 `next()` 可中止管道。

## 权限与安全

### 权限等级

```
0 (默认) → 普通用户
1        → 配置中 defaultAuthority
2        → 可执行 /grant 等管理指令
5        → 可执行 dangerous 操作 (/shutdown 等)
Owner    → 最高权限 (配置 ownerAuthority，默认 5)
```

### 高危操作确认流程

```
工具/指令标记 safety='dangerous'
  │
  ▼
检查用户权限 ≥ 要求等级
  │
  ▼
检查白名单 (isDangerousAllowed)
  │ 未在白名单
  ▼
交互式确认 (平台 confirmHandler)
  │ 用户确认 Y
  ▼
加入临时白名单 (含有效期)
  │
  ▼
执行操作
```

## 指令→工具桥接

当 `commandAsTools: true` 时，注册的指令自动暴露为 AI 可调用的工具：

- 工具名: `cmd_{command_name}`
- 参数: `{ args: string }`
- AI 可在对话中主动调用指令
- 安全等级和权限等级继承自原指令

## 上下文窗口管理算法

`trimMessages()` 裁剪消息以适配 LLM 上下文窗口：

```
可用 token = contextLength - maxTokens - 512(安全余量)

保护规则:
  1. 首条系统消息 (主提示词) — 永不删除
  2. 末条消息 (当前用户输入) — 永不删除
  3. Hook 注入的系统消息有独立预留额度 (memoryTokenBudget)

裁剪策略:
  第一轮: 从最旧的非系统消息开始删除 (assistant + tool 成组删除)
  第二轮: 如仍超出，删除 hook 注入的系统消息
  特殊: 长期记忆超出预留额度时，按比例缩减内容 (最少保留 200 字符)
```

## 向量语义记忆

### 索引流程

```
message:received → embedding.embed(text) → vectorstore.add(vector, metadata)
message:send     → embedding.embed(text) → vectorstore.add(vector, metadata)
```

### 检索与注入

```
llm-call:before hook (优先级 50):
  1. 提取最后一条用户消息
  2. embedding.embed(query)
  3. vectorstore.search(queryVector, topK*3)  ← 粗召回
  4. 时间加权重排:
     finalScore = (1-timeWeight) * semanticScore + timeWeight * recencyScore
     recencyScore = exp(-0.1 * daysSince)
  5. 取前 topK，过滤重复
  6. 插入 system 消息（带日期和来源标注）
```

## 事件列表

| 事件 | 载荷 | 说明 |
|---|---|---|
| `message:received` | `IncomingMessage` | 用户消息到达 |
| `message:send` | `OutgoingMessage` | 机器人回复 |
| `message:stream` | `StreamChunkMessage` | 流式输出片段 |
| `tool:execute` | `ToolExecuteMessage` | 工具执行状态 |
| `service:registered` | `name, capabilities[]` | 服务注册 |
| `service:unregistered` | `name` | 服务移除 |
| `plugin:loaded` | `name` | 插件加载 |
| `plugin:unloaded` | `name` | 插件卸载 |
| `plugins:changed` | — | 插件状态变化 |
| `ready` | — | 应用就绪 |
| `dispose` | — | 应用关闭 |
| `restarting` | — | 应用重启中 |
