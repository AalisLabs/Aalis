# 会话管理服务（session-manager）

> 受众：编写或消费「会话生命周期 + 会话级配置解析」的第三方插件作者。
> 先读 [服务模型](../concepts/service-model.md) 与 [惰性服务访问](../concepts/lazy-service-access.md)；本文是它们在「会话」这个具体服务上的落点。配置如何流入 LLM 调用见 [消息-LLM 流水线](../concepts/message-llm-pipeline.md)。

## 1. 定位

session-manager 维护对话会话的生命周期（创建 / 查询 / 状态 / 树形父子关系），并把分层的会话设置合并成一份「最终生效配置」交给 Agent 消费。消费方经 `sessionManager.use` 调用，契约包 `@aalis/api-session-manager`，参考实现 `@aalis/plugin-session-manager`。

核心职责两件：

- **会话设置**：设置项由拥有功能的插件登记（§2.5），session-manager 只做通用的存储、继承链与校验，不认识任何具体的键。层的先后由层表 `SESSION_LAYERS` 定义：全局默认 → 平台档 → 平台类型档 → 场所 → 父会话 `sessionDefaults`（旧数据）→ 本会话，后面的压过前面的，合并出一份 `resolveConfig(sessionId, platform)`（`api-session-manager/src/index.ts`、实现 `plugin-session-manager/src/index.ts`、`settings.ts`）。前三层存放在宿主配置文档的 `sessionConfig` 里，场所层存在会话管理的场所记录里（§2.4）。IM 房间按记下的出生平台与聊天窗口选层，不论从哪个入口驱动；传入的入口平台只对没有出生平台的会话起作用。Agent 每条消息都查它来决定用哪个 LLM / persona / 工具分组。
- **场所与工作区**：每个会话恰好一个场所（聊天窗口或工作区），子会话取根会话的；工作区由 owner 登记（§2.7）。
- **生命周期与会话树**：CRUD + 父子树 + `active/waiting/completed/error/archived` 状态机；会话状态由本插件**自治维护**（回合开始的 `agent:input:before` 中间件翻 `active`，同一会话的最后一轮结束时由它收口，见 §7.1），并通过 `session:*` 事件广播（`plugin-session-manager/src/index.ts`）。IM 房间由 `inbound:message` 上的收录监听登记（§6.6）。

它**不是**消息存储——历史消息存在 `memory` 服务里；本服务只把会话元数据与场所记录持久化到 `memory` 的 metadata 命名空间 `sessions` 与 `places`（`plugin-session-manager/src/index.ts`）。

## 2. 契约（`@aalis/api-session-manager/src/index.ts`）

### 2.1 服务接口 `SessionManagerService`（`index.ts`）

```ts
// CRUD（kind、来源字段、创建来源、所属工作区、绑定、当前目录、originInstance、lastReplyAt、lastTurn、tokens 由服务推出或写入，
// 不收调用方经会话字段传值；config 按登记的设置项校验）
// creation 是建档专用的参数（创建来源、所属工作区、绑定），只有会话服务与终端传（§2.6）
createSession(opts?: NewSessionFields, creation?: SessionCreation): Promise<SessionInfo>;
getSession(id: string): SessionInfo | undefined;
listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
updateSession(id: string, updates: SessionUpdates): Promise<SessionInfo>;   // config 是补丁：null 删键，与原有覆盖合并
// 按精确 id 幂等 upsert：命中 → 合并式 update（发 session:updated）；未命中 → 以传入 id（不自生成）建记录（状态缺省：有回合在跑为 active，否则 waiting；发 session:created）。
// 供终端配置的会话 id、/session.set 落配置覆盖按原样 id 建档。按 id 建出的记录不带来源字段：IM 房间由参考实现的入站收录记下或补记（§6.6）
ensureSession(id: string, patch?: SessionUpdates, creation?: { createdFrom: string }): Promise<SessionInfo>;
deleteSession(id: string): Promise<void>;            // 同时清理其消息历史

// 树形
  // 父会话未建档时（带 source 的注入回合落在还没建档的会话上）先按原样 id 兜底建档（名字为 id），再挂子会话；兜底建的档没有来源字段与创建来源，是房间的由之后的原生入站补记（§6.6）
createChildSession(parentId: string, opts?: Omit<NewSessionFields, 'parentId'>): Promise<SessionInfo>;
getChildren(parentId: string): SessionInfo[];

// 生命周期
completeSession(id: string, result?: string): Promise<void>;   // 触发 session:completed

// 当前目录与项目会话的绑定（§2.6）：当前目录是每个会话自己的，全部会话都有；绑定写在项目会话的根会话上，
// 会话不在项目会话树里时抛错。会话不存在时抛错，改了发 session:updated
setCurrentDir(sessionId: string, dir: string): Promise<void>;
setExtraRoots(sessionId: string, extraRoots: readonly string[]): Promise<void>;
addWorktree(sessionId: string, path: string): Promise<void>;

// 场所与工作区（§2.7）
placeOf(sessionId: string): SessionPlace;
getPlace(key: string): PlaceInfo | undefined;
addWorkspace(root: string): { workspace: WorkspaceInfo; existed: boolean };
listWorkspaces(): WorkspaceInfo[];
removeWorkspace(id: string): Promise<void>;

// 会话设置（解析都是同步，非 Promise）；层与选层见 §2.4，登记见 §2.5
registerSetting(setting: SessionSetting, plugin: string): () => void;   // 提供者一侧；插件经绑定门面登记
listSettings(): RegisteredSessionSetting[];
resolveConfig(sessionId: string, platform?: string): SessionConfig;
// 继承链（不含会话自身 config），另回选层的平台、类型名、场所与每个键的来源层；会话设置的来源显示与 /session 用它
resolveInheritance(sessionId: string, platform?: string): SessionInheritance;
getOwnConfig(sessionId: string): SessionConfig;                // 会话自己的覆盖里已登记、取值合法的项
childConfig(parentId: string, platform?: string): SessionConfig;   // 建子会话复制的配置：生效配置去掉 liveOnly 与 narrowest 项
resolvedDefaults(): SessionConfig;   // 全局默认层由服务偏好承担的项此刻实际落到的值（llm 服务解析到的模型）
listLayers(): SessionConfigLayer[];
getLayer(layer: SessionConfigLayer): SessionConfig;
resolveLayer(layer: SessionConfigLayer): Pick<SessionInheritance, 'values' | 'sources'>;
updateLayer(layer: SessionConfigLayer, patch: SessionConfigPatch): Promise<void>;   // 前三层写进宿主配置文档并保存，场所层写进场所记录

// 标题
generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;  // 调 LLM 总结
updateSessionTitle(sessionId: string, title: string): Promise<void>;
```

`resolveConfig` / `resolveInheritance` / `getOwnConfig` / `childConfig` / `listLayers` / `getLayer` / `resolveLayer` / `placeOf` / `listWorkspaces` 是**同步**方法（读内存里的会话表与宿主配置文档），不要 `await`。写配置的方法遇到没登记的键或不合字段的值抛 `SessionConfigError`（用 `isSessionConfigError` 判定），什么都不改。

### 2.2 重要类型

