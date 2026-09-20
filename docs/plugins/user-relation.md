# `plugin-user-relation`：关系图

**包名**: `@aalis/plugin-user-relation`  
**源码**: `packages/plugin-user-relation/src/index.ts`

## 概述

用 LLM 从对话中提取人物、事件、实体及其关系，维护一张人物关系图。每个会话累计 `triggerEveryNMessages` 条入站消息后自动提取一次；开启 `agentInjection` 时，把当前用户的子图速览经 `agent:prompt` 贡献点的 `turn-context` 槽注入。另提供 Agent 工具、`/relation` 指令与 WebUI 页面，并以 type `user-relation` 参与 `memory:clear`（仅 scope 为 all 时清空整张图）。字段与术语对照见 [关系图 · 字段含义速查](./user-relation-graph.md)。

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
    platform: optional(platform),
    tools: optional(tools),
    commands: optional(commands),
    webui: optional(webuiServer),
    embedding: optional(embedding),
    agent: optional(agent),
  },
  apply(caps) { /* 见源码 */ },
});
```

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

开始前先删除伪 person：platform 不在当前平台白名单内（白名单为空时不按此判据），或 userId 为通用占位（如 `self` / `bot`）的人物节点，连同其边一并删除。

主要工作：
1. **旧账边整理**（计入 `eventEdgesNormalized`）：同一 (person, event) 按吸收规则折叠；同一 (person, entity) 只保留最强 role；同一 (event, entity) 只保留强度最高的关系（part-of > related > about），其余边的 evidence 并入保留边后删除
2. **实体层级推断**（`entityHierarchyCandidates` / `entityHierarchyEdgesCreated`）：实体 A 的规范名是 B 的真子串（A 至少 3 个字符，且两者之间尚无 entity-entity 边）时，A 记为 B 的父实体候选。配置了 `consolidationModel` 时经 `inferEntityHierarchy` 核验后建 `part-of` 边（不受 `autoLink` 限制）；未配置时，`autoLink` 开启则只在 B 的名称以 A 开头时建边，关闭则只统计候选
3. **别名合并**：name/aliases 归一后完全相同的实体记为别名候选；仅在 `autoLink` 开启时建 `is-alias-of` 边并 `mergeAlias`。配置了 `consolidationModel` 时，合并前先经 `verifyAliasPair` 核验：否决则不合并并记入否决缓存；判定为上下位则改建 `part-of` 边。`autoLink` 与 LLM 同时启用时，还会做宽召回别名核验、事件重复合并、兄弟实体共同父实体推断和合并后摘要重写

---

## 3. Alias / 合并规则

### 触发路径

- `personPersonEdges` 含 `relationType ∈ {is-alias-of, alt-account-of}` ⇒ `mergeAlias({kind: 'person'})`
- `entityEntityEdges` 含 `relationType = is-alias-of` ⇒ `mergeAlias({kind: 'entity'})`
- `eventEventEdges` 含 `relationType = is-alias-of` ⇒ `mergeAlias({kind: 'event'})`
- consolidate 跑同名核验也走 `mergeAlias`

### 合并语义 (`mergeAlias`)

1. 方向校正：依次比较 aliases 数量（仅 entity 计入）、名称长度（entity 取 `name`，event 取 `title`，person 取 `displayName`）、引用该节点的边上 evidence 总数，得分高者为 canonical，持平时保持调用方指定的方向（见 `utils.ts` 的 `chooseCanonicalDirection`）；`user_relation_merge_nodes` 工具关闭方向校正（`noCanonicalCorrection`），按调用方指定的 canonical 合并
2. 仅 entity / event：`canonical.aliases ← uniq(canonical.aliases ∪ {alias.name 或 alias.title} ∪ alias.aliases) \ {canonical 名称}`；PersonNode 没有 `aliases` 字段，person 合并不保留被合并方的昵称
3. 所有引用 `alias.id` 的边 ⇒ rewire 到 `canonical.id`
4. 删除 `alias` 节点
5. 节点层面不保留合并记录，合并不可逆（经 `user_relation_merge_nodes` 工具合并时会在日志中写一条审计记录）

### 大号 / 小号

`alt-account-of` 走的是合并通道，不是层级通道。

- LLM extractor 输出 `personPersonEdges: { relationType: 'alt-account-of', directed: true }`（A 是 B 的小号）
- service 在新建该边时立即调用 `mergeAlias({kind: 'person'})`：先按启发式校正方向（displayName 较长者为 canonical，等长时比较相关边的 evidence 总数），再把被合并账号的边 rewire 到 canonical，并删除被合并的 PersonNode
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
| `extractionEnabled` | boolean | `true` | 允许从对话中提取新关系（写入总开关）：**写入总开关**：关闭后插件停止生成任何新关系节点/边（自动触发、手动 /relation extract、Agent upsert_* 工具全部失效）；但 middleware 仍读取并注入旧关系、actions 仍可查/删。若只想停掉"自动触发"而保留手动命令，请用 triggerEveryNMessages=0 而非关此项。彻底卸载请整体停用该插件。 |
| `triggerEveryNMessages` | number | `20` | 自动触发阈值（每 N 条消息）：**仅控制"自动触发"**：每会话累计 N 条入站消息后自动跑一次 LLM 提取。0=**仅手动**（slash 命令 /relation extract 仍可触发，Agent 工具仍可用——与 extractionEnabled 不同）。 |
| `readWindowSize` | number | `30` | 提取读取窗口大小：每次提取时回读的最近消息数。建议略大于触发阈值（如阈值 20、窗口 30），让相邻批次窗口重叠 10 条左右、便于 LLM 跨批次稳定识别同一事件与关系 |
| `mode` | select | `'incremental'` | 提取模式：incremental: 固定窗口；all-new: 一次性读所有累积（注意 context 上限） |
| `allNewMaxMessages` | number | `200` | all-new 模式下的最大消息数：仅 mode=all-new 时生效；硬上限以防 context 溢出 |
| `readScope` | select | `'same-session'` | 提取读取范围：决定每次提取从哪些会话拉取消息送给 LLM： - same-session（默认）：只读当前 sessionId（同群/同私聊），证据 100% 在原 session 内； - same-platform：把同 platform 下所有会话最近消息合并送 LLM，每行带 [sid:xxx] 前缀，evidence 按真实来源记录；适合识别跨群共享话题； - cross-platform：跨所有平台聚合（同上），适合识别跨平台同一用户/同一事件。 跨会话模式仅在 memory 后端实现 getRecentMessagesAcrossSessions 时生效，否则自动降级到 same-session。 |
| `crossSessionMaxAgeMinutes` | number | `60` | 跨会话拉取最大时间窗口（分钟）：仅 readScope!=same-session 时生效；只取最近 N 分钟内的消息。0=不限 |
| `candidateEventDays` | number | `7` | 候选事件回溯天数：提取时把最近 N 天的活跃事件作为候选清单交给 LLM，避免重复创建同名事件 |
| `candidateEventLimit` | number | `20` | 候选事件最大数量：控制 prompt 体积 |
| `senderNeighborhoodEdgeLimit` | number | `8` | 候选人 1 跳邻居展示上限：提取时，对窗口内每位已知发言人附带其 1 跳邻居子图（已关联的事件/实体/人际关系，按权重降序），上限条数。0 = 关闭 |
| `extractionModel` | llm-ref | — | 提取使用的 LLM：建议挑一个具备 chat 能力的便宜模型；留空则使用默认 llm 服务 |
| `extractionDisableThinking` | boolean | `true` | 提取：禁用思考模式：提取是结构化输出任务，思考型模型（如 deepseek-v4-flash）开启思考后可能把 token budget 全花在 reasoning 上、返回空内容。默认禁用 |
| `consolidationModel` | llm-ref | — | Consolidate 使用的 LLM：可选。配置后 /relation.consolidate 与淘汰后自动整理会调用该模型做 (A) 别名候选语义核验、(B) 合并后摘要重写、(C) 实体层级推断。推荐选大上下文模型（如 GPT-4o、Claude Opus），留空则保持纯算法行为。 |
| `consolidationDisableThinking` | boolean | `true` | Consolidate LLM：禁用思考模式：同 extractionDisableThinking。默认禁用 |
| `consolidationAutoLink` | boolean | `false` | Consolidate autoLink：为 true 时自动合并别名实体、建层级边（结合 consolidationModel 可由 LLM 核验）；false 仅打印候选不动数据。 |
| `consolidationSkipLowScorePairs` | boolean | `true` | Consolidate：跳过低权候选 pair：启用后，宽召回阶段双方 compositeScore 均低于阈值的候选不送 LLM 核验（两端都是 edge tier，合并价值低）。默认启用以节省 LLM 调用。 |
| `consolidationLowScoreThreshold` | number | `0.2` | Consolidate：低权阈值：compositeScore 阈值（0~1，与 scoreToTier 的 edge 边界一致，默认 0.2）。设 0 等同关闭跳过；仅在 consolidationSkipLowScorePairs=true 时生效。 |
| `consolidateAfterEviction` | boolean | `true` | 淘汰时自动 consolidate：每次触发容量淘汰时，先自动运行一次 consolidate（去重 / 整理 / 层级推断），再执行淘汰。与 /relation maintain 顺序一致，使 PageRank 入出度更完整。 |
| `evictionEnabled` | boolean | `true` | 启用自动老化：每次提取完成后扫一遍当前图：先删孤儿节点（无任何边），再按"超出配额"逐项删除"老旧 + 低权重 + PageRank 边缘"的人物/事件/实体/边。不再有硬豁免，重要性完全由 PageRank 、weight 衰减与 mentionCount 表达。配额设为 0 则允许该类节点无限增长。 |
| `maxPersons` | number | `1500` | 人物总数上限：超过则按 (now - lastMentionedAt) / (mentionCount · PR) 排序，先删老旧低活跃人物。0=不限（允许人物无限增长）。 |
| `maxEvents` | number | `2500` | 事件总数上限：超过则按 (now - lastReinforcedAt) / weight 排序，先删老旧低权重事件。0=不限。 |
| `maxEntities` | number | `1500` | 实体总数上限：同上策略。0=不限。 |
| `maxEdges` | number | `10000` | 边总数上限：超过则保留 weight · 端点PR平均 最高的边。0=不限。 |
| `pagerankDamping` | number | `0.85` | PageRank 阻尼系数：淘汰打分用。常用 0.85。 |
| `pagerankIterations` | number | `20` | PageRank 最大迭代次数：20 通常够用；图较大、邻接稠密可调到 30~50。 |
| `pagerankEpsilon` | number | `0.0001` | PageRank 收敛阈值：L1 误差小于该值即提前停止迭代。 |
| `communityAlgorithm` | select | `'louvain'` | 社群发现默认算法：evictByQuota 之后顺手跑的社群发现算法。louvain=经典快、硬划分；leiden=Louvain + 内部连通性 refinement；slpa=Speaker-Listener Label Propagation，原生重叠社区（跨群人物能获得多个社群隶属度）。agent 调 community_* 工具时可临时指定 algorithm 参数覆盖此默认。 |
| `evictHysteresisPct` | number | `0.2` | 淘汰滞回 (0~1)：count &gt; quota·(1+该值) 才触发淘汰；设为 0.2 时，quota=500 在 600 触发。用以避免"写一条删一条"。 |
| `evictTargetPct` | number | `0.8` | 淘汰回落目标 (0~1)：触发后裁到 floor(quota·该值)；配合 hysteresisPct=0.2 与该值=0.8，单次裁 ~40% quota（quota=500 → 一次裁 ~200 条）。 |
| `weightDecayHalfLifeDays` | number | `180` | Weight 时间衰减半衰期（天）：淘汰/排序时把 weight 按半衰期折算：effW = raw × max(0.5^(天数/halfLife), floor)。让长期不被强化的"老高 weight"自动让出保护名额。0 = 关闭衰减。 |
| `weightDecayFloor` | number | `0.3` | Weight 衰减下限因子 (0~1)：effW 不会低于 raw × 该值。保留"老朋友"底色，避免完全失忆。默认 0.3。 |
| `agentInjection` | boolean | `true` | 向 agent 注入关系上下文：把当前用户的子图速览作为 agent:prompt 贡献注入（turn-context 槽，历史之后、当前消息之前） |
| `injectionMaxDepth` | number | `2` | 注入：BFS 最大深度：0=仅起点；1=直接邻居；2=同事件其他参与者 / 朋友的朋友。token 敏感，默认 2 |
| `injectionMaxBreadth` | number | `10` | 注入：单节点展开邻居上限：按 weight 降序展开。默认 10 |
| `maxInjectedEvents` | number | `5` | 注入：事件条数上限 |
| `maxInjectedRelations` | number | `8` | 注入：人际关系条数上限 |
| `maxParticipantsPerEvent` | number | `5` | 注入：每事件展示参与者数：超出会显示 +N 人。默认 5 |
| `maxCooccurrencePartners` | number | `5` | 注入：共现伙伴展示数：基于事件桥统计的隐式二跳；0 关闭该小节 |
| `maxGlobalHotEvents` | number | `5` | 注入：全局热点事件数：与当前用户子图无关，按全局 lastMentionedAt 排序的最近事件；0 关闭 |
| `maxGlobalHotEntities` | number | `5` | 注入：全局热点实体数：与当前用户子图无关，按全局 lastMentionedAt 排序的最近实体；0 关闭 |
| `groupOnly` | boolean | `false` | 仅在群聊中注入：私聊一般无需关系图上下文 |
| `toolsEnabled` | boolean | `true` | 向 Agent 暴露 dig 工具：允许 LLM 主动调用：expand_person / find_path / search_events / upsert_* / link / unlink |
| `commandsEnabled` | boolean | `true` | 注册 /relation 指令：注册 show / orphans / cleanup 系列指令（cleanup 需 authority ≥ 3） |
| `strictSelfAssertion` | boolean | `true` | 严格自证模式：开启后，提取/工具只允许把关系归到「说过那条原话的人」名下：每条人-* 边必须有 evidence，且至少一条 evidence.messageId 对应消息的发言者 == fromPersonId；agent 工具调用 link/upsert_person 时 from 必须 == 当前发言者。person-person 边的 to 必须已存在 PersonNode。 |
| `digToolDefaultMaxDepth` | number | `2` | dig 工具：默认深度 |
| `digToolDefaultMaxBreadth` | number | `8` | dig 工具：默认宽度 |
| `digToolHardMaxDepth` | number | `4` | dig 工具：硬上限深度：Agent 传入更大值会被截断 |
| `digToolHardMaxBreadth` | number | `20` | dig 工具：硬上限宽度 |
| `findPathDefaultMaxDepth` | number | `4` | find_path 默认深度 |
| `findPathHardMaxDepth` | number | `6` | find_path 硬上限 |
| `searchEventsDefaultLimit` | number | `10` | search_events 默认 limit |
| `searchEventsHardMaxLimit` | number | `50` | search_events 硬上限 limit |
| `debug` | boolean | `false` | Debug 日志：开启后会输出提取/注入/工具调用的详细日志 |
