# `plugin-user-relation`：关系图

**包名**: `@aalis/plugin-user-relation`  
**源码**: `packages/plugin-user-relation/src/index.ts`

## 概述

用 LLM 从对话中提取人物、事件、实体及其关系，维护一张人物关系图。每个会话累计 `triggerEveryNMessages` 条入站消息后自动提取一次；开启 `agentInjection` 时，把这一轮点名她的各位发言者（真人输入里 triggerType 为 direct、immediate 或没经触发判定的输入的发言者；带来源的注入不算）的子图速览合在一块里，经 `agent:prompt` 贡献点的 `turn-context` 槽注入；有几位时各小节标题注明是谁的。另提供 Agent 工具、`/relation` 指令与 WebUI 的关系图页与原始数据页（见文末），并登记清理类型 `user-relation`、参与 `memory:clear`：仅 scope 为 all 时清空整张图；会话级清理不动它，显式选了 `user-relation` 时回一行未清理，写明是跨会话数据、只在清理全部会话时清。字段与术语对照见 [关系图 · 字段含义速查](./user-relation-graph.md)。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-user-relation',
  displayName: '人物关系图',
  subsystem: 'memory',
  provides: [userRelation],
  uses: {
    memory,
    logger,
    config,
    events,
    hooks,
    contributions,
    provide,
    llm: optional(llm),
    persona: optional(persona),
    platform: optional(platform),
    tools: optional(tools),
    commands: optional(commands),
    webui: optional(webuiServer),
    embedding: optional(embedding),
    sessionManager: optional(sessionManager),
    sessionFields: optional(sessionFields),
    document: optional(ownHostConfig),
  },
  apply(caps) { /* 见源码 */ },
});
```

提取计数只算真人的话，与用户档案同一判据（有账号且不带来源，按入站消息的 `source` 认）：不带 `userId` 的入站（如宿主通知）与带来源的注入（子任务的任务消息、定时任务、好友与入群申请通知等）不计入每个会话的提取计数。提取读取历史时（同会话读取、跨会话读取与跨会话降级三条路径）滤掉指令类消息（`DIRECTIVE_KINDS`，见 [schema-message](../api/schema-message.md#kind-常量)）与带来源的输入，它们不是谁在会话里说话，不交给模型抽关系：子任务会话不会凭任务消息建出 `<平台>:parent:<父会话>` 这个人。

提取写入时人物只认确定的事实：窗口里说话的人（真人，与带账号的她自己）、存档记下的被 @ 的账号（元数据的 `Mentions`，按那条消息的平台拼成 `<平台>:<账号>`）、这一轮读到的图里已有的人。模型输出的其余人物不落库，引用他们的边一起丢掉，不按名字或此刻登记了哪些平台认。提取提示里对她的称呼取人设名（按触发提取的会话取一次 `getPersonaName`），人设服务缺席或卡没取名时用「机器人」。

证据核对：每条证据的消息 id 要在这次窗口里，给了 quote 的要是这些消息之一的子串（去掉空白比），否则这条证据作废（模型会编消息 id 和引文）。作废只丢证据：人际关系边（`strictSelfAssertion`）因此不建，其余节点和边照建，只是不带证据。

候选召回：交给模型的候选事件是 `candidateEventDays` 天内活跃的前 `candidateEventLimit` 个。实体候选另按名字召回：窗口里真人消息的文字（规整后）含某个实体的名字或别名（两个字以上）时，这个实体也进候选，免得超过活跃天数的老实体被重建一份。活跃的取 `candidateEventLimit`×2，两路合计不超过 ×4。

`/relation` 的长任务（consolidate、rewrite-weights、event-duplicates、compress、maintain）开始执行时先往当前会话推一句「正在……，请稍候」的回执，只推给有平台适配器认领的会话，定时任务发进群里的也照推；没有认领者的会话（如编排的内部会话）不推。

「关系图范围」`recallScope`（`session` 仅本会话 / `all` 全部，默认 `all`）可按会话设（[api-session-settings](../api/api-session-settings.md)，只有 owner 能改），开着注入（`agentInjection`）、工具（`toolsEnabled`）或 `/relation` 指令（`commandsEnabled`）时才登记，三者都关着时会话设置里不列它。不是 `all` 的（含填错的）一律按仅本会话：注入只留本会话的内容：近期事件只列 `sessionScope` 等于当前会话的事件（全局事件与别的会话的事件都不列，共现伙伴随之收窄），不出「所属跨会话话题」行，也不出「最近热点（全局）」整节；人际关系与关注的事物照常注入。带会话作用域参数 `session_scope` 的六个工具（`user_relation_expand_node`、`user_relation_search_events`、`user_relation_timeline`、`user_relation_recommend_persons`、`user_relation_gossip`、`user_relation_community_overview`）的会话作用域只能是本会话，`user_relation_expand_node` 与 `user_relation_recommend_persons` 随之在去掉别的会话事件的图上展开（只经别的会话的事件才连上的人不在子图与候选里），推荐的分数、共同邻居与解释路径也在这张图上算；没有这个参数的工具同样只取本会话的事件：`user_relation_resolve_node` 不列别的会话的事件，`user_relation_find_path`、`user_relation_score`、`user_relation_shared`、`user_relation_list_edges` 在去掉别的会话的事件（连同连着它们的边）的图上算，路径、分数、共同邻居与边都不经过它们。按节点 id 取单个节点的工具（如 `user_relation_node_score`）给了别的会话的事件 id 时照样取到它。公开指令 `/relation show` 与 `/relation orphans` 与读工具同一判据，只列本会话的事件：`show person` 不列别的会话的事件与连着它们的边，`show event` 给了别的会话的事件 id 回未找到；`orphans` 仍按全图判孤立，事件一节只列本会话的；人、人际关系与实体照常。需 owner 授予的 `/relation event-duplicates` 取自全图，不按范围收窄。范围每轮现读，会话设置不在场时只取插件配置里的值。

## 存储结构

存储基于 `MemoryService.saveMetadata`（namespace `user-relation`），key schema：

| 前缀 | 形式 | 说明 |
|---|---|---|
| `person:` | `person:{platform}:{userId}` | `PersonNode`；key 与 `displayName` 解耦，昵称变化不影响引用 |
| `event:` | `event:{uuid}` | `EventNode` |
| `entity:` | `entity:{uuid}` | `EntityNode` |
| `edge:` | `edge:{uuid}` | `RelationEdge`（`kind` 决定具体子型） |

边的 `from*` / `to*` 永远引用 key/id，**不引用 name**。

---

## 1. 淘汰公式 (`evictByQuota`)

入参 quota 形状（关键默认值）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxPersons` / `maxEvents` / `maxEntities` / `maxEdges` | — | 各类容量上限；为 `0` 跳过该类 |
| `pagerankDamping` / `Iterations` / `Epsilon` | `0.85` / `20` / `1e-4` | PageRank 收敛参数 |
| `personSeed` / `entitySeed` / `eventSeed` | `2` / `1.5` / `1` | 个性化向量种子权（重要性 人>物>事 内嵌） |
| `hysteresisPct` | `0.2` | 滞回：`count ≥ quota·(1+hysteresisPct)` 才触发 |
| `targetPct` | `0.8` | 触发后裁到 `floor(quota·targetPct)` |

