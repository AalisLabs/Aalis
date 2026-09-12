# plugin-user-profile — 用户事实档案

**包名**: `@aalis/plugin-user-profile`  
**源码**: `packages/plugin-user-profile/src/index.ts`

## 概述

通过 LLM 从对话中提取关于用户的长期事实（喜好、经历、关系、近况），按 `platform:userId` 落库到 memory metadata 的 `user:profile` namespace，并在 LLM 调用前以 system 消息的形式注入当前轮上下文（见下文 `turn-context` 槽）。`plugin-message-archive` 落库入站消息后发出 `inbound:message:archived` 事件，本插件据此按会话和用户计数（驱动事实提取），并累加旁观关系增量（`relationIncrementWitness` 为 0 时跳过）；`agent:input:before` 中间件在触发回复时按 triggerType 叠加 direct / immediate / interval 增量。档案注入经 `agent:prompt` 贡献点的 `turn-context` 槽，顺序为第三方行为指令、Aalis 自档案、主发言者档案、其他参与者摘要。第三方行为指令存于独立 namespace `aalis:instructions`，按 persona 名分堆。另注册 `user_profile_lookup` 工具与 `profile` / `instruct` 两组命令，并以 type `user-profile` 参与统一的 `memory:clear`：仅在 scope 为 all 时清空全部档案（会话级清除不动档案），启用指令时一并清空 `aalis:instructions`。

## 插件声明

```typescript
meta.name = '@aalis/plugin-user-profile'
meta.displayName = '用户事实档案'
meta.subsystem = 'memory'
meta.inject = { required: ['memory', 'llm'], optional: ['user-relation', 'tools'] }
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
| `relationIncrementWitness` | number | `0.1` | 旁观（不回复）关系增量：每条入站消息无论 agent 是否回复都加上的最低档增量。若 agent 触发回复，会再叠加 direct/immediate/interval 之一。0 表示禁用旁观计分 |
| `extractLLM` | llm-ref | — | 提取用模型：留空则使用当前 LLM 服务的默认模型。事实提取是简单结构化任务，推荐选择廉价/快速模型（如 deepseek-chat）以降低成本 |
| `allowGlobalBackfill` | boolean | `false` | 允许跨会话补齐副档案：当前群/会话中的候选不足时，是否允许从其他群、私聊等跨会话中选取最近互动过的用户来补全「其他参与者背景摘要」。关闭后仅限当前上下文内出现过的用户 |
| `enableSelfProfile` | boolean | `false` | 启用 Aalis 自档案：让 Aalis 周期性地反思自身，提炼「关于自己的事实」（近期心情走向、在意的事、自我观察）。注入到所有 LLM 调用的 system prompt 早段，提供跨会话的人格延续性。⚠️ 默认关闭：自档案是模型对自身输出的二次提炼，再注入会自我强化先前的臆测、随时间漂移并放大幻觉，不建议开启 |
| `selfReflectEveryNMessages` | number | `25` | Aalis 自反思触发频次：全局累计入站消息每 N 条触发一次自反思。建议比单用户提取慢（默认 25），避免抖动 |
| `selfReflectHistory` | number | `16` | 自反思参考历史条数：触发自反思时，从触发会话取最近多少条消息作为反思材料 |
| `maxSelfFacts` | number | `20` | Aalis 自档案事实上限：超出后按 updatedAt 升序淘汰最久未更新的。最小有效值为 5（写入时自动下限），不支持设为 0 来禁用；若要禁用自反思请关闭 enableSelfProfile |
| `enableInstructions` | boolean | `true` | 启用第三方行为指令：让 Aalis 记录第三方（管理员/操作者）对其行为的客观指令（如「不要长时间封禁」「按严重程度分层禁言」），作为跨会话的行为约束。注入到 system prompt 最前段，优先级高于自反思 selfFacts。按当前 persona 名分堆。 |
| `instructionMinAuthority` | number | `2` | 指令最小权限门槛：只有 authority ≥ 该值的用户的发言才会被采纳为指令来源（防陌生人塞规则）。默认 2（一般管理员），设为 5 表示仅 owner。通过 /instruct 命令手动添加的指令不走该门槛（命令本身已是 authority 2 守卫） |
| `instructionExtractEveryNMessages` | number | `40` | 指令自动提取触发频次：全局累计入站消息每 N 条触发一次指令提取。建议比自反思更慢（默认 40），降低成本；设为 0 禁用 LLM 自动提取，只保留 /instruct 命令通道 |
| `instructionHistoryForExtraction` | number | `20` | 指令提取参考历史条数：触发指令提取时从触发会话取最近多少条消息作为提取材料 |
| `maxInstructions` | number | `12` | 指令条数上限：超出后按 updatedAt 升序淘汰最久未更新的。最小有效值为 3。指令上限建议比 selfFacts 紧，准则少而准比多而散更好 |
| `maxInstructionCharsPerItem` | number | `120` | 单条指令字数上限：超出会被裁断 |

## 相关

- 记忆服务契约：[api/api-memory.md](../api/api-memory.md)
- LLM 服务契约：[api/api-llm.md](../api/api-llm.md)
- 工具服务契约：[api/api-tools.md](../api/api-tools.md)
- 命令服务契约：[api/api-commands.md](../api/api-commands.md)
- 关系图（可选注入 `user-relation`）：[user-relation.md](./user-relation.md)
- 入站消息归档（`inbound:message:archived` 事件来源）：[plugin-message-archive.md](./plugin-message-archive.md)
