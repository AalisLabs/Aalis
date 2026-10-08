# plugin-user-profile — 用户事实档案

**包名**: `@aalis/plugin-user-profile`  
**源码**: `packages/plugin-user-profile/src/index.ts`

## 概述

通过 LLM 从对话中提取关于用户的长期事实（喜好、经历、关系、近况），按 `platform:userId` 落库到 memory metadata 的 `user:profile` namespace，并在 LLM 调用前以 system 消息的形式注入当前轮上下文（见下文 `turn-context` 槽）。`plugin-message-archive` 落库入站消息后发出 `inbound:message:archived` 事件，本插件据此按会话和用户计数（驱动事实提取），并累加旁观关系增量（`relationIncrementWitness` 为 0 时不加分，互动次数与最近互动时戳照记）；`agent:input:before` 中间件在触发回复时按 triggerType 叠加 direct / immediate / interval 增量。档案注入经 `agent:prompt` 贡献点的 `turn-context` 槽，落在对话历史之后，顺序为第三方行为指令、主发言者档案、其他参与者摘要。第三方行为指令存于独立 namespace `aalis:instructions`，按 persona 名分堆。另注册 `user_profile_lookup` 工具（按 `user_key`，或按 `platform` 加 `user_id` 查一个用户的档案）与 `profile` / `instruct` 两组命令，装了 webui-server 时提供「用户档案」页（见下文），并以 type `user-profile` 参与统一的 `memory:clear`：仅在 scope 为 all 时清空全部档案（会话级清除不动档案），并一并清空 `aalis:instructions`（与 `enableInstructions` 是否开启无关）。

