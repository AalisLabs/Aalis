# plugin-session-manager — 会话管理器

**包名**: `@aalis/plugin-session-manager`  
**源码**: `packages/plugin-session-manager/src/index.ts`

## 概述

会话生命周期管理，支持会话树形结构；场所与工作区的记录。本插件不认识设置：插件按会话、按场所存的数据放在会话与场所记录的 `metadata` 里，会话设置（[plugin-session-settings](./plugin-session-settings.md)）的场所层与本会话层就存在这里。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-session-manager',
  provides: [sessionManager],
  uses: {
    memory,
    agent: optional(agent),
    llm: optional(llm),
    i18n: optional(i18n),
    platform: optional(platform),
    authority: optional(authority),
    events,
    hooks,
    lifecycle,
    logger,
    provide,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

本插件没有插件配置。会话设置的层与存放见 [plugin-session-settings](./plugin-session-settings.md)。

## 功能

- **会话 CRUD**: 创建、查询、更新、归档、删除会话。删除会递归删除子会话：先从表里摘掉并发 `session:deleted`（agent 在这里停掉这个会话在跑的回合并等它收尾），再经 `memory:clear` 钩子以会话级、不带类型清理，该会话的消息历史、摘要、待办与向量随之清空
- **清空连带删除子会话**: `memory:clear` 清了一个会话的消息历史（没指定类型或类型含 `context`，消息历史那一行清成功）之后，删掉它的子会话；范围为 `all` 时删掉全部子会话。只清别的类型或消息历史没清成时不删（见 [session-manager 服务](../services/session-manager.md) §2.5）
- **插件数据**: 会话与场所记录各有一份 `metadata`，`updateSession`、`updatePlace` 合并式改（顶层键整键替换），随记录落盘、随记录删除；建会话时给的 `metadata` 原样存下，里面的 `title`、`inputContext` 不当成同名字段读
- **会话树**: 支持父子会话关系（用于子任务系统）
- **会话种类与列表分区**: 会话种类按 `sessionKind` 给出：子会话为 task，群与私聊为 room，其余为 owner。群与私聊的首条真人消息到达即按这条消息登记（`recordInbound`，可等待：网关在入站相位之前等它收录完），记下出生平台与聊天窗口（平台类型名、多方标记、机器人账号、目标），会话列表把它们列在「IM 房间」区，owner 自己的 WebUI、CLI 会话列在「我的会话」区（收录口径见 [session-manager 服务](../services/session-manager.md) §6.6）。WebUI 与终端的会话在入站之前建档，记下创建来源（`webui`、`cli`）；自动标题只给带创建来源的根会话生成。所属工作区、项目会话的绑定与当前目录随会话表持久化（见 [session-manager 服务](../services/session-manager.md) §2.6）。房间建档或补记来源字段时记下接管它的平台适配器实例（`originInstance`），供会话列表按实例分组；没有适配器认领的，下一次有消息进来时补记
- **场所与工作区**: 每个会话恰好一个场所，子会话取根会话的：IM 的群与别人的私聊是窗口（键 `平台:类型:目标`，不含机器人账号），owner 的 IM 私聊（以 `optional(authority)` 认对端是 owner）与本机的会话在默认工作区或记下的项目工作区。场所记录存于 memory 的元数据命名空间 `places`，与会话表一同加载与落盘：默认工作区的记录激活时就在，窗口的记录在房间建档时建、显示名随入站更新（建了或改了名，场所是这个窗口的根会话各发一次 `session:updated`，会话列表里场所的显示名跟着变），工作区的记录由 `addWorkspace` 建（同一个真实路径只登记一个，编号随机），`removeWorkspace` 只删记录（连同它的 `metadata`）、不动文件，原属会话归默认工作区（见 [session-manager 服务](../services/session-manager.md) §2.7）
- **会话状态**: 回合开始翻 `active`（已归档的不翻，只有手动恢复才回到列表），会话里最后一轮结束时按这一轮的结局收口为 `error` 或 `completed`，根会话与子会话一样；每一轮结束时记下这一轮的结局、结束时间与出错原因（`lastTurn`），结局为 `replied` 时另记下她最近开口的时间（`lastReplyAt`）（见 [session-manager 服务](../services/session-manager.md) §7.1）
- **按会话累加 token**: 订阅 `llm:usage`，把每次模型调用的输入与输出 token 累加进这个会话的 `tokens`；只记已有的会话，不改 `updatedAt`，随会话落盘与删除（见 [session-manager 服务](../services/session-manager.md) §7.4）
- **事件发射**: `session:created`、`session:updated`、`session:deleted`（从表里摘掉之后、清数据之前）、`session:completed`；建、删子会话之后父会话也发一次 `session:updated`（子会话列表变了）
- **持久化**: 会话表与场所记录存于 memory 的元数据命名空间 `sessions` 与 `places`，写操作经 1 秒防抖后整批提交。会话表跟随本插件选中的 memory 后端：运行中选中的那一家换成另一个后端（如新装或启用首选后端）时，先把未落盘的变更写回旧后端，再从新后端读取会话表整体替换。换后端即换库，不跨后端合并；新表加载完成前的改动仍写回旧后端，旧后端已卸载或停用时写回失败，只记 warn。读取会话表失败时按 1、3、10 秒的间隔重试三次（每次重试前记一条 warn），其间仍用原来的会话表与落盘目标。本插件激活时（启动时，或随选中的 memory 后端卸载、停用、重载而重新激活时）等读表（含重试）结束才对外提供服务：后端持续不可用时，这次重算约多等 14 秒，拓扑序排在本插件之后的插件随之推迟激活，启动时 `app:ready` 也随之推迟。14 秒是三次重试间隔之和，各次读取本身的耗时另计：如 memory-mongodb 连不上库时，每次读取要等到服务器选择超时（`connectTimeoutMs`，默认 5 秒）。换后端、停用或停机会中止重试等待。重试用尽或被中止时会话列表为空，在这个后端上的会话改动不落盘，以免空表覆盖后端原有记录；重试用尽记 error，被中止（停用、停机或换后端）只记一行 info。读回的每条会话记录先核字段：存储把没有的可选字段存成 `null` 的（MongoDB 就是这样）去掉这个键。会进会话列表与协议的可选字段（标题、父会话、创建来源、出生平台、聊天窗口、所属工作区、绑定、当前目录、所属实例、最近回复时间、最近一轮、token）类型不对时，去掉这个字段照常载入，记一条 warn 点名记录与字段，下次落盘写的就是去掉之后的记录。`id`、子会话、状态、两个时间缺了或类型不对时，这条记录不载入，原样移到元数据命名空间 `sessions-rejected`（同一个键），记一条 warn 点名记录与字段：留在会话表里的话，之后同 id 的建档（如房间再来消息）会整条覆盖它。移走时先写副本再删原处，后端停在半途也不丢记录。一条坏记录不会让会话列表取不出来。场所记录同样核字段：键、类别（与键对得上）、两个时间不对的移到 `places-rejected`；名字、目录与 `metadata` 类型不对的去掉这一项照常载入。清空、读取历史等消息类操作始终走当前选中的那一家
