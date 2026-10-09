# plugin-session-manager — 会话管理器

**包名**: `@aalis/plugin-session-manager`  
**源码**: `packages/plugin-session-manager/src/index.ts`、`settings.ts`

## 概述

会话生命周期管理，支持会话树形结构；会话设置的存储、继承链与校验。设置项由拥有功能的插件登记（模型归 agent、人设归 persona、工具分组归 tools、白纸的六项归 paper……），本插件不认识任何具体的键。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-session-manager',
  provides: [sessionManager],
  uses: {
    memory,
    agent: optional(agent),
    llm: optional(llm),
    platform: optional(platform),
    hostConfig: optional(hostConfig),
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

本插件没有插件配置。会话设置在会话之上的三层（全局默认、平台档、平台档的受众条目）写在宿主配置文档的 `sessionConfig` 字段里，见下文「会话之上的各层」。

## 功能

- **会话 CRUD**: 创建、查询、更新、归档、删除会话（删除会递归删除子会话，并经 `memory:clear` 钩子以会话级、不带类型清理，该会话的消息历史、摘要、待办与向量随之清空）
- **会话树**: 支持父子会话关系（用于子任务系统）
- **会话设置**: 插件经 `sessionManager.registerSetting` 登记设置项，随它的激活撤回；写入按登记的字段校验，没登记的键与不合字段的值拒绝；插件没装或没启用时它的键原样保留、不参与解析，重新启用后恢复（契约见 [api-session-manager](../api/api-session-manager.md)）
- **会话种类与列表分区**: 会话种类按 `sessionKind` 给出：子会话为 task，群与私聊为 room，其余为 owner。群与私聊的首条真人消息到达即按这条消息登记，记下出生平台与聊天窗口（平台类型名、多方标记、机器人账号、目标），会话列表把它们列在「IM 房间」区，owner 自己的 WebUI、CLI 会话列在「我的会话」区（收录口径见 [session-manager 服务](../services/session-manager.md) §6.6）。WebUI 与终端的会话在入站之前建档，记下创建来源（`webui`、`cli`）；自动标题只给带创建来源的根会话生成。工作会话的绑定与当前目录随会话表持久化（见 [session-manager 服务](../services/session-manager.md) §2.6）。房间建档时记下接管它的平台适配器实例（`originInstance`），供会话列表按实例分组；建档时没有适配器认领的，下一次有消息进来时补记
- **会话状态**: 回合开始翻 `active`（已归档的不翻，只有手动恢复才回到列表），会话里最后一轮结束时按这一轮的结局收口为 `error` 或 `completed`，根会话与子会话一样；每一轮结束时记下这一轮的结局、结束时间与出错原因（`lastTurn`），结局为 `replied` 时另记下她最近开口的时间（`lastReplyAt`）（见 [session-manager 服务](../services/session-manager.md) §7.1）
- **按会话累加 token**: 订阅 `llm:usage`，把每次模型调用的输入与输出 token 累加进这个会话的 `tokens`；只记已有的会话，不改 `updatedAt`，随会话落盘与删除（见 [session-manager 服务](../services/session-manager.md) §7.4）
- **事件发射**: `session:created`、`session:updated`、`session:deleted`、`session:completed`；建、删子会话之后父会话也发一次 `session:updated`（子会话列表变了）；设置项登记或撤回、某一层或某个会话的覆盖被改写时发 `session:config:changed`
- **持久化**: 会话表存于 memory 的元数据命名空间 `sessions`，写操作经 1 秒防抖后整批提交。会话表跟随 memory 的当前胜者：运行中胜者换成另一个后端（如新装或启用首选后端）时，先把未落盘的变更写回旧后端，再从新后端读取会话表整体替换。换后端即换库，不跨后端合并；新表加载完成前的改动仍写回旧后端，旧后端已卸载或停用时写回失败，只记 warn。读取会话表失败时按 1、3、10 秒的间隔重试三次（每次重试前记一条 warn），其间仍用原来的会话表与落盘目标。本插件激活时（启动时，或随 memory 胜者卸载、停用、重载而重新激活时）等读表（含重试）结束才对外提供服务：后端持续不可用时，这次重算约多等 14 秒，拓扑序排在本插件之后的插件随之推迟激活，启动时 `app:ready` 也随之推迟。14 秒是三次重试间隔之和，各次读取本身的耗时另计：如 memory-mongodb 连不上库时，每次读取要等到服务器选择超时（`connectTimeoutMs`，默认 5 秒）。换后端、停用或停机会中止重试等待。重试用尽或被中止时会话列表为空，在这个后端上的会话改动不落盘，以免空表覆盖后端原有记录；重试用尽记 error，被中止（停用、停机或换后端）只记一行 info。读回的每条会话记录先核字段：存储把没有的可选字段存成 `null` 的（MongoDB 就是这样）去掉这个键。会进会话列表与协议的可选字段（标题、父会话、创建来源、出生平台、聊天窗口、绑定、当前目录、所属实例、最近回复时间、最近一轮、token）类型不对时，去掉这个字段照常载入，记一条 warn 点名记录与字段，下次落盘写的就是去掉之后的记录。`id`、名称、子会话、状态、配置、两个时间缺了或类型不对时，这条记录不载入，原样移到元数据命名空间 `sessions-rejected`（同一个键），记一条 warn 点名记录与字段：留在会话表里的话，之后同 id 的建档（如房间再来消息）会整条覆盖它。移走时先写副本再删原处，后端停在半途也不丢记录。一条坏记录不会让会话列表取不出来。清空、读取历史等消息类操作始终走当前胜者

## 继承链

```
全局默认 → 平台档 → 受众条目 → 父会话 sessionDefaults（旧数据） → 会话自身 config
```

从左到右优先级递增，右侧覆盖左侧；值为 `undefined` 或 `null` 的项视为未设置，沿用上一层的值。只有登记过的项参与解析；取值不合登记字段的当作没设置并告警一次，字段标了 `onInvalid: 'error'` 的（白纸的两项金额上限）原样交给登记它的插件按拒绝处理。

解析会话生效配置时选哪个平台档，结果不写回会话：

- IM 房间（会话 id 以 `<平台>:` 开头，子任务按父会话算）按房间的出生平台选档，不论从哪个入口驱动，再按房间的受众叠加受众条目。owner 从 WebUI 往 QQ 群插话，这一轮仍按 onebot 的档选工具组、人设与模型，拿不到 webui 档开放的工具组；会话设置的继承来源与 `/session` 的来源显示同一口径。
- 没有出生平台的会话（WebUI、CLI 等 owner 面会话）按调用方传入的入口平台选档，不取受众条目。

钉死只管继承链：会话自身 config 里的覆盖仍然优先。

建会话经会话服务（[plugin-session-server](./plugin-session-server.md)）：根会话不拷贝各层，配置经继承链实时生效；子会话拷贝父会话的生效配置（`childConfig`），去掉登记为 `liveOnly` 的项（白纸与远端代理的六项），它们只经继承链实时解析；`memoryRecallScope` 照常拷贝。

## 会话之上的各层

全局默认、平台档与受众条目写在宿主配置文档（`aalis.config.yaml`）的顶层字段 `sessionConfig` 里，可以手写，也经会话协议按层读写（设置的「会话默认」）：

```yaml
sessionConfig:
  defaults:                 # 全局默认：所有会话都继承
    persona: <人设>
  platforms:                # 平台档：按平台名生效，不区分适配器实例
    cli:
      enabledToolGroups: ['*']
    onebot:
      enabledToolGroups: [<分组>]
  audiences:                # 平台档的受众条目：只对这个平台的群（group）或私聊（private）房间
    onebot:
      private:
        enabledToolGroups: [<分组>, <另一分组>]
```

- 值按插件登记的设置项解析；没装或没启用的插件写在这里的键原样保留，重新启用后生效。
- 工具分组写 `'*'` 表示全部分组；不写则这个平台只有无分组的通用工具（带分组的工具默认不暴露）。`npm create aalis` 生成的配置只给 owner 专用的 `cli`、`webui` 两个平台写了 `enabledToolGroups: ['*']`。
- 受众条目只写与同平台的平台档不同的键，只对有出生平台的房间生效，owner 面会话不取。受众只认 `group` 与 `private`，写成别的名字的告警后忽略，不当成不限受众去覆盖整个平台。
- 白纸与远端代理的六项写在平台档或受众条目里，这个平台的全部房间或全部群、私聊房间都会继承，一般只写在单个房间的会话设置里；[plugin-paper](./plugin-paper.md) 的诊断项会报。
- 形状不对的部分（某层不是对象）告警一次后忽略；按层写时整理成上面的形状写回，空了的层删掉。宿主没有提供配置文档时（嵌入式宿主），各层为空、按层写被拒。
- 按层写校验后写回文档并保存；保存失败（配置文件有尚未生效的外部修改而拒写，或写盘出错）以拒绝传出，改动已在运行态生效。