不带 `userId` 的入站消息（如宿主通知）不计数，也不写档案、不改关系分。用户事实提取与指令提取两处读取历史时，滤掉指令类消息（`DIRECTIVE_KINDS`：workflow 代发的任务与宿主通知），它们不是任何人的发言，不作为抽取语料。本插件不读会话配置的 `memoryRecallScope`：发言者与其他参与者的事实照常跨会话注入，这些事实可能抽自别的会话（包括私聊）。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-user-profile',
  displayName: '用户事实档案',
  subsystem: 'memory',
  uses: {
    memory,
    llm,
    events,
    hooks,
    contributions,
    config,
    logger,
    authority: optional(authority),
    tools: optional(tools),
    commands: optional(commands),
    persona: optional(persona),
    userRelation: optional(userRelation),
    webui: optional(webuiServer),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `extractEveryNMessages` | number | `5` | 每 N 条消息提取一次：同一用户每发 N 条消息触发一次事实提取。无论 Aalis 是否回复都会计数，群聊中每人独立计数。设为 1 表示每条消息都尝试提取（不推荐）；设为 0 或负数则禁用提取（仍会注入已有档案） |
| `historyForExtraction` | number | `8` | 提取参考历史条数：触发提取时，喂给 LLM 的最近消息条数 |
| `maxFactsPerUser` | number | `30` | 单用户事实上限：超出后按 updatedAt 升序淘汰最久未更新的，旧事实自动淘汰。最小有效值为 5（写入时自动下限），不支持设为 0 来禁用提取；若要禁用提取请将 extractEveryNMessages 设为 0 |
| `maxFactCharsPerItem` | number | `80` | 单条事实字数上限：超出会被裁断，避免 LLM 输出长段落代替事实 |
| `maxOtherParticipants` | number | `3` | 群聊其他参与者档案上限：群聊中除当前发言者外，最多加载多少人的档案摘要注入 LLM。0 表示禁用群聊多用户注入 |
| `maxFactsForOthers` | number | `5` | 其他参与者摘要条数上限：群聊背景参与者每人只显示最近更新的 N 条事实，避免 prompt 过长 |
| `temporaryFactMaxAgeDays` | number | `90` | 临时事实保留天数：temporality=temporary 的事实超过该天数未更新后不再主动注入 prompt（仍保留在档案中，等待后续 update/remove）。0 表示不淡出 |
| `relationScoreDecayPerDay` | number | `0.5` | 关系强度每日衰减：用户长期未互动时，relationScore 每天衰减的分数。0 表示不衰减 |
| `relationIncrementDirect` | number | `1` | 私聊关系增量：direct 触发时每条消息增加的关系强度 |
| `relationIncrementImmediate` | number | `1.5` | 主动呼叫关系增量：群聊 @/名字主动触发时每条消息增加的关系强度 |
| `relationIncrementInterval` | number | `0.5` | 群聊被动参与关系增量：群聊频率/活跃度被动触发或普通入站消息增加的关系强度 |
| `relationIncrementWitness` | number | `0.1` | 旁观（不回复）关系增量：每条入站消息无论 agent 是否回复都加上的最低档增量。若 agent 触发回复，会再叠加 direct/immediate/interval 之一。0 表示旁观不加分；互动次数与最近互动时戳仍照记（衰减基准与最近互动排序的唯一来源） |
| `extractLLM` | llm-ref | — | 提取用模型：留空则使用当前 LLM 服务的默认模型。事实提取是简单结构化任务，推荐选择廉价/快速模型（如 deepseek-chat）以降低成本 |
| `allowGlobalBackfill` | boolean | `false` | 允许跨会话补齐副档案：当前群/会话中的候选不足时，是否允许从其他群、私聊等跨会话中选取最近互动过的用户来补全「其他参与者背景摘要」。关闭后仅限当前上下文内出现过的用户 |
| `enableInstructions` | boolean | `true` | 启用第三方行为指令：让 Aalis 记录第三方（管理员/操作者）对其行为的客观指令（如「不要长时间封禁」「按严重程度分层禁言」），作为跨会话的行为约束。每次调用模型前以 system 消息注入在对话历史之后，排在用户档案之前。按当前 persona 名分堆。 |
| `instructionMinAuthority` | number | `2` | 指令最小权限门槛：只有 authority ≥ 该值的用户的发言才会被采纳为指令来源（防陌生人塞规则）。默认 2（一般管理员），设为 5 表示仅 owner。通过 /instruct 命令手动添加的指令不走该门槛（命令本身已是 authority 2 守卫） |
| `instructionExtractEveryNMessages` | number | `40` | 指令自动提取触发频次：全局累计入站消息每 N 条触发一次指令提取，默认 40 以降低成本；设为 0 禁用 LLM 自动提取，只保留 /instruct 命令通道 |
| `instructionHistoryForExtraction` | number | `20` | 指令提取参考历史条数：触发指令提取时从触发会话取最近多少条消息作为提取材料 |
| `maxInstructions` | number | `12` | 指令条数上限：超出后按 updatedAt 升序淘汰最久未更新的。最小有效值为 3。准则少而准比多而散更好 |
| `maxInstructionCharsPerItem` | number | `120` | 单条指令字数上限：超出会被裁断 |

## 「用户档案」页

位置为插件详情（`/p/@aalis%2Fplugin-user-profile/profiles`），声明式，只删不改：档案里的事实是从对话里自动提取的，写错的或被人故意塞进去的（档案投毒）在这里删掉，不在界面上改写。不装 webui-server 时照常记档案，只是没有页面。

- **表格：** 有事实的人一行（只有关系分、没有事实的不列），列出用户键（`platform:userId`）、事实条数与最近一条事实记下的时间，最近的在前。窄时只留用户与条数。
- **详情：** 选中一个人，列出各条事实（正文、分类、时效「长期」或「近期」、记下的时间），最近的在前；底下是「清空档案」。
- **删除一条事实：** 事实那一行的「删除」，`destructive`，由宿主弹确认。按行里记的用户键与事实 id 重新读档案再删，这一条已经不在时报错、什么都不改；关系分与互动次数照旧。
- **清空档案：** 详情里的「清空档案」，`destructive`，删掉这个人的整份档案（事实连同关系强度与互动次数，与 `/profile.clear` 相同）；已经没有档案时报错。
- **刷新：** 事实变了就整页 `invalidate`：页面上的两个动作、事实提取写入、`/profile.clear`、`/profile.forget`、`/profile.clear.nuke` 与全局的 `memory:clear`。只改关系分的写入（每条入站消息都有）不算，表格上的时间取的是最近一条事实，不随它变。

## 相关

- 记忆服务契约：[api/api-memory.md](../api/api-memory.md)
- LLM 服务契约：[api/api-llm.md](../api/api-llm.md)
- 工具服务契约：[api/api-tools.md](../api/api-tools.md)
- 命令服务契约：[api/api-commands.md](../api/api-commands.md)
- 关系图（可选注入 `user-relation`）：[user-relation.md](./user-relation.md)
- 入站消息归档（`inbound:message:archived` 事件来源）：[plugin-message-archive.md](./plugin-message-archive.md)
- 页面契约（「用户档案」页）：[api/api-webui.md](../api/api-webui.md)