`SessionConfig`（`index.ts`）——各设置项的值，本包不认识具体的键：键由登记它的插件经 declaration merging 注入，每个键都可选。会话档案里存的是 `StoredSessionConfig = SessionConfig & { sessionDefaults?: SessionConfig }`（`sessionDefaults` 是旧数据里父会话给子会话的默认值，解析照常生效，不再有写入口）；写入用 `SessionConfigPatch`（值为 `null` 删掉这一项、恢复继承）。第一方的键与登记者见 [api-session-manager](../api/api-session-manager.md)。

`SessionInfo`（`index.ts`）——会话本体：

```ts
interface SessionInfo {
  id: string;
  name: string;
  title?: string;                  // AI 总结或父会话指定
  parentId?: string;               // 根会话为 undefined
  children: string[];
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  config: StoredSessionConfig;     // 原样存储：含没启用的插件的键
  createdAt: number; updatedAt: number;
  createdFrom?: string;            // 创建来源：建这个会话的审批面的登记名（§2.6）
  inputContext?: string;           // 父会话传入的指令 / 上下文（见 §6.3）
  result?: string;                 // 子会话完成后填，供向父会话汇报
  metadata?: Record<string, unknown>;
  kind: 'owner' | 'room' | 'task'; // SessionKind，见下
  originPlatform?: string;         // 出生平台：IM 房间建档时记下（§6.6）；只有房间的根会话带
  originChat?: { type: string; multiParty: boolean; selfId?: string; targetId: string };  // 聊天窗口：与出生平台同时记下
  workspace?: string;              // 所属工作区的 id；缺省即默认工作区。只有根会话带（§2.6）
  work?: { root: string; extraRoots: string[]; worktrees: string[] };  // 绑定：只有项目会话的根会话带（§2.6）
  currentDir?: string;             // 当前目录：每个会话各带一份，没有值时为场所的主目录（§2.6）
  originInstance?: string;         // 有出生平台的房间：接管它的平台适配器的插件实例 id（§6.6），只供列表分组
  lastReplyAt?: number;            // 她最近一次开口的时间：回合结局为 replied 时写入（§7.1）
  lastTurn?: { outcome: 'replied' | 'silent' | 'aborted' | 'error'; endedAt: number; error?: string };  // 最近结束的一轮（§7.1）
  tokens?: { input: number; output: number };  // 这个会话自己的模型调用累计的 token，不含子会话（§7.4）
}
```

`kind` 只按 `parentId` 与出生平台推出（参考实现的私有函数 `describeSession`），新建、建档、补记来源字段与加载入表时覆盖写入，调用方传的值与存储里的旧值都不采信。会话种类由纯函数 `sessionKind({ parentId, originPlatform })` 给出：有父会话为 `task`，有出生平台的为 `room`（IM 房间，含 owner 自己的 QQ 私聊），其余为 `owner`。会话列表的分区（`room` 的进「IM 房间」，其余进「我的会话」，子会话随根会话）、设置项的 `appliesTo` 与会话协议的会话种类都按它。`owner` 只表示「没有出生平台」：包括 `mcp-server`、`workflow::<id>` 与定时任务指定的目标会话，并不都是 owner 本人在说话，不能拿来判断「owner 在场」。

`SessionInheritance`（`index.ts`）——`resolveInheritance` 的返回：

```ts
type InheritanceSource = 'defaults' | 'platform' | 'type' | 'place' | 'parent';   // 层表里除本会话以外的层
interface SessionInheritance {
  platform?: string;                    // 选平台档的平台：有出生平台的为出生平台，否则为传入的入口平台
  type?: string;                        // 选平台类型档的类型名：只有有聊天窗口的会话带
  values: SessionConfig;                // 继承值（不含会话自身 config）：已登记、取值合法的键
  sources: Record<string, InheritanceSource>;  // 每个键最终来自哪一层
}
```

### 2.3 事件 augmentation（`index.ts`）

本 `-api` 包通过 `declare module '@aalis/core'` 增量声明了会话生命周期与设置变化的事件到 `AalisEvents`：

```ts
'session:created':   [session: SessionInfo];
'session:updated':   [session: SessionInfo];
'session:completed': [session: SessionInfo];
'session:deleted':   [sessionId: string];
'session:config:changed': [];   // 设置项登记或撤回、某一层或某个会话的覆盖被改写、全局默认的模型变了
```

建、删子会话时父会话的子会话列表也变了：子会话的 `session:created` 或 `session:deleted` 之后，父会话随后发一次 `session:updated`。会话列表据此更新父会话的子会话数（[plugin-session-server](../plugins/plugin-session-server.md) 的增量推送）。

**只想监听这些事件**（而不调用服务）的插件也应当依赖本 `-api` 包——它锚定了 `import type {} from '@aalis/core'` 让 augmentation 生效（`index.ts`）。`plugin-file-reader` 就是仅为 `session:deleted` 事件而 `import type {} from '@aalis/api-session-manager'`（`plugin-file-reader/src/index.ts`）。

### 2.4 层表与选层

层的先后定义在 api-session-manager 的 `SESSION_LAYERS`（名字与称呼，后面的压过前面的）：全局默认、平台档、平台类型档、场所、父会话、本会话。参考实现给会话之上的每一层一条实现（存在哪、层标识的校验、在一个会话上取哪一份、日志里的称呼），继承链、按层读写与可设的层都遍历这张表，不逐层写分支（`plugin-session-manager/src/index.ts`）。

前三层存放在宿主配置文档（`@aalis/api-host-config`）的 `sessionConfig` 字段里（`plugin-session-manager/src/settings.ts`）：

```yaml
sessionConfig:
  defaults: { persona: aalis }
  platforms:
    onebot: { enabledToolGroups: [search] }
  types:
    onebot:
      private: { enabledToolGroups: [search, scheduler] }
```

场所层是会话管理的场所记录里的 `config`（§2.7）。层的标识是 `SessionConfigLayer`：`{ scope: 'defaults' }`、`{ scope: 'platform', platform }`、`{ scope: 'type', platform, type }`、`{ scope: 'place', key }`。平台名与类型名非空、不含 `:`、不是 `*`、不是原型链上的名字，场所键要是已有的场所记录，不合的读写都抛 `SessionConfigError`。

- `listLayers()` 按层表的先后列出可以设的各层：全局默认；各平台档（已装适配器的平台加文档里写过的）；各平台类型档（适配器声明的类型加文档里写过的，没声明类型的平台不单列）；全部场所（默认工作区在前）。同一层里按名字排。
- `getLayer` 回这一层自己的值，`resolveLayer` 回解析到这一层为止的生效值与来源：窗口场所在它的平台档与平台类型档之上（平台与类型名取自窗口键），工作区场所只在全局默认之上。
- `updateLayer` 校验补丁后写回：前三层写进文档并 `save()`，保存成功后发 `session:config:changed`，保存失败时撤回文档里的改动、以拒绝传出，免得下一次任意保存把没存下的修改写进文件；场所层写进场所记录，随会话表落盘。每次按层写记一行设置改动日志。
- 手写的文档里形状不对的部分与 `sessionConfig` 下不认识的段（拼错的 `platfroms`、旧的 `audiences`）告警一次后忽略，按层写时不再写回。宿主没有提供配置文档时这三层为空、按层写被拒。

