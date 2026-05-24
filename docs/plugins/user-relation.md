# `plugin-user-relation`：关系图

存储基于 `MemoryService.saveMetadata`（namespace `user-relation`），key schema：

| 前缀 | 形式 | 说明 |
|---|---|---|
| `person:` | `person:{platform}:{userId}` | `PersonNode`；key 与 `name` 完全解耦，rename name 不影响引用 |
| `event:` | `event:{uuid}` | `EventNode` |
| `entity:` | `entity:{uuid}` | `EntityNode` |
| `edge:` | `edge:{uuid}` | `RelationEdge`（`kind` 决定具体子型） |

边的 `from*` / `to*` 永远引用 key/id，**不引用 name**。

---

## 1. 淘汰公式 (`evictByQuota`)

入参 quota 形状（关键默认值）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxEvents` / `maxEntities` / `maxEdges` | — | 各类容量上限；为 `0` 跳过该类 |
| `protectEvidenceCount` | `3` | `evidence.length ≥ N` 进保护集，永不删 |
| `protectWeight` | `0.8` | `weight ≥ X` 进保护集 |
| `pagerankDamping` / `Iterations` / `Epsilon` | `0.85` / `20` / `1e-4` | PageRank 收敛参数 |
| `personSeed` / `entitySeed` / `eventSeed` | `3` / `2` / `1` | 个性化向量种子权（重要性 人>物>事 内嵌） |
| `hysteresisPct` | `0.2` | 滞回：`count ≥ quota·(1+hysteresisPct)` 才触发 |
| `targetPct` | `0.8` | 触发后裁到 `floor(quota·targetPct)` |

### 流程

```
Phase 1 — 孤儿即删
  ∀ node ∈ events ∪ entities:
    if (无任何 edge 引用 node.id) ∧ (¬ protected(node)) ⇒ deleteCascade(node)

Phase 2 — 超额淘汰（events / entities 各跑一次）
  remaining = filter(¬ protected)
  if remaining.length < quota · (1 + hysteresisPct): skip
  toDelete = remaining.length − floor(quota · targetPct)
  sort by evictScore DESC
  delete first toDelete

Phase 3 — 边超额
  if edges.length ≥ quota_edge · (1 + hysteresisPct):
    sort by weight ASC, delete toDelete