### 流程

```
Phase 0 — 衰减回写（weightDecayHalfLifeDays > 0 时）
  把事件、实体与边的 weight 折算为 effW 写回存储，并把 lastReinforcedAt 刷新为当前时间

Phase 1 — 孤儿即删
  ∀ node ∈ persons ∪ events ∪ entities:
    if (无任何 edge 引用 node.id) ⇒ deleteCascade(node)

Phase 2 — 超额淘汰（persons / events / entities 各跑一次）
  if count < quota · (1 + hysteresisPct): skip
  toDelete = count − floor(quota · targetPct)
  sort by evictScore DESC
  delete first toDelete

Phase 3 — 边超额
  if edges.length ≥ quota_edge · (1 + hysteresisPct):
    sort by (effW · 端点 PR 平均) ASC, delete toDelete

Phase 4 — 收尾
  再次清理孤儿；把 PageRank 与社群标签（communityAlgorithm）写回三类节点
```

### 评分函数

$$
\text{ageScore}(n) = \frac{\text{now} - n.\text{lastReinforcedAt}}{\max(\text{effW}(n),\,0.05)\ \cdot\ \max(\text{PR}(n),\,10^{-6})\ \cdot\ \big(1 + \ln(1 + |n.\text{evidence}|)\big)}
$$