选层：子会话一律按根会话取。有出生平台的会话按出生平台选平台档、按聊天窗口的类型名选平台类型档，忽略传入的 `platform`，适配器没加载时同样如此：owner 从 WebUI 往 QQ 群插话，这一轮的工具组、人设与模型仍取 onebot 与群的档，入口平台只用来认出说话的人。没有出生平台的会话（WebUI 的 `session-<8位>`、CLI 的 `cli-default` 等）按调用方传入的入口平台选平台档，没有平台类型档。场所按 `placeOf`。会话表里没有的 id 按没有出生平台处理，不从 id 推。

**全局默认层由服务偏好承担的项：** 字段类型为 `llm-ref` 的设置项（plugin-agent 的「模型」）在全局默认层不另存值，读写的就是 llm 服务的偏好（运行态与文档的 `servicePreferences.llm`），默认模型只此一处：`sessionConfig.defaults` 不收它（写了的告警后忽略），按层写全局默认层即改偏好（`null` 取消偏好，落盘失败时偏好与文档一并撤回），偏好从别处改了、llm 的提供者上下线同样发 `session:config:changed`。`resolveConfig` 在全局默认之上各层都没设时不给它的值，取用方交给 `resolveLLMModel`，偏好指向的模型不在时落到服务此刻解析到的那一个；`resolvedDefaults()` 给出这个「此刻解析到的那一个」，会话服务的设置行据此写「默认（<模型名>）」。

会话服务（plugin-session-server）的 `session/config/get` 对有出生平台的会话直接按出生平台解析；没有出生平台的会话先按「会话 metadata 记下的平台 → 接管这个 id 的平台适配器 → 这条连接的入口平台」推出入口平台，再解析。plugin-agent 的 `/session` 同样读 `resolveInheritance`，每个字段显示生效值与来源。

### 2.5 设置项的登记与解析

设置项由拥有功能的插件经绑定门面 `sessionManager.use.registerSetting(setting)` 登记，随它的激活撤回（描述符的 bind 用资源口的 `registrar`，会话管理换提供者时整体重挂）：

```ts
interface SessionSetting {
  key: keyof SessionConfig & string;  // 先经 declaration merging 加进 SessionConfig
  field: SchemaField;                 // schema-config 字段：写入按它校验，可选项用 dynamicOptions 指向提供它的服务
  appliesTo: readonly ('owner' | 'room' | 'task')[];
  narrowest?: 'place';                // 只能设在场所及以上：会话自己的覆盖不收它，会话上存着的旧值不参与解析，建子会话也不复制
  prominence: 'composer' | 'common' | 'advanced';
  order?: number;
  liveOnly?: boolean;                 // 建子会话复制配置时不带它
  validate?(value: unknown): string | undefined;  // 取值校验，外来字段类型必须给
}
```

- **解析只认登记过的键：** 插件没装或没启用时，它的键在会话与各层里原样保留，不显示、不参与解析，重新启用后恢复。
- **取值不合字段：** 先过登记给的 `validate`，再按字段校验（schema-config 不校验外来字段类型的取值，外来类型的设置项不给 `validate` 时登记抛错）。写入时拒绝（`SessionConfigError`）。存储里不合的值（旧数据、手写的配置文件）解析时当作没设置，同一处只告警一次；字段标了 `onInvalid: 'error'` 的原样交出、不回落到下面的层，由登记它的插件按拒绝处理。
- **同一个键几个插件登记：** 须是同一份内容的定义（逐项深比较，不必是同一个对象：进程里可能装了两份契约包），只要还有一个登记者在场这一项就有效；内容不同的登记抛错。`memoryRecallScope` 就是这样：跨会话取料的几个插件各自登记 api-memory 导出的 `MEMORY_RECALL_SCOPE_SETTING`，不会因为某一个停用而让其余插件不再收窄。
- **变化通知：** 登记、撤回、`updateSession` 改了配置、`updateLayer` 都发 `session:config:changed`，会话服务据此推 `session/config/changed`。

### 2.6 来源字段、创建来源、所属工作区、绑定与房间类别

会话之间的差别按字段判，不按会话 id 的写法，也不靠 id 里有没有冒号：

- **来源字段**（`originPlatform`、`originChat`）：IM 房间的出生平台与聊天窗口，建档时按原生入站记下（§6.6），之后不变，聊天窗口的多方标记也不随适配器的声明改动。只有房间的根会话带，子会话按根会话取（纯函数 `rootSessionOf(info, lookup)`；父会话链断了或成环的坏数据没有根会话）。按 id 建档（`ensureSession`、`createChildSession` 给父会话兜底建档）的记录建档时不带，是房间的由之后的原生入站补记（§6.6）；读表时缺这两个字段的记录按没有出生平台，运行时不从 id 推。
- **创建来源**（`createdFrom`）：建这个会话的审批面的登记名，只在建档时经专用参数写：`createSession` 的第二个参数与 `ensureSession` 的第三个参数（`SessionCreation`），不并进 `NewSessionFields`。只有两个写入方：会话服务在 owner 连接调用 `session/create` 时写这条连接所在审批面的登记名（`webui`），终端在发出入站之前给它配置的会话建档时写 `cli`。`ensureSession` 碰上已有的记录时只给按 id 兜底建档留下的空记录（没有创建来源、出生平台与绑定）补写，随这次更新落盘、发 `session:updated`，其余不写。专用参数只给根会话：`createSession` 带 `parentId` 又带它时抛错，会话服务建子会话时不传，子会话按根会话取。
- **所属工作区**（`workspace`）与**绑定**（`work`）：只在建档时经 `SessionCreation` 写，只用于根会话（带了 `parentId` 抛错）。`workspace` 是工作区的 id，须有记录，不带或带 `default` 即默认工作区、不记；在项目工作区里建会话必带 `work: { root }`（绑定目录：工作区的目录，或为这个会话建的同仓 worktree），默认工作区带绑定抛错。绑定目录、空的附加可写目录与 worktree 列表记在根会话上，之后只经 `setExtraRoots`（整份替换）与 `addWorktree`（已记过的不重复记）改，子会话里调用也写到根会话上，子会话按根会话实时看到；取消登记工作区时两者一并清掉（§2.7）。
- **当前目录**（`currentDir`）：建档不写，没有值即场所的主目录；子会话建时取父会话此刻的值，之后各改各的，子会话改当前目录不影响父会话。只经 `setCurrentDir` 改，全部会话都有。
- 目录都是真实路径，由调用方校验。所属工作区、绑定与当前目录随会话表持久化，任何清空都不清，删除会话时随记录删除。

这几项在 `createSession`、`createChildSession`、`ensureSession` 的会话字段参数里带上一律丢弃。读表时类型不对的（来源字段、创建来源、所属工作区、绑定、当前目录）去掉这一项照常载入，并告警。

**房间类别**：纯函数 `roomClass(info, lookup, isOwner)` 按这些字段判这个会话的受众里有谁，由此定回合最多能触及什么，子会话取根会话的：

| 会话 | 房间类别 |
|---|---|
| 有出生平台、聊天窗口为多方 | `room` |
| 有出生平台、一对一、对端是 owner 身份（`isOwner(originPlatform, originChat.targetId)`，谓词由调用方传入） | `owner-only` |
| 有出生平台、其余一对一 | `room` |
| 没有出生平台、带创建来源（WebUI 新建的、终端的，含项目会话） | `owner-only` |
| 其余：不在会话表里的、按 id 建档的、`mcp-server`、编排与定时任务的会话、带绑定却没有创建来源的 | `internal` |

