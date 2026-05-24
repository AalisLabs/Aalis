# 关系图 · 字段含义速查

> WebUI 关系图（plugin-user-relation 暴露给 plugin-webui-server）所用字段与
> 中文术语对照。命令 `/relation compress | maintain` 触发的压缩 / 体检
> 也使用同一套语义。

## 三类节点

| kind   | 中文 | 形状 / 配色（WebUI） | 来源 |
|--------|------|----------------------|------|
| person | 人物 | 圆点 · 蓝（焦点变红） | observePerson（按 platform+userId upsert） |
| event  | 事件 | 圆角矩形 · 橙 | LLM 提取的对话事件 |
| entity | 物（topic/place/thing/work） | 菱形 · 绿/紫/黄/粉 | LLM 提取的"被讨论的客体" |

## 六类边

| kind            | 中文     | 示例语义 |
|-----------------|----------|----------|
| `person-event`  | 人 → 事件 | 角色 `role` 见下 |
| `person-entity` | 人 → 物   | 角色 `role` 见下 |
| `person-person` | 人 → 人   | 关系 `relation` 见下 |
| `event-event`   | 事件 → 事件 | 因果 / 时间相邻 / 同主题 |
| `event-entity`  | 事件 → 物   | 事件涉及到某物 |
| `entity-entity` | 物 → 物    | part-of / alias / 层级 / 侧向父等 |

### `role` 字段（仅人 → 事件 / 人 → 物）

人 → 事件：

| token        | 中文     |
|--------------|----------|
| `initiator`  | 发起者 / 提起话题者 |
| `participant`| 主要参与者 |
| `witness`    | 旁观者 |
| `target`     | 被指向 / 被评价 |
| `reporter`   | 转述 / 报告者（未亲历） |

人 → 物：

| token        | 中文 |
|--------------|------|
| `enthusiast` | 深度行为性卷入（≠ 单句"喜欢"） |
| `participant`| 参与 / 使用 |
| `owner`      | 拥有 |
| `creator`    | 创作者 |
| `critic`     | **行为性**批评（写评测 / 公开对抗） |
| `visitor`    | 到访（适用于 place） |
| `mentioned`  | 仅被提及，态度不明（搭配 `sentiment`） |

> 单句态度声明（"我喜欢 X"）不在关系图记录，归 plugin-user-profile 画像层。

### `relation` 字段（仅人 → 人）

| token            | 中文 | 有向？ |
|------------------|------|--------|
| `friend`         | 朋友 | 无向 |
| `cp`             | CP   | 无向 |
| `rival`          | 对手 | 无向 |
| `mentor`         | 师徒 | 有向（from = 徒，to = 师） |
| `colleague`      | 同事 | 无向 |
| `familiar`       | 熟人 | 无向 |
| `antagonist`     | 敌对 | 无向 |
| `admirer`        | 仰慕者 | 有向 |
| `is-alias-of`    | A 是 B 的别名 / 小号 | 有向 |
| `alt-account-of` | A 是 B 的小号 | 有向 |

### `sentiment` 字段（可附加在任意角色边上）

`positive` 积极 · `negative` 消极 · `neutral` 中性 · `mixed` 复杂。

### `hierarchy` 字段（仅人 → 人，与 `directed` 正交）

| token         | 中文 |
|---------------|------|
| `superior`    | from 视角下高位（老板 / 师父 / 长辈） |
| `peer`        | 明确平级 |
| `subordinate` | 低位 |
| `unknown`     | 未知（默认） |

## 三个数值指标

### 合并强度 `weight`（0~1）

节点 / 边被**重复合并**的累计程度：从 0.5 起步，每次合并
`+(1 - prev) · 0.3` → 0.65 → 0.755 → 0.829 → …（clamp 1.0）。

**语义 = 被强化次数，不是重要性。**

### 图重要性 `lastPageRank`

最近一次 `/relation compress | maintain` 计算的全图 PageRank。
个性化种子按 kind 加权：人 = 3 · 物 = 2 · 事 = 1。
越高越靠近"核心人物 · 热门事件"。未跑过压缩则为空。

### 边淘汰分（仅边详情）

`合并强度 × ((PR_from + PR_to) / 2)`。
配额淘汰时按此**升序**删——分越低越先删。
让"弱权但连接重要节点"的边受保护。

## 压缩与孤儿清理

`/relation compress` 与 `/relation maintain` 都走以下流程：

1. **孤儿清理（与配额无关，无条件）**：所有"没有任何边端点引用"
   的节点都删 —— `person / event / entity` 一视同仁。
   被删的 `person` 下次发言时会由 `observePerson` 重建，所以安全。
2. **配额淘汰（仅在 `count > quota · (1+hysteresisPct)` 触发）**：
   按 `(now - lastReinforcedAt) / (max(weight, 0.05) · max(PR, ε))`
   降序删，直到 `count ≤ floor(quota · targetPct)`。
   `evidence.length ≥ 3` 或 `weight ≥ 0.8` 的节点**仅在此阶段**受保护。
3. **边按配额删**：保留 `合并强度 × 端点 PR 平均` 最高的。