`effW(n)` 为 `weight` 经半衰期衰减后的有效值（由配置 `weightDecayHalfLifeDays` / `weightDecayFloor` 控制）；evidence 数量只作软加权，不构成豁免。`PR(n)` 为 `computePageRank` 在当前 snapshot 上的个性化 PageRank 值，种子向量按 `kind` 分配 `(personSeed, entitySeed, eventSeed)`。人物节点无 weight / evidence，按 `(now − lastMentionedAt) / (mentionCount · PR)` 排序。

**事件特有 — naked tier**：

$$
\text{isNaked}(\text{ev}) = \big(\#\{\text{event-entity 边, relationType=part-of}\} = 0\big) \;\land\; \big(\forall\,p_i,p_j \in \text{participants}(\text{ev}): \neg \text{personPersonEdgeExists}(p_i,p_j)\big)
$$

$$
\text{eventEvictScore}(\text{ev}) =
\begin{cases}
\text{ageScore}(\text{ev}) + \frac{\text{MAX\_SAFE\_INT}}{2} & \text{isNaked}(\text{ev}) \\
\text{ageScore}(\text{ev}) & \text{otherwise}
\end{cases}
$$

含义：**没有通过 `part-of` 挂到任何实体、参与者之间也没有人际关系边的事件，强制排在淘汰队列最前**。用 `MAX_SAFE/2` 作绝对分桶而不是相对加权，是为了在毫秒级测试 / 小图场景下也能稳定区分，不被 ageScore 量级差吞掉。

**实体淘汰**：直接按 `ageScore` 倒排，无 naked tier。

---

## 2. Consolidate 公式

触发：
- 自动：每次提取完成后，若 `evictionEnabled` 开启、至少配置了一项配额，且 `isOverQuota` 判定已达到淘汰触发阈值（即下一次 `evictByQuota` 会实际删除节点或边），`RelationExtractor` 先运行一次 consolidate，再执行 `evictByQuota`（consolidate 这一步受 `consolidateAfterEviction` 开关控制；trigger = `'eviction'`）
- 手动：`/relation consolidate`、`/relation maintain` 指令（trigger = `'manual'`）；其它代码直接调用 `service.consolidate()` 时 trigger 默认为 `'api'`。上次运行的触发来源可用 `getLastConsolidateInfo()` 查询

**没有定时调度**。无 setInterval / cron / scheduler 注册。

整理里的模型调用（别名、事件核验，层级与父实体推断，摘要重写）与实体、事件的向量化接本插件这次激活的中止信号：停用、停机时停在当前这一步、抛中止原因，之前做完的写入留着；写图都在这一步的模型调用或向量化之后，每一步要么做完要么没做。淘汰前的整理被中止时不告警，也不接着淘汰。停用、停机时，收尾段等在途的提取（连同其后的整理与老化）与在途的整理、事件查重、淘汰与孤儿清理（`/relation` 指令、工具与抽取器调进来的都在内）、改名同步落定再撤回：已经开始的写入写完，之后不再有写入。收尾开始之后不再发起新的整理、事件查重、淘汰、孤儿清理与改名同步，几步连着做的停在已发起的那一步：`/relation maintain` 回已中止，提取之后不再接着老化。

主要工作：
1. **遗留边整理**（计入 `eventEdgesNormalized`）：同一 (person, event) 按吸收规则折叠；同一 (person, entity) 只保留最强 role；同一 (event, entity) 只保留强度最高的关系（part-of > related > about），其余边的 evidence 并入保留边后删除
2. **实体层级推断**（`entityHierarchyCandidates` / `entityHierarchyEdgesCreated`）：实体 A 的规范名是 B 的真子串（A 至少 3 个字符，且两者之间尚无 entity-entity 边）时，A 记为 B 的父实体候选。配置了 `consolidationModel` 时经 `inferEntityHierarchy` 核验后建 `part-of` 边（不受 `autoLink` 限制）；未配置时只统计候选
3. **别名合并**：name/aliases 归一后完全相同的实体记为别名候选；`autoLink` 开启且配置了 `consolidationModel` 时，先经 `verifyAliasPair` 核验，同意才建 `is-alias-of` 边并 `mergeAlias`（留下的一方按合并分挑），否决则不合并并记入否决缓存，判定为上下位则改建 `part-of` 边，模型调用失败的（出错、限流、模型插件重载）这次跳过、不记否决，下次整理再判（事件核验同样）；未配置整理模型时只统计候选、不改图。`autoLink` 与 LLM 同时启用时，还会做宽召回别名核验、事件重复合并、兄弟实体共同父实体推断和合并后摘要重写。经模型核验真合并后留下的实体在库里标上待重写摘要（`summaryStale`），重写写成时去掉；重写没成的（中止、模型失败或回空）下次整理补写

---

## 3. Alias / 合并规则

### 触发路径

- `personPersonEdges` 含 `relationType ∈ {is-alias-of, alt-account-of}` ⇒ `mergeAlias({kind: 'person'})`
- `entityEntityEdges` 含 `relationType = is-alias-of` ⇒ `mergeAlias({kind: 'entity'})`
- `eventEventEdges` 含 `relationType = is-alias-of` ⇒ `mergeAlias({kind: 'event'})`
- consolidate 跑同名核验也走 `mergeAlias`

### 合并语义 (`mergeAlias`)

1. 方向：留下的一方由调用方定。提取按模型给的边方向（`A is-alias-of B` 即 A 并进 B），整理在没有方向时（严格等价、宽召回与事件重复合并）按合并分（`pickCanonicalByMergeScore`）挑，会话里与全局事件同名的事件并进全局事件，`user_relation_merge_nodes` 工具按调用方指定的 canonical；任一端已不在图里时什么都不改
2. 仅 entity / event：`canonical.aliases ← uniq(canonical.aliases ∪ {alias.name 或 alias.title} ∪ alias.aliases) \ {canonical 名称}`；PersonNode 没有 `aliases` 字段，person 合并不保留被合并方的昵称
3. 所有引用 `alias.id` 的边 ⇒ rewire 到 `canonical.id`
4. 删除 `alias` 节点
5. 节点层面不保留合并记录，合并不可逆（经 `user_relation_merge_nodes` 工具合并时会在日志中写一条审计记录）

### 大号 / 小号

`alt-account-of` 走的是合并通道，不是层级通道。

- LLM extractor 输出 `personPersonEdges: { relationType: 'alt-account-of', directed: true }`（A 是 B 的小号）
- service 在新建该边时立即调用 `mergeAlias({kind: 'person'})`：照边的方向把小号 A 并进大号 B，被合并账号的边 rewire 到 B，并删除 A 的 PersonNode
- PersonNode 没有 `aliases` 字段，被合并方的昵称不保留
- **结果：图里只剩一个 PersonNode，不会出现"主-从"两个节点**

因此大号/小号不会表达为 `hierarchy`，而是在别名合并阶段就合为同一节点。

---

## 4. Rename / 节点改名风险盘点

| 字段 | 用作 key？ | rename 安全性 |
|---|---|---|
| `PersonNode.displayName` | 否（key = `person:{platform}:{userId}`） | 引用层完全安全 |
| `EventNode.title` | 否（key = `event:{uuid}`） | 引用层完全安全 |
| `EntityNode.name` | 否（key = `entity:{uuid}`） | 引用层完全安全 |

业务层风险（**与引用完整性无关**）：

1. `PersonNode.displayName` 是平台昵称，由入站消息归档时携带的昵称同步（见 `rename-watcher.ts`）。LLM 改它会与平台实际昵称脱节。**禁改**：类型层即 `renameNode({kind: 'event'|'entity', ...})` 不接受 `'person'`，工具层额外拦截 `id` 含 `:` 的 person key。
2. `Event/Entity` 改名通过 `service.renameNode` / 工具 `user_relation_rename_node`：
   - 原 `title` / `name` **自动**进 `aliases`（去重），旧名仍可被搜索命中；
   - 写入 `nameHistory: NodeNameAudit[]`（`{from, to, at, by, reason}`），无静默改名；
   - `key`/`id` 不变，引用边不受影响。
3. 工具描述里强制要求 `reason`（≤80 字），LLM 必须给出改名理由 → 防止"风格化"反复改。

### LLM 工具：`user_relation_rename_node`

| 参数 | 必填 | 说明 |
|---|---|---|
| `node_id` | 是 | event / entity 的 UUID（带 `:` 的 person key 直接被拒） |
| `new_name` | 是 | 新 title / name，≤80 字符，与原名不同（同名 = no-op，不写 audit） |
| `reason` | 是 | 改名理由 |

同名拆物（一个名字承载两类含义、需要拆成两个节点）**不在 rename 范围**，目前也没有对应工具；`user_relation_split_alias` 只从 entity 的 `aliases` 中移除误绑的别名，不会重建节点。

---

## 5. Person-Person `hierarchy` 维度（与 `directed` 正交）

`PersonPersonEdge` 同时携带两个独立维度：

| 维度 | 取值 | 语义 |
|---|---|---|
| `directed` | `true` / `false` | **声明方向**：`true` = A 单方面声明与 B 有此关系（B 不一定认同）；`false` = 对称关系，A→B 与 B→A 视为同一条边。提取提示词要求 person-person 边一律填 `true`，双向关系由双方各写一条 `true` 边表达；未填时 `addPersonPersonEdge` 默认取 `true` |
| `hierarchy` | `superior` / `peer` / `subordinate` / `unknown` | **从 `fromPerson` 视角看的上下位**：A 视 B 为上 / 平 / 下 / 不明 |

**关键：不要用 `relationType` 文本去暗示层级**（如 "mentor" 不自动 = superior，因为方向取决于谁是 from）。

### 例

| 自然语言 | from | to | relationType | directed | hierarchy |
|---|---|---|---|---|---|
| "X 是我师傅" (说话人=A) | A | X | mentor | true | superior |
| "X 是我徒弟" (说话人=A) | A | X | mentor | true | subordinate |
| "我和 X 是同学" (说话人=A) | A | X | classmate | true | peer |
| "B 是我朋友" (说话人=A，B 是否认同未知) | A | B | friend | true | peer |

### 合并规则（addPersonPersonEdge）

新观察给出具体值（非 `unknown`）时一律采用新值；新观察为 `unknown` 或未填时保留已有值：

$$
\text{hierarchy}_{\text{merged}} = \begin{cases}
\text{hierarchy}_{\text{new}} & \text{if } \text{hierarchy}_{\text{new}} \notin \{\text{unknown}, \emptyset\} \\
\text{hierarchy}_{\text{old}} & \text{otherwise（old 为空时取 new）}
\end{cases}
$$

这样模糊判断可以升级为具体判断，也不会被后续没有信息量的观察抹平。

### 大号 / 小号 ≠ hierarchy

大号 / 小号是**同一人**的两个账号，走 `is-alias-of` / `alt-account-of` → `mergeAlias({kind: 'person'})`，把 alias 账号的边重写到 canonical，并删除 alias 账号的 PersonNode。**不要**用 `hierarchy: superior` 表达"大号是小号的主人"，那是别名问题不是层级问题。

---

## 6. 配置

配置 schema 定义在 `packages/plugin-user-relation/src/index.ts`（`configSchema`）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `extractionEnabled` | boolean | `true` | 从对话中提取新关系：关闭后不再从对话中提取新的人物、事件与关系；已有的关系照常注入，也照常能查、能删。 |
| `triggerEveryNMessages` | number | `20` | 自动触发阈值：每会话累计 N 条入站消息后自动执行一次模型提取。0=关闭自动提取。 |
| `readWindowSize` | number | `30` | 提取读取窗口大小：每次提取读取的最近消息数。建议略大于自动触发阈值（如阈值 20、窗口 30），让相邻两次提取读到的消息有一段重叠 |
| `mode` | select | `'incremental'` | 提取模式：「增量窗口」每次读固定窗口；「全量累积」一次性读所有累积的消息（注意上下文上限） |
| `allNewMaxMessages` | number | `200` | 全量累积模式的最大消息数：仅「提取模式」选「全量累积」时生效；硬上限，防止超出上下文 |
| `readScope` | select | `'same-session'` | 提取读取范围：每次提取从哪些会话取消息。跨会话读取需要记忆后端支持，不支持时只取当前会话。 |
| `crossSessionMaxAgeMinutes` | number | `60` | 跨会话拉取最大时间窗口（分钟）：跨会话读取时只取最近 N 分钟内的消息。0=不限 |
| `candidateEventDays` | number | `7` | 候选事件回溯天数：提取时把最近 N 天的活跃事件作为候选清单交给模型，避免重复创建同名事件 |
| `candidateEventLimit` | number | `20` | 候选事件最大数量：控制 prompt 体积 |
| `senderNeighborhoodEdgeLimit` | number | `8` | 候选人 1 跳邻居展示上限：提取时，对窗口内每位已知发言人附带其 1 跳邻居子图（已关联的事件/实体/人际关系，按权重降序），上限条数。0 = 关闭 |
| `extractionModel` | llm-ref | — | 提取使用的模型：建议挑一个具备 chat 能力的便宜模型；留空则使用默认的对话模型 |
| `extractionDisableThinking` | boolean | `true` | 提取：禁用思考模式：开启时提取用模型最浅的思考档（能关闭思考的模型即关闭），免得思考占满输出、返回空内容；模型不能调思考时不起作用。默认开启 |
| `consolidationModel` | llm-ref | — | 整理使用的模型：整理关系图用的模型，用来核验别名、推断实体层级与重写合并后的摘要。留空时整理只规整旧边，别名与层级只统计候选、不改图。 |
| `consolidationDisableThinking` | boolean | `true` | 整理：禁用思考模式：同「提取：禁用思考模式」，作用于整理用的模型。默认开启 |
| `consolidationAutoLink` | boolean | `false` | Consolidate autoLink：开启且配置了整理模型时，经模型核验后自动合并别名、建层级边；没配整理模型时只统计候选、不改图。 |
| `consolidationSkipLowScorePairs` | boolean | `true` | 整理：跳过低分候选：开启时，两端综合分都低于阈值的别名候选不交给模型核验，以节省模型调用。默认开启。 |
| `consolidationLowScoreThreshold` | number | `0.2` | 整理：低分阈值：综合分低于这个值算低分，取 0 到 1，默认 0.2。设 0 即不跳过；只在开启「整理：跳过低分候选」时生效。 |
| `consolidateAfterEviction` | boolean | `true` | 淘汰前自动整理：自动淘汰前先整理一次关系图（去重、规整边、推断层级），再执行淘汰。 |
| `evictionEnabled` | boolean | `true` | 启用自动老化：每次提取后检查关系图。四类上限都为 0 时只删孤立节点；配了上限时，某类达到上限 ×(1+「淘汰滞回」) 才删孤立节点，并把达到的各类删到上限 ×「淘汰回落目标」，先删最旧、最不重要的。 |
| `maxPersons` | number | `1500` | 人物总数上限：超出时先删久未被提及、提及次数少、不重要的人物。0=不限。 |
| `maxEvents` | number | `2500` | 事件总数上限：超出时先删久未强化、权重低、不重要的事件。0=不限。 |
| `maxEntities` | number | `1500` | 实体总数上限：同上策略。0=不限。 |
| `maxEdges` | number | `10000` | 边总数上限：超出时保留权重与两端节点重要性最高的边。0=不限。 |
| `pagerankDamping` | number | `0.85` | PageRank 阻尼系数：淘汰打分用。常用 0.85。 |
| `pagerankIterations` | number | `20` | PageRank 最大迭代次数：20 通常够用；图较大、邻接稠密可调到 30~50。 |
| `pagerankEpsilon` | number | `0.0001` | PageRank 收敛阈值：L1 误差小于该值即提前停止迭代。 |
| `communityAlgorithm` | select | `'louvain'` | 社群发现默认算法：按配额清理关系图之后用来划分社群的算法，也是查看社群概况时的默认算法。louvain 最快；leiden 保证社群内部连通；slpa 允许一个人属于多个社群。 |
| `evictHysteresisPct` | number | `0.2` | 淘汰滞回 (0~1)：数量达到上限的 (1+该值) 倍才开始淘汰，如上限 500、该值 0.2 时到 600 才淘汰，避免每写一条就删一条。 |
| `evictTargetPct` | number | `0.8` | 淘汰回落目标 (0~1)：开始淘汰后删到上限的这个比例为止。如上限 500、滞回 0.2、该值 0.8 时，到 600 开始淘汰，一次删到 400。 |
| `weightDecayHalfLifeDays` | number | `180` | 权重时间衰减半衰期（天）：淘汰与排序时，权重随多久没被强化而衰减，每过这么多天减半。0 = 不衰减。 |
| `weightDecayFloor` | number | `0.3` | 权重衰减下限因子 (0~1)：衰减后的权重不低于原权重的这个比例。默认 0.3。 |
| `agentInjection` | boolean | `true` | 向 agent 注入关系上下文：把当前发言者的关系图速览注入提示词，放在历史之后、当前消息之前 |
| `injectionMaxDepth` | number | `2` | 注入：BFS 最大深度：0=仅起点；1=直接邻居；2=同事件其他参与者 / 朋友的朋友。token 敏感，默认 2 |
| `injectionMaxBreadth` | number | `10` | 注入：单节点展开邻居上限：按 weight 降序展开。默认 10 |
| `maxInjectedEvents` | number | `5` | 注入：事件条数上限 |
| `maxInjectedRelations` | number | `8` | 注入：人际关系条数上限 |
| `maxParticipantsPerEvent` | number | `5` | 注入：每事件展示参与者数：超出会显示 +N 人。默认 5 |
| `maxCooccurrencePartners` | number | `5` | 注入：共现伙伴展示数：基于事件桥统计的隐式二跳；0 关闭该小节 |
| `maxGlobalHotEvents` | number | `5` | 注入：全局热点事件数：与当前用户无关，全图最近被提及的事件；0 关闭 |
| `maxGlobalHotEntities` | number | `5` | 注入：全局热点实体数：与当前用户无关，全图最近被提及的实体；0 关闭 |
| `groupOnly` | boolean | `false` | 仅在群聊中注入：私聊一般无需关系图上下文。按会话管理记下的聊天窗口判，根会话（子会话取根会话的）的窗口是多方才注入：OneBot 的群与频道、第三方平台声明的多方类型都算，owner 从 WebUI 往群里插话的一轮也算；WebUI、终端会话不算，不看消息带不带群号。会话管理不在时判不出，不注入 |
| `toolsEnabled` | boolean | `true` | 向 Agent 暴露 dig 工具：允许模型调用关系图工具：检索、分析、社群，以及改名、修边、删除、合并等写工具 |
| `commandsEnabled` | boolean | `true` | 注册 /relation 指令：注册 /relation 指令，用于查看、清理与整理关系图；cleanup、consolidate 等维护指令需 owner 授予 |
| `strictSelfAssertion` | boolean | `true` | 严格自证模式：开启时，人际关系只记在说过那句原话的人名下：至少要有一条证据是关系发起方本人说的。 |
| `digToolDefaultMaxDepth` | number | `2` | dig 工具：默认深度 |
| `digToolDefaultMaxBreadth` | number | `8` | dig 工具：默认宽度 |
| `digToolHardMaxDepth` | number | `4` | dig 工具：硬上限深度：Agent 传入更大值会被截断 |
| `digToolHardMaxBreadth` | number | `20` | dig 工具：硬上限宽度 |
| `findPathDefaultMaxDepth` | number | `4` | find_path 默认深度 |
| `findPathHardMaxDepth` | number | `6` | find_path 硬上限 |
| `searchEventsDefaultLimit` | number | `10` | search_events 默认条数 |
| `searchEventsHardMaxLimit` | number | `50` | search_events 条数硬上限 |
| `graphSpacing` | number | `120` | 关系图疏密：关系图布局的理想边长（像素），越大越稀疏，建议 60 到 250；超出 20 到 1000 时按默认 |
| `debug` | boolean | `false` | 调试日志：开启后会输出提取/工具调用的详细日志 |

表中略去的细节：

- `extractionEnabled` 是写入的总开关，只停提取；要彻底不用，停用整个插件。
- `mode`：取值 `incremental`（增量窗口）与 `all-new`（全量累积）。
- `readWindowSize`：相邻两次提取重叠 10 条左右，模型能跨批次稳定认出同一事件与关系。
- `readScope`：取值 `same-session`（仅当前会话）、`same-platform`（同平台跨会话）、`cross-platform`（全平台跨会话）。跨会话读取时每行消息带 `[sid:<会话>]` 前缀，证据按每条消息真实的来源会话记录。same-platform 适合识别跨群共享的话题，cross-platform 适合识别跨平台的同一用户或同一事件。跨会话读取要求记忆后端实现 `getRecentMessagesAcrossSessions`。
- `extractionDisableThinking`：提取是结构化输出任务，思考型模型（如 deepseek-v4-flash）开着思考时可能把 token 预算全花在推理上、返回空内容。
- `consolidationModel` 用于 `/relation consolidate`、`/relation maintain` 与淘汰前的自动整理，做三件事：别名候选的语义核验、合并后摘要重写、实体层级推断（见第 2 节）。推荐选上下文大的模型（如 GPT-4o、Claude Opus）。
- `consolidationSkipLowScorePairs` 与 `consolidationLowScoreThreshold` 只作用于宽召回阶段的别名候选。综合分即节点的 `compositeScore`，两端都低于阈值说明两端都在 edge 档，合并价值低；默认阈值 0.2 与分档（`scoreToTier`）里 edge 档的边界一致。
- `consolidateAfterEviction` 的顺序与 `/relation maintain` 一致：先整理再淘汰，PageRank 在去重后的图上算，入出度更完整。
- `evictionEnabled`：孤立节点指没有任何边的节点；配了上限时，没到触发线既不整理也不淘汰。没有硬豁免，重要性完全由 PageRank、权重衰减与被提及次数（`mentionCount`）决定；人物、事件、实体与边的排序公式见第 1 节。
- `communityAlgorithm`：算出的社群写进节点的社群缓存，`user_relation_community_peers` 与 `user_relation_community_bridge` 读它；`user_relation_community_overview` 不传 `algorithm` 时用这里的算法，模型调用时可以临时传 `algorithm` 换一个。louvain 是经典的硬划分；leiden 是 Louvain 加上内部连通性修正（refinement）；slpa 即 Speaker-Listener Label Propagation，原生重叠社区，跨群人物能有多个社群隶属度。
- `evictTargetPct`：触发后裁到 `floor(上限 × 该值)`，取值限在 0.1 到 1。
- `weightDecayHalfLifeDays` 与 `weightDecayFloor`：衰减后的权重 `effW = raw × max(0.5^(天数/halfLife), floor)`。长期不被强化的高权重节点因此逐渐让出保护名额；下限保留"老朋友"的底色，不至于完全忘掉。
- `maxGlobalHotEvents` 与 `maxGlobalHotEntities` 按全图的 `lastMentionedAt` 排序。
- `toolsEnabled`：工具名为 `user_relation_*`。写工具带保护门，1 级起能用，不逐次确认：改的是她自己的记忆，不碰本机文件也不对外；一轮里混进做不了的人时，执行守卫照逐动作判定单独审批这一个调用。
- `commandsEnabled`：`show`、`orphans`、`forget-me` 与 `consolidation-status` 公开；`cleanup`、`consolidate`、`rewrite-weights`、`event-duplicates`、`compress` 与 `maintain` 为 restricted，需 owner 授予。
- `strictSelfAssertion` 只约束人物之间的边：证据里至少一条消息（`evidence.messageId`）的发言者是 from 方本人。无论开关，人物之间的边的 to 方都须已有人物节点，免得留下孤儿边。

## 7. WebUI 页面

插件详情里有两页，数据源与删除动作直接用本次激活的 `RelationService`：

- **人物关系图**（`key: 'user-relation'`）：一张全图。节点分人物、事件、实体三类，边按六种 kind 分类，取色用分类色（不写死颜色，随主题变）；疏密取 `graphSpacing`。选中一个节点，详情里是它的属性与连着它的关系（对端、关系、权重、最近强化、最新证据）。引用了缺失节点的边不画，记一条告警。
- **关系图原始数据**（`key: 'user-relation-raw'`）：人物、事件、实体三个标签各一张表，行动作「删除」（确认框，连同相关的边）。删除前先核节点在且种类对，找不到时回错误；删除后两页都重取。

抽取写入的变化不推送，靠打开时取一次与手动刷新。