只认多方标记，不认类型名；判不出的一律 `internal`，失败关闭。

### 2.7 场所与工作区

每个会话恰好一个场所（`SessionPlace`：`kind` 为 `window` 或 `workspace`，`key` 是场所键），子会话取根会话的；场所只管归属、白纸与设置层，不管权限。`placeOf(sessionId)` 按根会话取第一条：

1. 有出生平台：一对一而对端是 owner 身份的（owner 的 IM 私聊）为默认工作区 `workspace:default`；其余为窗口，键是 api-gateway 的 `windowKey` 拼出的 `平台:类型:目标`，不含机器人账号，同一个群里两个账号的会话是同一个窗口。聊天窗口缺失（读表时类型不对被去掉）或目标为空的坏数据同样为窗口，键里缺的段按空串拼，日志点名一次，不落进默认工作区，免得 owner 给工作区设的值套到房间上。owner 谓词取 authority 的 `isOwner`，与房间类别同一判据；参考实现以 `optional(authority)` 取它（plugin-authority 也以 optional 用会话管理，两边成可选环），没有 authority 时一对一窗口按窗口算。
2. 没有出生平台的按根会话记下的工作区：有值的为 `workspace:<id>`，不看绑定目录；没有的为默认工作区（默认工作区里建的 WebUI 与终端会话、`mcp-server`、编排与定时任务的会话、按 id 建档且还没补记来源字段的会话、会话表里没有的 id）。记下的工作区没有记录（坏数据）时按默认工作区，日志点名。

场所记录 `{ key, kind, name, root?, config, createdAt, updatedAt }` 存在 metadata 命名空间 `places`，与会话表一同跟随本插件选中的记忆后端加载与写回；必填字段不对（含类别与键对不上）的不载入，移到 `places-rejected`。默认工作区的记录（显示名「默认工作区」）在加载后补上；窗口的记录在 IM 房间建档或补记来源字段时建（§6.6），显示名取群名或对方昵称、随出生平台的入站更新，owner 的 IM 私聊在默认工作区、不建；删除会话不删场所，同一窗口换了会话（另一个机器人账号的会话、以后的 `/new`）照样取到场所的设置。`getPlace(key)` 回显示名（工作区的目录经 `listWorkspaces` 取）。场所的白纸 id 由 `placePaperId(key)` 算出（`p:` 加场所键的 UTF-8 十六进制，只有小写，白纸目录在大小写不敏感的文件系统上也不撞），一个场所一张。

工作区由 owner 经会话服务登记，会话管理只管记录：

- `addWorkspace(root)`：root 是已校验的真实路径，目录校验由调用方做。同一个真实路径只登记一个，已登记的返回那一个（`existed: true`）；否则生成随机的固定编号（不由路径算：目录改名或搬走后记录还在），显示名取文件夹名，允许重名。
- `listWorkspaces()`：默认工作区在前，其后按登记先后；目录在不在不存储，由用到它的一方在用时检查。
- `removeWorkspace(id)`：只删工作区记录与它的场所设置，不动文件；原属会话（根会话记下的是它的）清掉所属工作区与绑定，会话树里的当前目录一并清掉，回到默认工作区，改了的会话各发 `session:updated`，另发 `session:config:changed`。默认工作区与没有记录的 id 抛错。再添加同一个目录得到的是新工作区。

## 3. 谁提供 / 谁消费

**提供方（唯一参考实现）**：`@aalis/plugin-session-manager`，在 `apply()` 里 `provide.use(sessionManager, manager, { label: '会话管理' })`（`plugin-session-manager/src/index.ts`）。它 `uses required = ['memory']`（另有内置的 `services` 等）、`optional = ['agent','authority','host-config','llm','platform']`（`index.ts`）。没有 `memory` 时直接拒绝启动（`index.ts`）。

**典型消费点**：

| 消费方 | 用法 | file:line |
| --- | --- | --- |
| `plugin-agent` | 登记 `llm`、`think`、`maxToolIterations`、`historyLimit`；每条消息 `resolveConfig()` 决定 LLM、persona 与结构化输出的会话选项、工具分组、思考档、最大工具迭代与一轮读的历史条数；`/session.set`·`/session.reset` 走 `ensureSession()`、`updateSession()` 落配置（`/model` 仅列/搜可用模型，不写配置） | `plugin-agent/src/index.ts` |
| `plugin-persona` | 登记人设、额外提示与结构化输出两项；`resolveConfig()` 取它们 | `plugin-persona/src/index.ts` |
| `plugin-tools` | 登记 `enabledToolGroups`（agent 读它决定工具分组） | `plugin-tools/src/index.ts` |
| `plugin-skills` | 按会话 `resolveConfig().persona` 取人设卡，过滤 `list_skills`、`load_skill`、技能发现那一行与触发词自动激活看得到的技能（可选依赖，缺席时取主卡的白名单） | `plugin-skills/src/index.ts` |
| `plugin-memory-summary` | 登记 `compressAt`；回合结束与压缩服务的 `compressAt` 按会话 `resolveConfig()` 取压缩线与条数线（`historyLimit`），选摘要模板读会话记录与 `roomClass`（可选依赖，缺席时压缩线按 0.8、不按条数，摘要用工作模板） | `plugin-memory-summary/src/index.ts` |
| `plugin-subtask` | `childConfig()` 取复制给子会话的配置，`createChildSession(parentId, { inputContext: task, ... })` 派发子任务；`agent:turn:after` 里 `completeSession()` 回报父会话；按 `status` 与 `lastTurn` 报子任务的状态（被停止的报已停止） | `plugin-subtask/src/index.ts` |
| `plugin-session-server` | 会话协议的会话列表、增删改与设置：`listSessions`、`createSession`、`childConfig`、`updateSession`、`listSettings`、`resolveInheritance`、`getOwnConfig`、`resolvedDefaults` 与各层的读写，摘要的场所取 `placeOf`、`getPlace`，分区按 `kind`（§2.2），入口平台的推法见 §2.4 | `plugin-session-server/src/sessions.ts` |
| `plugin-paper` | 登记白纸与远端代理的六项；`resolveConfig()` 取它们决定房间用哪块白纸、每天能花多少，`listLayers()`、`getLayer()` 看各层写了什么 | `plugin-paper/src/rooms.ts` |
| `plugin-gateway` | 入站时按 `getSession` 与 `roomClass` 判目标会话的房间类别，`owner-only` 的跳过触发与流控两个相位（结构性放行；可选依赖，缺席时全部照常走） | `plugin-gateway/src/index.ts` |
| `plugin-memory-vector` / `plugin-memory-history` / `plugin-tool-session` / `plugin-user-relation` | 各自登记 `MEMORY_RECALL_SCOPE_SETTING`；每次检索或注入时 `resolveConfig()` 取 `memoryRecallScope`，按房间收窄召回范围（可选依赖，缺席时不收窄） | 各包 `src/` |

## 4. 写一个 provider（替换实现）

绝大多数作者**不需要**重写本服务——它是单一参考实现，替换它意味着接管整套生命周期 + 配置解析语义。若确有需要（如换持久化后端或自定义会话模型），按下表实现。

