# 规划与已知问题

本目录记录**尚未完成的工作**——既包括已发现但未修的缺陷，也包括未来功能的调研与实施方案。

与 `docs/design/`（如 [api 包架构](../design/api-packages.md)）的分工：design 说明**已实现机制**为什么这样设计；roadmap 记录**还没做的事**，以及为什么现在不做。

每篇的共同体例：所有事实经实测确认，记录根因与修法方向，避免后续重新调查；未决项明确标注待谁拍板，不代为决定。

**引用位置写符号名，不写行号。** 行号会随重构整体漂移而静默失准——`commands.md` 的 17 处行号引用实测已有 10 处指向别的代码，指令系统重写过四次即足以打穿全部引用。写 `CommandRegistry.materialize` 这样的符号名，读者 grep 一次即得，且改名时能被搜到。

**已实现的条目一律只留短文**——一两句说清「做了、在哪」即可，机制与实测数据写在代码注释和测试里。本目录记的是还没做的事，展开讲已完成的会喧宾夺主，也会随代码演进变成陈旧的第二真相源。

## 目录

| 文档 | 主题 | 状态 |
|---|---|---|
| [Koishi 兼容层](./koishi-compat.md) | 嵌入真实 Koishi 内核让其插件直接运行 | 已验证可行，待实施 |

## 阅读顺序建议

**「已知问题」与「指令系统」两篇已清空并删除**（2026-08）。那批对抗审计确认的条目要么修完并配了回归断言，要么按「结论归结论、待办归待办」搬回它该在的地方——判据搬进契约注释（如 `api-memory` 为何只有 metadata 面必填）、取舍搬进代码注释（如指令声明栈为何不改成同名拒绝、安全轴为何不跟栈顶走）、试过并被推翻的搬进对应实现旁（如预检副本为何不 cp `.npmrc`）。这么做的理由见下方体例：结论留在代码边上比留在 roadmap 里更不容易陈旧。

若关心**下一步能做什么**：[Koishi 兼容层](./koishi-compat.md) 自包含——从生态调研数据、被否决的两个方案及理由，到 PoC 逐项实证结果与实施方案，不需要预先了解上下文。它的前置项「同名指令冲突」已完成。

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
