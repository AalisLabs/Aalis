# 规划与已知问题

本目录记录**尚未完成的工作**——既包括已发现但未修的缺陷，也包括未来功能的调研与实施方案。

与 `docs/design/`（如 [api 包架构](../design/api-packages.md)）的分工：design 说明**已实现机制**为什么这样设计；roadmap 记录**还没做的事**，以及为什么现在不做。

每篇的共同体例：所有事实经实测确认并附 `file:line`，记录根因与修法方向，避免后续重新调查；未决项明确标注待谁拍板，不代为决定。

**已实现的条目一律只留短文**——一两句说清「做了、在哪」即可，机制与实测数据写在代码注释和测试里。本目录记的是还没做的事，展开讲已完成的会喧宾夺主，也会随代码演进变成陈旧的第二真相源。

## 目录

| 文档 | 主题 | 状态 |
|---|---|---|
| [Koishi 兼容层](./koishi-compat.md) | 嵌入真实 Koishi 内核让其插件直接运行 | 已验证可行，待实施 |
| [指令系统](./commands.md) | `/help` 权限过滤（待决策做不做）、`/help` 详情的 autolink 规避 | 小 |

## 阅读顺序建议

若关心**下一步能做什么**：[Koishi 兼容层](./koishi-compat.md) 自包含——从生态调研数据、被否决的两个方案及理由，到 PoC 逐项实证结果与实施方案，不需要预先了解上下文。它的前置项「同名指令冲突」已完成。

[指令系统](./commands.md) 现在主要是**已实现说明 + 未决项**，动手前先读它的「已实现」一节，避免按已作废的描述施工。

**存储层已无待办**，本目录不再收录：关系图每轮全量加载两次（快照缓存）、合并转发原文永久
堆积（7 天惰性回收）两条已修；清空路径的「删一半」改为批量提交后，**在 sqlite / inmemory 上
是真原子，在 mongodb 上仍只保证按序执行遇错即停**——原子性按后端分档，见 `api-memory` 契约里
`commitMetadata` 的说明。机制见 `plugin-user-relation/src/store.ts`、
`plugin-adapter-onebot/src/forward-expand.ts`、`plugin-user-profile` 与 `plugin-memory-summary`
的清空路径，以及 `api-memory/src/index.ts` 的契约注释。
「要不要上结构化存储/ORM/索引/namespace stamping」四条决定连同实测依据写在
[`api-memory` 契约](../../packages/api-memory/src/index.ts)的「结构化元数据存储」一节
——那里是动手前必看的地方，比 roadmap 更贴近代码、不会陈旧。

**插件市场已无待办**，本目录不再收录：装/卸/更新/预检/回滚/串行闸/卸载护栏/装完即用全部落地，
机制与实测数据在 `plugin-package-manager/src/index.ts`、`plugin-webui-server/src/routes/marketplace.ts`
与 `runtime/src/providers.ts` 的注释里，回归测试见 `test/plugins/package-manager.test.ts`、
`test/plugins/marketplace.test.ts` 与 `test/integration/install-chain.test.ts`（真跑 npm）。
两条曾记为待办的实为**有意不做**，已各自落到该去的地方：安装脚本执行面 → `installTo` 的注释；
服务劫持面 → [安全模型 §1](../concepts/security-model.md)（它是服务容器的性质，本就不属于市场）。