**最小必须**：接口里被实际消费的这几个方法务必正确——`createSession` / `getSession` / `listSessions` / `updateSession` / `ensureSession` / `createChildSession` / `completeSession` / `registerSetting` / `resolveConfig` / `childConfig`。其余（`resolveInheritance` / 各层的读写 / `generateTitle` / ...）主要服务于会话服务、`/session` 与白纸的诊断，可保守实现。`SessionInfo.kind` 是必填字段，建档时按 `sessionKind` 填上。

**设置的语义必须复刻**（否则 Agent 会拿错 LLM）：只认登记过的键，写入按登记的字段校验；`resolveConfig` 按层表 `SESSION_LAYERS` 的先后叠加，选层按 §2.4（平台档钉死出生平台），结果里不带 `sessionDefaults`，全局默认层由服务偏好承担的项不给值（`plugin-session-manager/src/index.ts`）。不钉死时，从 WebUI 驱动 IM 房间会拿到 webui 平台档的工具组。登记与改动要发 `session:config:changed`，会话服务靠它通知客户端重取。

**配置补丁是三态，不是二态**：键不出现 = 不改；键为 `null` = 删除该键、恢复继承；键为 `false` = **显式覆盖**，不等于未设置。存储里读回的 `null`（经 BSON 落盘）与没有同义，解析时跳过；显式 `false` 一路压过继承来的 `true`（`plugin-session-manager/src/settings.ts`）。

下面的骨架只有会话表与设置项登记，没有会话之上的各层（各层为空、按层写被拒）、项目工作区（只有默认工作区）、owner 的 IM 私聊判定、取值校验与持久化：

```ts
import { windowKey } from '@aalis/api-gateway';
import { memory } from '@aalis/api-memory';
import {
  type InheritanceSource,
  type NewSessionFields,
  type RegisteredSessionSetting,
  type SessionConfig,
  type SessionConfigPatch,
  type SessionCreation,
  type SessionInfo,
  type SessionInheritance,
  type SessionManagerService,
  type SessionPlace,
  type SessionSetting,
  type SessionUpdates,
  rootSessionOf,
  sessionKind,
  sessionManager,
} from '@aalis/api-session-manager';
import { type Events, definePlugin, events, logger, provide } from '@aalis/core';

type Values = Record<string, unknown>;

const DEFAULT_PLACE: SessionPlace = { kind: 'workspace', key: 'workspace:default' };

class MySessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  private settings = new Map<string, RegisteredSessionSetting>();
  constructor(private events: Events) {}

  registerSetting(setting: SessionSetting, plugin: string) {
    this.settings.set(setting.key, { ...setting, plugin });
    void this.events.emit('session:config:changed');
    return () => {
      this.settings.delete(setting.key);
      void this.events.emit('session:config:changed');
    };
  }
  listSettings() {
    return [...this.settings.values()];
  }
  /** 只留登记过的键；null 与没有同义。会话上的设置（onSession）不算只能设到场所为止的项 */
  private registered(values: object | undefined, onSession = false): Values {
    return Object.fromEntries(
      Object.entries(values ?? {}).filter(([key, value]) => {
        const setting = this.settings.get(key);
        return value != null && setting !== undefined && !(onSession && setting.narrowest);
      }),
    );
  }
  /** 写入前的检查：没登记的键拒绝（真实现还要按 field 校验取值） */
  private patch(target: object, patch: SessionConfigPatch): Values {
    const out: Values = { ...target };
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) delete out[key];
      else if (!this.settings.has(key)) throw new Error(`会话设置项 ${key} 没有登记`);
      else out[key] = value;
    }
    return out;
  }

  async createSession(opts: NewSessionFields = {}, creation?: SessionCreation): Promise<SessionInfo> {
    if (creation && opts.parentId) throw new Error('建档专用参数只给根会话');
    if ((creation?.workspace ?? 'default') !== 'default' || creation?.work) throw new Error('这个实现只有默认工作区');
    const config = this.patch({}, opts.config ?? {});
    const now = Date.now();
    const id = opts.parentId ? `${opts.parentId}::${crypto.randomUUID().slice(0, 8)}` : `session-${crypto.randomUUID().slice(0, 8)}`;
    const parent = opts.parentId ? this.sessions.get(opts.parentId) : undefined;
    const s: SessionInfo = {
      id,
      name: opts.name ?? id,
      parentId: opts.parentId,
      children: [],
      status: opts.status ?? 'active',
      config,
      createdAt: now,
      updatedAt: now,
      inputContext: opts.inputContext,
      metadata: opts.metadata,
      createdFrom: creation?.createdFrom,
      ...(parent?.currentDir ? { currentDir: parent.currentDir } : {}),
      kind: sessionKind({ parentId: opts.parentId }),
    };
    this.sessions.set(id, s);
    parent?.children.push(id);
    await this.events.emit('session:created', s);
    return s;
  }
  getSession(id: string) {
    return this.sessions.get(id);
  }
  listSessions() {
    return [...this.sessions.values()];
  }
  async updateSession(id: string, { config, ...rest }: SessionUpdates) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} 不存在`);
    const next = config && this.patch(s.config, config);
    Object.assign(s, rest, next ? { config: next } : {}, { updatedAt: Date.now() });
    await this.events.emit('session:updated', s);
    if (next) await this.events.emit('session:config:changed');
    return s;
  }
  async ensureSession(id: string, patch: SessionUpdates = {}, creation?: Pick<SessionCreation, 'createdFrom'>) {
    if (this.sessions.has(id)) return this.updateSession(id, { name: patch.name, status: patch.status, metadata: patch.metadata, config: patch.config });
    const now = Date.now();
    const s: SessionInfo = {
      id,
      name: patch.name ?? id,
      children: [],
      status: patch.status ?? 'waiting',
      config: this.patch({}, patch.config ?? {}),
      createdAt: now,
      updatedAt: now,
      createdFrom: creation?.createdFrom,
      metadata: patch.metadata,
      kind: 'owner',
    };
    this.sessions.set(id, s);
    await this.events.emit('session:created', s);
    return s;
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
    await this.events.emit('session:deleted', id);
  }
  async createChildSession(parentId: string, opts: Omit<NewSessionFields, 'parentId'> = {}) {
    return this.createSession({ ...opts, parentId });
  }
  getChildren(parentId: string) {
    return this.listSessions().filter(s => s.parentId === parentId);
  }
  async completeSession(id: string, result?: string) {
    const s = await this.updateSession(id, { status: 'completed' });
    s.result = result;
    await this.events.emit('session:completed', s);
  }
  /** 项目会话树的根与绑定；不在项目会话树里时抛错 */
  private workTree(sessionId: string) {
    const root = rootSessionOf(this.sessions.get(sessionId), id => this.sessions.get(id));
    if (!root?.work) throw new Error(`会话 ${sessionId} 不在项目会话里`);
    return { root, work: root.work };
  }
  async setCurrentDir(sessionId: string, dir: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    session.currentDir = dir;
    await this.events.emit('session:updated', session);
  }
  async setExtraRoots(sessionId: string, extraRoots: readonly string[]) {
    const { root, work } = this.workTree(sessionId);
    work.extraRoots = [...extraRoots];
    await this.events.emit('session:updated', root);
  }
  async addWorktree(sessionId: string, path: string) {
    const { root, work } = this.workTree(sessionId);
    if (!work.worktrees.includes(path)) work.worktrees.push(path);
    await this.events.emit('session:updated', root);
  }
  /** 场所：有出生平台的为窗口（这个骨架不认 owner 的 IM 私聊；聊天窗口缺失的坏数据缺的段按空串拼），其余为默认工作区 */
  placeOf(sessionId: string): SessionPlace {
    const root = rootSessionOf(this.sessions.get(sessionId), id => this.sessions.get(id));
    if (root?.originPlatform === undefined) return DEFAULT_PLACE;
    const { type = '', targetId = '' } = root.originChat ?? {};
    return { kind: 'window', key: windowKey({ platform: root.originPlatform, type, targetId }) };
  }
  getPlace(key: string) {
    return key === DEFAULT_PLACE.key ? { ...DEFAULT_PLACE, name: '默认工作区' } : undefined;
  }
  addWorkspace(): never {
    throw new Error('这个实现只有默认工作区');
  }
  listWorkspaces() {
    return [{ id: 'default', name: '默认工作区' }];
  }
  async removeWorkspace(): Promise<void> {
    throw new Error('默认工作区不能取消登记');
  }
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance {
    // 没有会话之上的各层，只剩旧数据里父会话的 sessionDefaults
    const values: Values = {};
    const sources: Record<string, InheritanceSource> = {};
    const session = this.sessions.get(sessionId);
    const root = rootSessionOf(session, id => this.sessions.get(id));
    for (const [key, value] of Object.entries(this.registered(this.sessions.get(session?.parentId ?? '')?.config.sessionDefaults, true))) {
      values[key] = value;
      sources[key] = 'parent';
    }
    return { platform: root?.originPlatform ?? platform, values, sources };
  }
  getOwnConfig(sessionId: string): SessionConfig {
    return this.registered(this.sessions.get(sessionId)?.config, true);
  }
  resolveConfig(sessionId: string, platform?: string): SessionConfig {
    return { ...this.resolveInheritance(sessionId, platform).values, ...this.getOwnConfig(sessionId) };
  }
  childConfig(parentId: string, platform?: string): SessionConfig {
    const config: Values = { ...this.resolveConfig(parentId, platform) };
    for (const setting of this.settings.values()) if (setting.liveOnly || setting.narrowest) delete config[setting.key];
    return config;
  }
  /** 没有模型服务可读：由服务偏好承担的项没有实际值 */
  resolvedDefaults(): SessionConfig {
    return {};
  }
  listLayers() {
    return [{ scope: 'defaults' as const }];
  }
  getLayer(): SessionConfig {
    return {};
  }
  resolveLayer() {
    return { values: {}, sources: {} };
  }
  async updateLayer(): Promise<void> {
    throw new Error('这个实现不保存会话之上的各层');
  }
  async generateTitle() {
    return undefined;
  }
  async updateSessionTitle(sessionId: string, title: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.title = title;
  }
}