```

### 评分函数

$$
\text{protected}(n) = \big(|n.\text{evidence}| \ge \text{protectEvidenceCount}\big) \;\lor\; \big(n.\text{weight} \ge \text{protectWeight}\big)
$$

$$
\text{ageScore}(n) = \frac{\text{now} - n.\text{lastReinforcedAt}}{\max(n.\text{weight},\,0.05)\ \cdot\ \max(\text{PR}(n),\,10^{-6})}
$$

`PR(n)` 为 `computePageRank` 在当前 snapshot 上的个性化 PageRank 值，种子向量按 `kind` 分配 `(personSeed, entitySeed, eventSeed)`。

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

直觉：**纯人-人事件、且没挂到任何"物"上 → 强制排在淘汰队列最前**。用 `MAX_SAFE/2` 作绝对分桶而不是相对加权，是为了在毫秒级测试 / 小图场景下也能稳定区分，不被 ageScore 量级差吞掉。

**实体淘汰**：直接按 `ageScore` 倒排，无 naked tier。

### 保护集与孤儿互斥

`protected` 优先于 `孤儿即删`：即使没有任何边引用，只要 `evidence ≥ 3` 或 `weight ≥ 0.8`，也不会在 Phase 1 删掉。

---

## 2. Consolidate 公式

触发：
- `evictByQuota` 真的删了东西后，由 `RelationExtractor` 自动调用一次（受 `consolidateAfterEviction` 开关控制）
- 手工 API（`getLastConsolidateInfo().trigger ∈ {'manual','eviction','api'}`）

**没有定时调度**。无 setInterval / cron / scheduler 注册。

主要工作：
1. **事件边规范化** (`eventEdgesNormalized`)：去重 / 合并方向 / 修复非法 relationType
2. **实体层级候选** (`entityHierarchyCandidates / entityHierarchyEdgesCreated`)：基于 `is-alias-of` / `part-of` / `is-a` 等关系推 transitive 候选
3. **LLM 别名核验**（可选，需 `opts.llm.ctx`）：调用 `verifyAliasPair` 否决误合并，否则等价名节点 → `mergeAlias` 合并

---

## 3. Alias / 合并规则

### 触发路径

- `personPersonEdges` 含 `relationType ∈ {is-alias-of, alt-account-of}` ⇒ `mergeAlias({kind: 'person'})`
- `entityEntityEdges` 含 `relationType = is-alias-of` ⇒ `mergeAlias({kind: 'entity'})`
- `eventEventEdges` 含 `relationType = is-alias-of` ⇒ `mergeAlias({kind: 'event'})`
- consolidate 跑同名核验也走 `mergeAlias`

### 合并语义 (`mergeAlias`)

1. 选 canonical = 高 weight / 多 evidence 那个（详见 `service.ts`）
2. `canonical.aliases ← uniq(canonical.aliases ∪ {alias.name} ∪ alias.aliases)`
3. 所有引用 `alias.id` 的边 ⇒ rewire 到 `canonical.id`
4. 删除 `alias` 节点
5. 不保留 audit log（合并是终态）

### 大号 / 小号

`alt-account-of` 走的是合并通道，不是层级通道。

- LLM extractor 输出 `personPersonEdges: { relationType: 'alt-account-of', directed: true }`（A 是 B 的小号）
- service 检测到后立即调 `mergeAlias({kind: 'person'})` 把 A 合并进 B
- A 的 `displayName` 进 `B.aliases`，A 的所有边 rewire 到 B
- **结果：图里只剩 B 一个 PersonNode，不会有"主-从"二节点结构**

所以"大号小号"不会进入未来要加的 `hierarchy` 维度，会被 alias 系统先吃掉。

---

## 4. Rename / 节点改名风险盘点

| 字段 | 用作 key？ | rename 安全性 |
|---|---|---|
| `PersonNode.name` (= displayName) | 否（key = `person:{platform}:{userId}`） | ✅ 引用层完全安全 |
| `EventNode.title` | 否（key = `event:{uuid}`） | ✅ 引用层完全安全 |
| `EntityNode.name` | 否（key = `entity:{uuid}`） | ✅ 引用层完全安全 |

业务层风险（**与引用完整性无关**）：

1. `PersonNode.name` 本质是 platform 拉的 displayName。LLM 改它 → 与 platform 实际昵称脱节。**禁改**：类型层即 `renameNode({kind: 'event'|'entity', ...})` 不接受 `'person'`，工具层额外拦截 `id` 含 `:` 的 person key。
2. `Event/Entity` 改名通过 `service.renameNode` / 工具 `user_relation_rename_node`：
   - 原 `title` / `name` **自动**进 `aliases`（去重），旧名仍可被搜索命中；
   - 写入 `nameHistory: NodeNameAudit[]`（`{from, to, at, by, reason}`），无静默改名；
   - `key`/`id` 不变，所有引用边 0 风险。
3. 工具描述里强制要求 `reason`（≤80 字），LLM 必须给出改名理由 → 防止"风格化"反复改。

### LLM 工具：`user_relation_rename_node`

| 参数 | 必填 | 说明 |
|---|---|---|
| `node_id` | ✅ | event / entity 的 UUID（带 `:` 的 person key 直接被拒） |
| `new_name` | ✅ | 新 title / name，≤80 字符，与原名不同（同名 = no-op，不写 audit） |
| `reason` | ✅ | 改名理由 |

同名拆物（disambiguation / split，一个名字承载两类含义 → 拆成两个具体子物）**不在 rename 范围**，需单独开 issue。

---

## 5. Person-Person `hierarchy` 维度（与 `directed` 正交）

`PersonPersonEdge` 同时携带两个独立维度：

| 维度 | 取值 | 语义 |
|---|---|---|
| `directed` | `true` / `false` | **声明的对称性**：`true` = "A 单方面声明与 B 有此关系"（B 不一定认同）；`false` = 双方一致的对等关系 |
| `hierarchy` | `superior` / `peer` / `subordinate` / `unknown` | **从 `fromPerson` 视角看的上下位**：A 视 B 为上 / 平 / 下 / 不明 |

**关键：不要用 `relationType` 文本去暗示层级**（如 "mentor" 不自动 = superior，因为方向取决于谁是 from）。

### 例

| 自然语言 | from | to | relationType | directed | hierarchy |
|---|---|---|---|---|---|
| "X 是我师傅" (说话人=A) | A | X | mentor | true | superior |
| "X 是我徒弟" (说话人=A) | A | X | mentor | true | subordinate |
| "我和 X 是同学" (双方一致) | A | X | classmate | false | peer |
| "A 提到 B 是他朋友"（B 是否认同未知） | A | B | friend | true | unknown |

### 合并规则（addPersonPersonEdge）

后来者覆盖 `unknown`，但 `unknown` **不会**覆盖已有的具体值：

$$
\text{hierarchy}_{\text{merged}} = \begin{cases}
\text{hierarchy}_{\text{new}} & \text{if } \text{hierarchy}_{\text{old}} = \text{unknown} \lor \text{hierarchy}_{\text{old}} = \emptyset \\
\text{hierarchy}_{\text{old}} & \text{otherwise}
\end{cases}
$$

这样既能把模糊判断升级为具体判断，又不会被后续的"无信息观察"抹平。

### 大号 / 小号 ≠ hierarchy

大号 / 小号是**同一人**的两个账号，走 `is-alias-of` / `alt-account-of` → `mergeAlias({kind: 'person'})`，把 alias 账号的边重写到 canonical，alias `name` 进 `aliases`。**不要**用 `hierarchy: superior` 表达"大号是小号的主人"，那是别名问题不是层级问题。

---

## 6. 配置开关索引

| 配置 | 默认 | 影响 |
|---|---|---|
| `consolidateAfterEviction` | `true` | 淘汰后是否自动 consolidate |
| `consolidateLLMModelRef` | unset | 为空则纯算法 consolidate |
| `consolidateLLMDisableThinking` | `true` | LLM 别名核验关思考模式 |
| `consolidateAutoLink` | `true` | consolidate 是否自动建别名 / 层级边 |

完整配置见 `extractor.ts` 顶部 `RelationExtractorConfig`。