export default definePlugin({
  name: '@me/plugin-session-manager',
  provides: [sessionManager],
  uses: { provide, events, logger, memory },
  apply({ provide, events, logger, memory }) {
    if (!memory.present) {
      logger.use.error('需要 memory 服务');
      return;
    }
    provide.use(sessionManager, new MySessionManager(events.use), { label: '会话管理', priority: 50 });
  },
});
```

`package.json` **双源**必须与 `uses/provides` 一致（参考实现的样子，`plugin-session-manager/package.json`）：

```jsonc
"keywords": ["aalis", "aalis-plugin"],
"aalis": {
  "service": {
    "required": ["events", "hooks", "lifecycle", "logger", "memory", "provide", "services"],
    "optional": ["agent", "authority", "host-config", "llm", "platform"],
    "provides": ["session-manager"]
  }
}
```

双源校验细节见 [清单元数据](../concepts/manifest-metadata.md)。同名时消费方选中哪一家的规则（本插件偏好 > 全局偏好 > priority > 注册顺序）见 [服务模型](../concepts/service-model.md)。

## 5. 标准消费方式

### 5.1 先看 present + 可选降级

`session-manager` 在很多场景是**可选依赖**（`uses optional`）——它可能没装。业务句柄 `sessionManager.use` 是活的，每次访问成员都解析到本插件当前选中的那一家，存进字段也会跟着换人；缺席时访问成员抛错，所以先看 `present`（见 [惰性服务访问](../concepts/lazy-service-access.md)）：

```ts
// Agent 的标准写法（plugin-agent/src/index.ts）
const sm = sessionManager.present ? sessionManager.use : undefined;
const resolved = sm && sessionId ? sm.resolveConfig(sessionId, platform) : undefined;
// sm 缺失 → resolved 为 undefined → 回落到全局 ServicePreference / 默认行为，不致中断
```

写操作的标准错误边界是「服务不可用即报错或返回错误对象」：先看 `sessionManager.present`，缺席时抛错，或像工具里那样 `if (!sessionManager.present) return JSON.stringify({ error: 'session-manager 服务不可用' })`（`plugin-subtask/src/index.ts`）。

### 5.2 读别的插件登记的键

`resolveConfig` 的结果按 `SessionConfig` 定型，键的类型来自声明它的契约包：读 `persona` 要依赖 `@aalis/api-persona`，读 `memoryRecallScope` 要依赖 `@aalis/api-memory`，读 `llm` 要依赖 `@aalis/api-agent`，读 `enabledToolGroups` 要依赖 `@aalis/api-tools`。白纸的六项只在 plugin-paper 里声明，只有它自己读。登记它的插件没启用时，这个键不在解析结果里，读的一方按「没设置」处理：

```ts
import type {} from '@aalis/api-persona'; // 带来 SessionConfig.persona 的类型
const persona = sessionManager.present ? sessionManager.use.resolveConfig(sessionId, platform).persona : undefined;
```

### 5.3 监听生命周期事件

子任务完成感知就是事件驱动：`completeSession()` 发 `session:completed`，等待方据此收尾（`plugin-session-manager/src/index.ts`）。

## 6. 配置 / 风险 → 影响（provider 与 consumer 必守）

### 6.1 `resolveConfig` 是 Agent 行为的单一事实源

LLM 选择、persona、工具分组、是否结构化输出全部从这里来。Provider 若漏掉某层合并、不按登记过滤或不去掉 `sessionDefaults`，会导致 Agent 静默用错模型 / 人设——合并顺序（§4）必须完整复刻，缺一层就会让消费方拿到错误的生效配置。

### 6.2 会话隔离边界

`sessionId` 是隔离边界：`deleteSession` 会**递归删子会话**并经 `memory:clear` 钩子清空该会话历史（`plugin-session-manager/src/index.ts`）。消费方不要跨 `sessionId` 复用配置或历史。

### 6.3 子任务指令走顶层 `inputContext`（关键约定）

父会话给子任务下达的指令通过 **顶层 `SessionInfo.inputContext`** 传递，而非写入 `metadata`：

- 写入：`plugin-subtask` `createChildSession(parentId, { inputContext: task, ... })`（`plugin-subtask/src/index.ts`）。
- 读取：子任务上下文注入中间件读 `session.inputContext`（顶层，`plugin-subtask/src/index.ts`）；返回给父会话时也是 `session.inputContext`（`plugin-subtask/src/index.ts`）。

实现的 `createSession` 兼容两种来源但**顶层优先**：`inputContext: opts?.inputContext ?? (opts?.metadata?.inputContext)`（`plugin-session-manager/src/index.ts`）。Provider 必须保证 `inputContext` 能从顶层读出来——**只写入 metadata 不写顶层会让子任务读不到任务指令**。

### 6.4 子任务不可嵌套

`plugin-subtask` 在创建前检查 `parentSession?.parentId`，禁止子任务再开子任务（`plugin-subtask/src/index.ts`）。这是消费侧约定，不是服务硬约束——自定义协调器若复用会话树请自行守住，否则会无限递归派发。

### 6.5 标题生成会调 LLM

`generateTitle` 会真发一次 LLM `chat`（模型最浅的思考档，`temperature:0.3`），有成本与延迟；参考实现只给带创建来源的根会话（WebUI 新建的、终端建的，§2.6）在首条消息时自动触发，按会话字段判，不按入口平台，且异步不阻塞消息处理（`plugin-session-manager/src/index.ts`）。IM 房间、按 id 建档的会话与子会话不生成，owner 从 WebUI 往房间插话也不拿来给房间起名。标题监听不建档：WebUI 与终端的会话在第一条消息之前都已建档。第三方平台自动调用前请自行权衡。

### 6.6 IM 房间收录

参考实现在 `inbound:message` 上收录 IM 房间：会话表里还没有记录、不是子任务（id 不含 `::`）的会话，首条真人入站（不带 `source`）到达即按这条消息建档，与是否执行过 `/session.set`、开过子任务无关。WebUI 与终端的会话在入站之前都已建档（§2.6），不经这里。带 `source` 的是内部注入（workflow 的 send-message 与 agent 节点、定时任务、空闲开话题、宿主通知、好友申请与入群邀请的合成通知），不触发登记，每次 workflow 运行不会多出一个持久的房间。

- 登记：状态为 `waiting`，记下来源字段（§2.6）：出生平台取消息的平台；聊天窗口按这个平台适配器的类型声明经 api-gateway 的 `chatScopeOf` 解析，记下类型名、多方标记、机器人账号（消息上的 `selfId`，没有就不记）与目标（多方为群号，一对一为对端账号）。没有适配器的平台同没声明类型，整个平台算一个一对一类型 `private`；消息带的类型名不在平台的声明里时按多方记下，每个平台与类型名告警一次；消息没带类型名而平台声明了多方类型时按其中第一个、多方记下，每个平台告警一次。来源字段之后不变，同一窗口后来的消息带了别的类型名也不改。收录只登记与补名，不改状态；状态翻转见 §7.1。
- 补记来源字段：按 id 兜底建档的根会话（`createChildSession` 给父会话兜底建的、收录之前 `/session.set` 建的）没有来源字段、创建来源与绑定，第一条原生入站到达时按这条消息补记，与按它建档时记下的相同，现名还是 id 的一并补名。只认这个 id 归消息平台的适配器管（认领它的平台只有 `msg.platform`）的入站，WebUI 与终端往房间插话不算。升级前的记录只记了出生平台、没有聊天窗口（也没有创建来源与绑定）的同样补记，只认出生平台的入站：不补记时它们按窗口 `<平台>::` 共用一个场所。带创建来源的（WebUI 与终端预先建档的）、已有聊天窗口的不补记。
- 认领：建档与补记之前用 `@aalis/api-platform` 的 `claimantsOf` 问遍认领这个 id 的适配器（判定与 `resolvePlatformBySession` 相同，逐个问）。认领它的平台不止一个（如终端配置的会话 id 配成了 OneBot 群的 id）时判不出它是哪个平台的窗口，不建档、不补记，每个 id 告警一次，写明哪几个平台认领了它：结果不取决于适配器的登记先后。同一平台的几个实例都认领的仍算一个平台。问的期间别的入站已收录、别处已按 id 建档或会话被删的，问完按会话表此刻的记录判，再同步建档或补记，不会重复建档。
- 所属实例：第一个认领者的插件实例 id 随来源字段记进 `originInstance`（与 `resolvePlatformBySession` 解析到的相同）。会话列表据此把同一插件的多个实例（如两个 OneBot 实例）分组显示；路由不读它。没有适配器认领的（适配器没装好、连接还没上来、账号暂时不属于任何实例）先不记，与读表读进来、还没有 `originInstance` 的房间一样，在下一条真人入站时用 `resolvePlatformBySession` 重新解析，认领到就补记并发 `session:updated`；解析期间会话被删的不写回，同一条记录的解析不并发。已记下的不改；owner 面会话与子任务不记。
- 窗口的场所记录：场所是窗口的房间建档或补记时建它的场所记录（§2.7），显示名取群名或对方昵称（缺省为场所键），之后随出生平台的原生入站更新；owner 的 IM 私聊在默认工作区，不建。
- 取名按多方标记：多方取消息的 `groupName`，一对一取 `nickname`，缺省用会话 id。群的首条入站可能是不带群名的戳一戳，这时同样用 id，不回退到发送者昵称。
- 补名：现名还等于 id 时，后到的出生平台原生入站（`msg.platform` 等于出生平台）带了群名（多方）或昵称（一对一）就补上；从 WebUI 插话的不算，不会把私聊房间起成 owner 的昵称；现名不是 id 的（如 owner 用 `/session.set -n` 起的名）不改；没有聊天窗口的记录（读表时聊天窗口的类型不对被去掉的）判不出取群名还是昵称，不补。
- 规模：每个来过真人消息的群与私聊都登记一次，没有上限。会话表按整表快照落盘（§7.3），每次写的条数随房间数线性增长。

删除 IM 房间与删除其他会话相同，走 scope 为 session 的 `memory:clear`（§6.2），清空它在 Aalis 里的消息历史与长期记忆（摘要、向量记忆等），聊天平台里的消息不受影响；房间里转到后台、仍在运行的工具调用由 plugin-tools 收到 `session:deleted` 后停掉，后台任务登记一并删掉；房间之后再来真人消息会重新登记，记忆从零开始。

### 6.7 liveOnly 的项不随复制冻结

登记为 `liveOnly` 的项（第一方是白纸与远端代理的六项：`paperEnabled`、`paperName`、`remoteAgentTypes` 与三项每日上限）只经继承链实时解析。任何「复制生效配置建新会话」的路径都要经 `childConfig()`：它给出生效配置去掉 `liveOnly` 与只能设到场所为止（`narrowest`）的项。复制会把当时的值冻结进新会话，此后房间或平台档改了不跟着变，子会话还会凭冻结的值继续开远端任务。第一方的两条复制路径（会话服务的 `session/create` 建子会话、plugin-subtask 的 `create_subtask`）都用它。

`memoryRecallScope` 不是 `liveOnly`，必须随子会话复制：子会话不带上更窄的召回范围，经子任务就绕过了收窄。

onebot 等平台派生的房间会话（如 `onebot:<self>:group:<群>`）在首条真人入站到达时由 §6.6 的收录登记，之后就出现在会话列表里，能在会话设置里编辑这些项。

## 7. 注意事项与边界情形

### 7.1 会话状态：回合开始时翻 `active`，同一个中间件收口

参考实现只在回合真正开始时把会话翻成 `active`（「进行中」）：翻转挂在 `agent:input:before` 中间件上，入站消息本身不改状态，群里只有消息、agent 没有开始回合（被触发判定挡下）的房间不会显示「进行中」。同一个中间件把 `next()` 包在 `try/finally` 里，`finally` 记下这一轮（`lastTurn`），并按这一轮的结局收口仍为 `active` 的会话（根会话与子会话一样）：结局为 `error` 的收口为 `error`，其余（`replied`、`silent`、`aborted`，以及消息被拦下、没有结局的一轮）为 `completed`（`plugin-session-manager/src/index.ts`）。结局由另一个挂在 `agent:turn:after` 上的中间件按回合 id 记下：

- `next()` 正常返回时整轮已经跑完，`agent:turn:after` 也已执行（agent 只在这个钩子的默认动作里发它）；
- 排在它后面的输入中间件不调用 `next()` 拦下消息，或者抛错时，agent 不发 `agent:turn:after`，由这里的 `finally` 收口，会话不会停在「进行中」；
- 排在它前面的中间件拦下消息时，它根本不运行，会话也不会被翻成 `active`。

这是唯一的收口。子会话以回复完成时，plugin-subtask 在 `agent:turn:after` 里先以回复为结果调 `completeSession()`，这里见它已不是 `active` 就不再改；出错、被停止或静默的子会话由这里收口，父会话的 `wait_subtasks` 随即返回，不等到超时。同一会话按 lane 可以并行多轮（后台任务结束通知、白纸通知与真人回合各占一条），中间件按回合 id 登记在飞的回合，会话里最后一轮结束才收口，按的是最后结束那一轮的结局；先结束的一轮不会把还在跑的会话显示成已完成。回合中途发出的出站消息（`send_attachment`、`paper_send` 在工具执行中直接发）不收口。

结局为 `replied` 的一轮结束时写入 `lastReplyAt`（她最近开口的时间），别的回合还在跑也照写，随 `session:updated` 推出并落盘；`silent`、`aborted`、`error` 不改它。

每一轮结束时写入 `lastTurn`：结局、结束时间，结局为 `error` 时另带 `agent:turn:after` 的 `error`（一句原因），其余结局即使带了也不记；消息被拦下、没有结局的一轮记为 `silent`，不沿用上一轮的原因。别的回合还在跑也照写，随 `session:updated` 推出并落盘。会话状态里没有「已停止」：被停止的一轮收口为 `completed`，看 `lastTurn.outcome` 是不是 `aborted`。

回合之外建档的会话（终端在发出入站之前建的、`/session.set` 建的档）状态为 `waiting`：首条消息是被指令相位吞掉的指令时没有回合，指令回复不改状态。回合中建档的（如 `create_subtask` 给父会话兜底建档）为 `active`，由这一轮结束时收口。

边界：未装 agent 时没有回合，会话不会翻 `active`；`waiting`、`completed`、`error` 的会话在新一轮开始时翻回 `active`，已归档的不翻，回合结束时也不收口：归档是 owner 不想在列表里看到它，她在那里跑一轮不该让它回到列表，只有手动恢复（会话协议的 `session/unarchive`）才回来，开口时间照常记下；关停时仍为 `active` 的会话由 `onDrain` 收口（§7.3）。

### 7.2 配置解析是同步快照

`resolveConfig` 读内存 Map，不 `await`、不持久等待。若你在 provider 切换瞬间调用，可能拿到旧 manager 的快照；经 §5.1 的业务句柄 `sessionManager.use` 调用，下一次即打到新的那一家，不要把解析结果长期留存。

### 7.3 持久化是延迟刷盘 + 拆卸落盘

写操作走 `markDirty()` → 1s 防抖刷盘。`App.stop()` / bounce / unload 时：`lifecycle.use.onDrain` 调用 `settleActiveOnDrain()`，把仍为 `active` 的会话收口为 `completed` 并立刻落盘（`waiting` / 已终态不动；不依赖 agent 钩子）。随后 `lifecycle.use.onDispose(() => manager.shutdown())` 再刷一次（`shutdown()` 幂等：清定时器 + 置 dirty + `persist()`）（`plugin-session-manager/src/index.ts`）。session-manager 对 memory 是普通依赖：关停以激活为单位分 drain / close，消费者整个 close 完提供者才 drain，因此 drain / `onDispose` 落盘期间 memory 仍在。单独卸载 / 禁用 / 重载 memory 时，本插件作为正在用它的 required 下游并入同一批先关，落盘同样成立。会话表跟随本插件选中的 memory 后端（`memory.follow`）：运行中换成另一个后端时，先把未落盘的变更写回旧后端，再从新后端读取会话表整体替换，不跨后端合并；新表加载完成前的改动仍写回旧后端，旧后端已卸载或停用时写回失败，只记 warn。读取会话表失败时按 1、3、10 秒的间隔重试三次（每次重试前记一条 warn），其间仍用原来的会话表与落盘目标。本插件激活时（启动时，或随选中的 memory 后端卸载、停用、重载而重新激活时）等读表（含重试）结束才对外提供服务：后端持续不可用时，这次重算约多等 14 秒，拓扑序排在本插件之后的插件随之推迟激活，启动时 `app:ready` 也随之推迟。14 秒是三次重试间隔之和，各次读取本身的耗时另计：如 memory-mongodb 连不上库时，每次读取要等到服务器选择超时（`connectTimeoutMs`，默认 5 秒）。换后端、停用或停机会中止重试等待。重试用尽或被中止时会话列表为空，在这个后端上的会话改动不落盘，以免空表覆盖后端原有记录；重试用尽记 error，被中止（停用、停机或换后端）只记一行 info。崩溃（非正常退出）可能丢失最后 ~1s 的会话元数据变更。重写 provider 时若要更强一致性，请在关键写操作后同步落盘。

### 7.4 按会话累加 token

参考实现订阅 `@aalis/api-llm` 的 `llm:usage`（服务商登记模型时经 `metered` 发出，对话、摘要、识图、转写的调用都带会话 id），把每次调用的输入与输出 token 累加进这个会话的 `tokens`（`plugin-session-manager/src/index.ts`）。只记已有的会话：没有会话 id 的调用、会话不存在（含已删除）的不记，也不为用量建会话。累加不改 `updatedAt`（用量不算会话的改动，不改列表的先后），记了就发 `session:updated`、随会话落盘；删除会话时一并清掉。`tokens` 只含这个会话自己的调用，子会话的另记在子会话上，按会话树合计由消费方做。按会话的累计放在会话树上，宿主界面不依赖记账插件就能显示。

## 8. 交叉链接

- [服务模型](../concepts/service-model.md) —— DI 按名解析、同名竞争（preference > priority > 注册顺序）。
- [惰性服务访问](../concepts/lazy-service-access.md) —— 业务句柄为什么是活的。
- [清单元数据](../concepts/manifest-metadata.md) —— `provides`/`uses` 与 `package.json aalis.service` 双源同步与校验。
- [消息-LLM 流水线](../concepts/message-llm-pipeline.md) —— `resolveConfig` 的产物如何进入 `agent:input:before` / `agent:llm:before` / `agent:turn:after`。
- [Agent 服务](agent.md) —— 头号消费方。
- [Memory 服务](memory.md) —— 会话元数据与历史的持久化后端。
- [会话级工具状态服务](tool-session.md) —— 按 `sessionId` 隔离的工具态，与本服务共享同一隔离边界。
- [Persona 服务](persona.md) / `plugin-persona` —— 消费侧窄化类型范例（§5.2）。
