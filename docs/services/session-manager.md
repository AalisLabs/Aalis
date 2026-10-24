# 会话管理服务（session-manager）

> 受众：编写或消费「会话生命周期、场所与会话树」的第三方插件作者。
> 先读 [服务模型](../concepts/service-model.md) 与 [惰性服务访问](../concepts/lazy-service-access.md)；本文是它们在「会话」这个具体服务上的落点。按会话覆盖插件配置（会话设置）不在这里，见 [api-session-settings](../api/api-session-settings.md)。

## 1. 定位

session-manager 维护对话会话的生命周期（创建 / 查询 / 状态 / 树形父子关系）与场所。消费方经 `sessionManager.use` 调用，契约包 `@aalis/api-session-manager`，参考实现 `@aalis/plugin-session-manager`。

核心职责：

- **生命周期与会话树**：CRUD + 父子树 + `active/waiting/completed/error/archived` 状态机；会话状态由本插件**自治维护**（回合开始的 `agent:turn:before` 中间件翻 `active`，同一会话的最后一轮结束时由它收口，见 §7.1），并通过 `session:*` 事件广播（`plugin-session-manager/src/index.ts`）。IM 房间经可等待的 `recordInbound` 收录（§6.6），网关在入站相位之前等它。
- **场所与工作区**：每个会话恰好一个场所（聊天窗口或工作区），子会话取根会话的；工作区由 owner 登记（§2.7）。
- **取别的会话的东西**：一个会话能不能取另一个会话的历史与媒体只有一条规则，就是 `canTake`，范围与三个开关是本插件的按会话字段（§2.8）。
- **插件按会话、按场所存的数据**：会话记录与场所记录各有一份 `metadata`，插件自己读写（§2.4）。session-manager 不认识设置：会话设置的场所层与本会话层由 [plugin-session-settings](../plugins/plugin-session-settings.md) 存在这里。

它**不是**消息存储——历史消息存在 `memory` 服务里；本服务只把会话元数据与场所记录持久化到 `memory` 的 metadata 命名空间 `sessions` 与 `places`（`plugin-session-manager/src/index.ts`）。

## 2. 契约（`@aalis/api-session-manager/src/index.ts`）

### 2.1 服务接口 `SessionManagerService`（`index.ts`）

```ts
// CRUD（kind、来源字段、创建来源、所属工作区、绑定、当前目录、originInstance、lastReplyAt、lastTurn、tokens 由服务推出或写入，
// 不收调用方经会话字段传值）
// creation 是建档专用的参数（创建来源、所属工作区、绑定），只有会话服务与终端传（§2.6）
// 自生成的 id 不落在平台的 id 写法里（子会话一样，不带父会话的 id）：适配器按会话 id 认领窗口与出站，子会话没有窗口
createSession(opts?: NewSessionFields, creation?: SessionCreation): Promise<SessionInfo>;
getSession(id: string): SessionInfo | undefined;
listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
updateSession(id: string, updates: SessionUpdates): Promise<SessionInfo>;   // metadata 与原有的合并（顶层键整键替换）
// 按精确 id 幂等 upsert：命中 → 合并式 update（发 session:updated）；未命中 → 以传入 id（不自生成）建记录（状态缺省：有回合在跑为 active，否则 waiting；发 session:created）。
// 供终端配置的会话 id、在会话管理收录不了的会话上写设置时按原样 id 建档。按 id 建出的记录不带来源字段：IM 房间由参考实现的入站收录记下或补记（§6.6）
ensureSession(id: string, patch?: SessionUpdates, creation?: { createdFrom: string }): Promise<SessionInfo>;
deleteSession(id: string): Promise<void>;            // 连同各级子会话：先发 session:deleted，再清数据（§2.5）
// 原生入站的收录与补记，可等待（§6.6）
recordInbound(message: IncomingMessage): Promise<void>;

// 取别的会话的东西（§2.8）：同步，不抛错。消费方经契约的 takeFrom 调
canTake(currentId: string, targetId: string, principal?: { platform: string; userId: string }): TakeVerdict;

// 树形
  // 父会话未建档时（带 source 的注入回合落在还没建档的会话上）先按原样 id 兜底建档，再挂子会话；兜底建的档没有来源字段与创建来源，是房间的由之后的原生入站补记（§6.6）
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
listPlaces(): PlaceInfo[];                                    // 默认工作区在前，其余按键排
updatePlace(key: string, updates: Pick<PlaceInfo, 'metadata'>): Promise<PlaceInfo>;   // metadata 合并式改，随会话表落盘
addWorkspace(root: string): { workspace: WorkspaceInfo; existed: boolean };
listWorkspaces(): WorkspaceInfo[];
removeWorkspace(id: string): Promise<void>;

// 标题
updateSessionTitle(sessionId: string, title: string): Promise<void>;
```

`getSession` / `listSessions` / `getChildren` / `canTake` / `placeOf` / `getPlace` / `listPlaces` / `listWorkspaces` 是**同步**方法（读内存里的会话表与场所表），不要 `await`。

### 2.2 重要类型

`SessionInfo`（`index.ts`）——会话本体：

```ts
interface SessionInfo {
  id: string;
  name?: string;                   // 没取名的没有，显示经 sessionLabel
  title?: string;                  // AI 总结或父会话指定
  parentId?: string;               // 根会话为 undefined
  children: string[];
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  createdAt: number; updatedAt: number;
  createdFrom?: string;            // 创建来源：建这个会话的审批面的登记名（§2.6）
  inputContext?: string;           // 父会话传入的指令 / 上下文（见 §6.3）
  result?: string;                 // 子会话完成后填，供向父会话汇报
  metadata?: Record<string, unknown>;  // 插件按会话存的数据（§2.4）
  kind: 'owner' | 'room' | 'task'; // SessionKind，见下
  originPlatform?: string;         // 出生平台：IM 房间建档时记下（§6.6）；只有房间的根会话带
  originChat?: { type: string; multiParty: boolean; selfId?: string; targetId: string };  // 聊天窗口：与出生平台同时记下
  workspace?: string;              // 所属工作区的 id；缺省即默认工作区。只有根会话带（§2.6）
  work?: { root: string; extraRoots: string[]; worktrees: string[] };  // 绑定：只有项目会话的根会话带（§2.6）
  currentDir?: string;             // 当前目录：每个会话各带一份，没有值时为场所的主目录（§2.6）
  originInstance?: string;         // 有出生平台的房间：接管它的平台适配器的插件实例 id（§6.6），只供列表分组
  lastReplyAt?: number;            // 她最近一次开口的时间：回合结局为 replied 时写入（§7.1）
  lastTurn?: { outcome: 'replied' | 'silent' | 'aborted' | 'error'; endedAt: number; error?: string | TextRef };  // 最近结束的一轮（§7.1）
  tokens?: { input: number; output: number };  // 这个会话自己的模型调用累计的 token，不含子会话（§7.4）
}
```

`kind` 只按 `parentId` 与出生平台推出（参考实现的私有函数 `describeSession`），新建、建档、补记来源字段与加载入表时覆盖写入，调用方传的值与存储里的旧值都不采信。会话种类由纯函数 `sessionKind({ parentId, originPlatform })` 给出：有父会话为 `task`，有出生平台的为 `room`（IM 房间，含 owner 自己的 QQ 私聊），其余为 `owner`。会话列表的分区（`room` 的进「IM 房间」，其余进「我的会话」，子会话随根会话）、会话设置字段的 `appliesTo` 与会话协议的会话种类都按它。`owner` 只表示「没有出生平台」：包括 `mcp-server`、`workflow::<id>` 与定时任务指定的目标会话，并不都是 owner 本人在说话，不能拿来判断「owner 在场」。

### 2.3 事件 augmentation（`index.ts`）

本 `-api` 包通过 `declare module '@aalis/core'` 增量声明了会话生命周期的事件到 `AalisEvents`：

```ts
'session:created':   [session: SessionInfo];
'session:updated':   [session: SessionInfo];
'session:completed': [session: SessionInfo];
'session:deleted':   [sessionId: string];   // 会话已从表里摘掉、它的数据还没清时发（§2.5）
```

建、删子会话时父会话的子会话列表也变了：子会话的 `session:created` 或 `session:deleted` 之后，父会话随后发一次 `session:updated`。会话列表据此更新父会话的子会话数（[plugin-session-server](../plugins/plugin-session-server.md) 的增量推送）。

**只想监听这些事件**（而不调用服务）的插件也应当依赖本 `-api` 包——它锚定了 `import type {} from '@aalis/core'` 让 augmentation 生效（`index.ts`）。`plugin-file-reader` 就是仅为 `session:deleted` 事件而 `import type {} from '@aalis/api-session-manager'`（`plugin-file-reader/src/index.ts`）。

### 2.4 插件按会话、按场所存的数据（`metadata`）

会话记录与场所记录各有一份 `metadata`（`Record<string, unknown>`），供插件自由使用：随记录落盘、随记录删除，改法都是合并式（顶层键整键替换）——会话经 `updateSession(id, { metadata })`，场所经 `updatePlace(key, { metadata })`。会话管理不解读它，插件各用自己的顶层键，免得互相覆盖。

会话设置就是这样存的：[plugin-session-settings](../plugins/plugin-session-settings.md) 把场所层与本会话层的值放在两种记录的 `metadata['session-settings']` 里，平台档、平台类型档放在宿主配置文档的 `sessionConfig` 里，全局层就是各插件的插件配置。层、解析与读取器见 [api-session-settings](../api/api-session-settings.md)。会话管理没有设置接口，也不发设置变化的事件。

建会话时调用方给的 `metadata` 原样存下，里面的 `title`、`inputContext` 不当成同名字段读：标题与任务指令只认同名字段（§6.3）。

### 2.5 收录、空记录、删除与清空

- **收录**：`recordInbound(message)` 是原生入站的收录与补记（§6.6），可等待。网关在入站相位之前、会话管理在场时等它，所以指令、回复策略、agent、记忆、人设、工具等读取方看到的都是已收录、带聊天窗口的会话；新房间的第一条消息因此多等一次认领查询，已收录的房间不等。这个会话正在删除时先等删除做完。
- **空记录**：`isUnfiled(root)` 判根会话是不是按 id 兜底建档留下的空记录（没有出生平台、创建来源与绑定）。会话设置对空记录不取场所层；会话协议的会话摘要对它不给场所；`placeOf` 对它照旧回默认工作区。参考实现、plugin-cli 与会话设置都用这一个判定。
- **删除**：`deleteSession(id)` 连同下面各级子会话删除，先从表里摘掉，再发 `session:deleted`、经 `memory:clear`（范围 `session`）清它的消息历史与各插件按会话存的数据。`session:deleted` 的监听方在这里停掉这个会话在跑的东西，所以消息历史在它们停下之后才清，回合中途落库的几条不会留在已删会话的归档里。发事件与清数据一起经 agent 的 `clearing` 包住：发事件之前就停下这个会话的回合并等它收尾（没有时限：不响应中止的工具会让删除一直等到它返回），按住到清完；别的监听方（临时区、上传文件、时间线）按激活顺序跑，这时回合已经停下。删除期间到的同一会话的消息怎么处理（新的一代与旧的一代）见 [api-session-manager](../api/api-session-manager.md) 的 `deleteSession`。
- **清空连带删除子会话**：一个会话的消息历史被清空（`memory:clear` 没指定类型或类型含 `context`，且消息历史那一行清成功，按 api-memory 的 `historyCleared` 判）时，参考实现在 `next()` 之后删除它的子会话：范围为 `session` 删这个会话的，为 `all` 删全部子会话。只清别的类型（如 `/clear -t image`）或消息历史没清成时不删。plugin-commands 的 `/clear` 回执据此多一行「已删除 N 个子会话」。

### 2.6 来源字段、创建来源、所属工作区、绑定与房间类别

会话之间的差别按字段判，不按会话 id 的写法，也不靠 id 里有没有冒号：

- **来源字段**（`originPlatform`、`originChat`）：IM 房间的出生平台与聊天窗口，建档时按原生入站记下（§6.6），之后不变，聊天窗口的多方标记也不随适配器的声明改动。只有房间的根会话带，子会话按根会话取（纯函数 `rootSessionOf(info, lookup)`；父会话链断了或成环的坏数据没有根会话）。按 id 建档（`ensureSession`、`createChildSession` 给父会话兜底建档）的记录建档时不带，是房间的由之后的原生入站补记（§6.6），补记之前是空记录（§2.5）；读表时缺这两个字段的记录按没有出生平台，运行时不从 id 推。
- **创建来源**（`createdFrom`）：建这个会话的审批面的登记名，只在建档时经专用参数写：`createSession` 的第二个参数与 `ensureSession` 的第三个参数（`SessionCreation`），不并进 `NewSessionFields`。只有两个写入方：会话服务在 owner 连接调用 `session/create` 时写这条连接所在审批面的登记名（`webui`），终端在发出入站之前给它配置的会话建档时写 `cli`。`ensureSession` 碰上已有的记录时只给按 id 兜底建档留下的空记录（没有创建来源、出生平台与绑定）补写，随这次更新落盘、发 `session:updated`，其余不写。专用参数只给根会话：`createSession` 带 `parentId` 又带它时抛错，会话服务建子会话时不传，子会话按根会话取。
- **所属工作区**（`workspace`）与**绑定**（`work`）：只在建档时经 `SessionCreation` 写，只用于根会话（带了 `parentId` 抛错）。`workspace` 是工作区的 id，须有记录，不带或带 `default` 即默认工作区、不记；在项目工作区里建会话必带 `work: { root }`（绑定目录：工作区的目录，或为这个会话建的同仓 worktree），默认工作区带绑定抛错。绑定目录、空的附加可写目录与 worktree 列表记在根会话上，之后只经 `setExtraRoots`（整份替换）与 `addWorktree`（已记过的不重复记）改，子会话里调用也写到根会话上，子会话按根会话实时看到；取消登记工作区时两者一并清掉（§2.7）。
- **当前目录**（`currentDir`）：建档不写，没有值即场所的主目录；子会话建时取父会话此刻的值，之后各改各的，子会话改当前目录不影响父会话。只经 `setCurrentDir` 改，全部会话都有。
- 目录都是真实路径，由调用方校验。所属工作区、绑定与当前目录随会话表持久化，任何清空都不清，删除会话时随记录删除。

这几项在 `createSession`、`createChildSession`、`ensureSession` 的会话字段参数里带上一律丢弃。读表时类型不对的（来源字段、创建来源、所属工作区、绑定、当前目录）去掉这一项照常载入，并告警。

**房间类别**：纯函数 `roomClass(info, lookup, isOwner)` 按这些字段判这个会话的受众里有谁，子会话取根会话的。它用在按受众定的行为上，如网关的结构性放行、摘要模板、检查点的默认范围与发送者前缀；另有一处按它定能不能取：[media 判据](./media.md#媒体判据)里本机文件的非人回合条款（只有一位参与者、他是 owner、类别不是 `room` 的能取）：

| 会话 | 房间类别 |
|---|---|
| 有出生平台、聊天窗口为多方 | `room` |
| 有出生平台、一对一、对端是 owner 身份（`isOwner(originPlatform, originChat.targetId)`，谓词由调用方传入） | `owner-only` |
| 有出生平台、其余一对一 | `room` |
| 没有出生平台、带创建来源（WebUI 新建的、终端的，含项目会话） | `owner-only` |
| 其余：不在会话表里的、按 id 建档的、`mcp-server`、编排与定时任务的会话、带绑定却没有创建来源的 | `internal` |

只认多方标记，不认类型名；判不出的一律 `internal`，失败关闭。

**从别的平台插话**：纯函数 `fromElsewhere(message, sessionManager)` 判一条入站是不是从别的平台发进房间的（owner 从 WebUI 往群里插话）：入口平台与房间（子会话取根会话）的出生平台不同。`sessionManager` 只用 `present` 与 `use`；会话管理缺席、房间没有出生平台时判不出，按否。

### 2.7 场所与工作区

每个会话恰好一个场所（`SessionPlace`：`kind` 为 `window` 或 `workspace`，`key` 是场所键），子会话取根会话的；场所只管归属与插件按场所存的数据（白纸、会话设置的场所层），不管权限。`placeOf(sessionId)` 按根会话取第一条：

1. 有出生平台：一对一而对端是 owner 身份的（owner 的 IM 私聊）为默认工作区 `workspace:default`；其余为窗口，键是 api-gateway 的 `windowKey` 拼出的 `平台:类型:目标`，不含机器人账号，同一个群里两个账号的会话是同一个窗口。聊天窗口缺失（读表时类型不对被去掉）或目标为空的坏数据同样为窗口，键里缺的段按空串拼，日志点名一次，不落进默认工作区，免得 owner 给工作区设的值套到房间上。owner 谓词取 authority 的 `isOwner`，与房间类别同一判据；参考实现以 `optional(authority)` 取它，没有 authority 时一对一窗口按窗口算。
2. 没有出生平台的按根会话记下的工作区：有值的为 `workspace:<id>`，不看绑定目录；没有的为默认工作区（默认工作区里建的 WebUI 与终端会话、`mcp-server`、编排与定时任务的会话、按 id 建档且还没补记来源字段的会话、会话表里没有的 id）。记下的工作区没有记录（坏数据）时按默认工作区，日志点名。

场所记录 `{ key, kind, name?, root?, metadata?, createdAt, updatedAt }` 存在 metadata 命名空间 `places`，与会话表一同跟随本插件选中的记忆后端加载与写回；必填字段不对（含类别与键对不上）的不载入，移到 `places-rejected`。默认工作区的记录（没有名字，显示经 `placeLabel` 写「默认工作区」）在加载后补上；窗口的记录在 IM 房间建档或补记来源字段时建（§6.6），显示名取群名或对方昵称、随出生平台的入站更新，owner 的 IM 私聊在默认工作区、不建；删除会话不删场所，同一窗口换了会话（另一个机器人账号的会话、以后的 `/new`）照样取到场所的数据。`getPlace(key)` 回这条记录（工作区的目录经 `listWorkspaces` 取），`listPlaces()` 列出全部，`updatePlace` 合并式改它的 `metadata`、随会话表落盘，没有这个键的记录时抛错。场所的白纸 id 由 `placePaperId(key)` 算出（`p:` 加场所键的 UTF-8 十六进制，只有小写，白纸目录在大小写不敏感的文件系统上也不撞），一个场所一张；白纸在白纸根里的目录名由 `paperDirName(paperId)` 给出，白纸插件与触及都调它。

工作区由 owner 经会话服务登记，会话管理只管记录：

- `addWorkspace(root)`：root 是已校验的真实路径，目录校验由调用方做。同一个真实路径只登记一个，已登记的返回那一个（`existed: true`）；否则生成随机的固定编号（不由路径算：目录改名或搬走后记录还在），显示名取文件夹名，允许重名。
- `listWorkspaces()`：默认工作区在前，其后按登记先后；目录在不在不存储，由用到它的一方在用时检查。
- `removeWorkspace(id)`：只删工作区记录（连同它的 `metadata`），不动文件；原属会话（根会话记下的是它的）清掉所属工作区与绑定，会话树里的当前目录一并清掉，回到默认工作区，改了的会话各发 `session:updated`。默认工作区与没有记录的 id 抛错。再添加同一个目录得到的是新工作区。

### 2.8 取别的会话的东西

`canTake(currentId, targetId, principal?)` 是取别的会话的东西（历史、媒体）的唯一规则，回 `{ ok: true }` 或 `{ ok: false, reason }`（`reason` 是文字对象，交给模型的取它的 `source`）。`principal` 是这次动作的一个授权身份：取用类工具经工具调用上下文的 `approveFor` 逐个参与者传，按条过滤的（`recent_messages`）与回复里的标记传 api-tools 的 `actingIdentity`（几个人时是无主体，账号为空的与不传一样），不是谁要的取用（跨会话历史的被动注入）不传。依次：

1. 同一会话 id 放行；两边的根会话都判得出且是同一个（同一棵会话树）放行。两个判不出的根会话不算相同。
2. 任一边的根会话判不出：拒绝，原因是契约导出的 `TAKE_UNKNOWN`。判不出的有：不在会话表里、父会话链断了、按 id 兜底建档的空记录（§2.5）、有出生平台却没有聊天窗口（升级前的旧记录，等下一条原生入站补记）。过了这一步，根会话只有两种：IM 房间（出生平台加聊天窗口）与 owner 的面（有创建来源：WebUI、终端与项目会话）。
3. 范围，取当前会话的生效值：本会话拒绝；同平台要两边根会话的平台相等；全部不比。根会话的平台：IM 房间取出生平台，owner 的面取创建来源（第一方的登记名 `webui`、`cli` 与平台名相同）。
4. 按目标：两边同平台、都记了机器人账号且不同，要「跨机器人账号」（不同平台之间只由范围管）；目标多方（按根会话记下的 `originChat.multiParty`）要「读别的群」；目标一对一（IM 的一对一窗口，以及按与 owner 的一对一处理的 owner 的面）是授权身份自己的私聊的放行，否则要「读别人的私聊」。

「自己的私聊」：owner 的面看授权身份是不是 owner（参考实现取已有的 `optional(authority)`，不在时没有人是 owner）；IM 的一对一窗口按契约导出的纯函数 `oneToOneWith(root, principal, declared, isOwner?)` 判：`declared` 是调用方算好的「出生平台的适配器明确声明了这个窗口的类型为一对一」（推断出的不算：没声明类型的平台整个按一对一记，记下的对端是收录时的第一位发言者），成立时对端就是授权身份的账号、授权身份的平台就是出生平台，或者两边都是 owner 的身份（`isOwner` 由调用方给）。参考实现按已有的 `optional(platform)` 取出生平台适配器的类型声明，取不到时为否。

范围（`takeScope`）与三个开关（`takeOtherGroups`、`takeOthersPrivate`、`takeCrossBot`）是参考实现 configSchema 里的按会话字段（[plugin-session-manager](../plugins/plugin-session-manager.md#配置)），按当前会话取生效值，对所有人一样，owner 也不例外；只看目标，不看当前会话的种类与有没有聊天窗口。

消费方一律调契约的包装函数 `takeFrom(sessionManager, currentId, targetId, principal?)`，不直接调方法、不各写退路：会话管理在时转调 `canTake`，不在时只放行同一会话 id，其余回 `TAKE_UNKNOWN`。第一方消费方：session-history 服务的 `getHistory`（`session_get_history`、`onebot_get_session_history` 都经它）、plugin-tool-onebot 的 `onebot_get_msg`、plugin-memory-history 的被动注入与 `recent_messages`，以及 plugin-image-sender 与 plugin-media 取别的会话的媒体（`send_attachment`、`analyze_image` 与她回复里存储地址的媒体标记，经 api-media 的 `mediaScopeOf` 按媒体所在的会话目录反查会话，见 [media 服务](./media.md#媒体判据)）。向量记忆的召回与关系图不经这条规则，各有自己的范围（[安全模型](../concepts/security-model.md)）。

## 3. 谁提供 / 谁消费

**提供方（唯一参考实现）**：`@aalis/plugin-session-manager`，在 `apply()` 里 `provide.use(sessionManager, manager, { label: '会话管理' })`（`plugin-session-manager/src/index.ts`）。它 `uses required = ['memory']`（另有内置的 `config`、`events`、`hooks`、`lifecycle` 等）、`optional = ['agent','authority','host-config','i18n','llm','platform','session-settings']`（`index.ts`）：会话设置与宿主配置用来按会话读取别的会话的范围与开关。plugin-session-settings 以 required 用会话管理，两边一边 required、一边 optional：会话管理先激活，读取器的登记随会话设置上线补上，会话设置不在时只取插件配置里的值。没有 `memory` 时直接拒绝启动（`index.ts`）。

**典型消费点**：

| 消费方 | 用法 | file:line |
| --- | --- | --- |
| `plugin-session-settings` | 场所层与本会话层的值存在场所与会话记录的 `metadata` 里（`listPlaces`、`updatePlace`、`updateSession`），按 `placeOf` 与 `isUnfiled` 定一个会话取哪几层；在会话管理收录不了的会话上写本会话层时先 `ensureSession` 建档；听 `session:created`、`session:deleted` 推设置变化 | `plugin-session-settings/src/provider.ts` |
| `plugin-gateway` | 入站相位之前等 `recordInbound`；按 `getSession` 与 `roomClass` 判目标会话的房间类别，`owner-only` 的跳过触发与流控两个相位（结构性放行；可选依赖，缺席时全部照常走） | `plugin-gateway/src/index.ts` |
| `plugin-agent` | 按 `getSession` 判会话与它的根会话；`session:deleted` 时中止这个会话的回合并等它收尾（§2.5） | `plugin-agent/src/index.ts` |
| `plugin-subtask` | `createChildSession(parentId, { inputContext: task, metadata })` 派发子任务（metadata 里是会话设置的 `childMetadata`）；`agent:turn:after` 里 `completeSession()` 回报父会话；按 `status` 与 `lastTurn` 报子任务的状态，交回结果后闲置到期 `deleteSession()` | `plugin-subtask/src/index.ts` |
| `plugin-session-server` | 会话协议的会话列表与增删改：`listSessions`、`createSession`、`updateSession`、`deleteSession`，摘要的场所取 `placeOf`、`getPlace`（空记录不给，§2.5），分区按 `kind`（§2.2） | `plugin-session-server/src/sessions.ts` |
| `plugin-memory-summary` | 选摘要模板读会话记录与 `roomClass`（可选依赖，缺席时用工作模板） | `plugin-memory-summary/src/index.ts` |
| `plugin-trigger-policy`、`plugin-trigger-laya`、`plugin-flow-control` | 按 `fromElsewhere` 认出从别的平台往房间里插话，直接放行 | 各自的 `src/index.ts` |
| `plugin-tool-session`、`plugin-tool-onebot`、`plugin-memory-history` | 取别的会话的历史与消息前调 `takeFrom`（§2.8） | 各自的 `src/index.ts` |
| `plugin-image-sender`、`plugin-media` | 经 api-media 的 `mediaScopeOf` 取别的会话的媒体：先调 `takeFrom`（§2.8），按目录名反查媒体所属的会话用 `getSession` 与 `listSessions` | `api-media/src/scope.ts` |
| `plugin-i18n` | 读者按根会话取语言；诊断写场所的显示名（`getPlace`） | `plugin-i18n/src/index.ts` |
| `plugin-cli` | 终端配置的会话在发出入站之前 `ensureSession` 建档并写创建来源 `cli` | `plugin-cli/src/index.ts` |

## 4. 写一个 provider（替换实现）

绝大多数作者**不需要**重写本服务——它是单一参考实现，替换它意味着接管整套生命周期、场所与会话树。若确有需要（如换持久化后端或自定义会话模型），按下表实现。

**最小必须**：接口里被实际消费的这几个方法务必正确——`createSession` / `getSession` / `listSessions` / `updateSession` / `ensureSession` / `deleteSession` / `recordInbound` / `canTake` / `createChildSession` / `completeSession` / `placeOf`。`canTake` 是必填成员：读历史的工具、跨会话历史、按 id 取消息与取别的会话的媒体都只调它（经 `takeFrom`），实现得比 §2.8 宽，这些取用就跟着放宽。其余（场所与工作区、`updateSessionTitle` / ...）主要服务于会话服务、会话设置与白纸，可保守实现。`SessionInfo.kind` 是必填字段，建档时按 `sessionKind` 填上。

**必须复刻的语义**：

- `metadata` 合并式改（顶层键整键替换），会话与场所两种记录都随记录落盘：会话设置的场所层与本会话层存在这里，丢了就丢了设置。
- `deleteSession` 先发 `session:deleted` 再清数据，agent 才能在清之前停掉在跑的回合（§2.5）。
- `recordInbound` 在建档或补记落定之后才兑现：网关等它，入站管道里的读取方按已收录的会话取设置。
- `canTake` 判不出时拒绝（§2.8）：会话表里没有的、空记录与判不出窗口的根会话之间不跨会话取用。

下面的骨架只有会话表，没有来源字段的收录、项目工作区（只有默认工作区）、owner 的 IM 私聊判定、清空时连带删除子会话与持久化；取别的会话只放行同一棵会话树：

```ts
import { windowKey } from '@aalis/api-gateway';
import { memory } from '@aalis/api-memory';
import {
  type NewSessionFields,
  type PlaceInfo,
  type SessionCreation,
  type SessionInfo,
  type SessionManagerService,
  type SessionPlace,
  type SessionUpdates,
  rootSessionOf,
  sessionKind,
  sessionManager,
  TAKE_UNKNOWN,
  type TakeVerdict,
} from '@aalis/api-session-manager';
import { type Events, definePlugin, events, hooks, logger, provide } from '@aalis/core';

const DEFAULT_PLACE: PlaceInfo = { kind: 'workspace', key: 'workspace:default' };

class MySessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  private places = new Map<string, PlaceInfo>([[DEFAULT_PLACE.key, { ...DEFAULT_PLACE }]]);
  constructor(
    private events: Events,
    private clear: (sessionId: string) => Promise<void>,
  ) {}

  async createSession(opts: NewSessionFields = {}, creation?: SessionCreation): Promise<SessionInfo> {
    if (creation && opts.parentId) throw new Error('建档专用参数只给根会话');
    if ((creation?.workspace ?? 'default') !== 'default' || creation?.work) throw new Error('这个实现只有默认工作区');
    const now = Date.now();
    let id: string; // 子会话也一样，不带父会话的 id；撞上已有的会话就重抽
    do id = `session-${crypto.randomUUID().slice(0, 8)}`;
    while (this.sessions.has(id));
    const parent = opts.parentId ? this.sessions.get(opts.parentId) : undefined;
    const s: SessionInfo = {
      id,
      name: opts.name,
      parentId: opts.parentId,
      children: [],
      status: opts.status ?? 'active',
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
  async updateSession(id: string, { metadata, ...rest }: SessionUpdates) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} 不存在`);
    Object.assign(s, rest, metadata ? { metadata: { ...s.metadata, ...metadata } } : {}, { updatedAt: Date.now() });
    await this.events.emit('session:updated', s);
    return s;
  }
  async ensureSession(id: string, patch: SessionUpdates = {}, creation?: Pick<SessionCreation, 'createdFrom'>) {
    if (this.sessions.has(id)) return this.updateSession(id, patch);
    const now = Date.now();
    const s: SessionInfo = {
      id,
      name: patch.name,
      children: [],
      status: patch.status ?? 'waiting',
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
  /** 先摘掉、发事件（监听方停掉在跑的回合），再清数据；子会话一并删 */
  async deleteSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const child of [...s.children]) await this.deleteSession(child);
    this.sessions.delete(id);
    await this.events.emit('session:deleted', id);
    await this.clear(id);
  }
  /** 这个骨架不收录 IM 房间：会话都由 createSession、ensureSession 建 */
  async recordInbound() {}
  /** 只放行同一棵会话树，别的一律判不出（比 §2.8 窄） */
  canTake(currentId: string, targetId: string): TakeVerdict {
    const lookup = (id: string) => this.sessions.get(id);
    const current = rootSessionOf(lookup(currentId), lookup);
    const same = currentId === targetId || (current !== undefined && current === rootSessionOf(lookup(targetId), lookup));
    return same ? { ok: true } : { ok: false, reason: TAKE_UNKNOWN };
  }
  async createChildSession(parentId: string, opts: Omit<NewSessionFields, 'parentId'> = {}) {
    if (!this.sessions.has(parentId)) await this.ensureSession(parentId);
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
    return this.places.get(key);
  }
  listPlaces() {
    return [...this.places.values()];
  }
  async updatePlace(key: string, { metadata }: Pick<PlaceInfo, 'metadata'>) {
    const place = this.places.get(key);
    if (!place) throw new Error(`没有场所 ${key}`);
    place.metadata = { ...place.metadata, ...metadata };
    return place;
  }
  addWorkspace(): never {
    throw new Error('这个实现只有默认工作区');
  }
  listWorkspaces() {
    return [{ id: 'default' }];
  }
  async removeWorkspace(): Promise<void> {
    throw new Error('默认工作区不能取消登记');
  }
  async updateSessionTitle(sessionId: string, title: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.title = title;
  }
}

export default definePlugin({
  name: '@me/plugin-session-manager',
  provides: [sessionManager],
  uses: { provide, events, hooks, logger, memory },
  apply({ provide, events, hooks, logger, memory }) {
    if (!memory.present) {
      logger.use.error('需要 memory 服务');
      return;
    }
    // 清一个会话的数据：消息历史由默认动作清，别的插件按会话存的数据由各自的 memory:clear 中间件清
    const clear = async (sessionId: string) => {
      await hooks.use.run('memory:clear', { scope: 'session', sessionId, results: [] }, () =>
        memory.use.clearSession(sessionId),
      );
    };
    provide.use(sessionManager, new MySessionManager(events.use, clear), { label: '会话管理', priority: 50 });
  },
});
```

`package.json` **双源**必须与 `uses/provides` 一致（参考实现的样子，`plugin-session-manager/package.json`）：

```jsonc
"keywords": ["aalis", "aalis-plugin"],
"aalis": {
  "service": {
    "required": ["config", "events", "hooks", "lifecycle", "logger", "memory", "provide"],
    "optional": ["agent", "authority", "host-config", "i18n", "llm", "platform", "session-settings"],
    "provides": ["session-manager"]
  }
}
```

双源校验细节见 [清单元数据](../concepts/manifest-metadata.md)。同名时消费方选中哪一家的规则（本插件偏好 > 全局偏好 > priority > 注册顺序）见 [服务模型](../concepts/service-model.md)。

## 5. 标准消费方式

### 5.1 先看 present + 可选降级

`session-manager` 在很多场景是**可选依赖**（`uses optional`）——它可能没装。业务句柄 `sessionManager.use` 是活的，缺席时访问成员抛错，所以先看 `present`（规则见 [选择层与业务层](../core/context.md#选择层与业务层)）：

```ts
const sm = sessionManager.present ? sessionManager.use : undefined;
const session = sm?.getSession(sessionId);
// sm 缺失 → session 为 undefined → 按不在会话表里处理，不致中断
```

写操作的标准错误边界是「服务不可用即报错或返回错误对象」：先看 `sessionManager.present`，缺席时抛错，或像工具里那样回一条错误给模型（`plugin-subtask/src/index.ts`）。

### 5.2 按会话读设置

要按会话读的配置项写成插件配置字段并标 `session`，在 apply 里经会话设置的读取门面取读取器，回合里按会话读：

```ts
const fields = caps.sessionFields.use.fields(configSchema, caps);
// 回合里
const { persona } = fields.get(message.sessionId, { platform: message.platform });
```

会话设置缺席（没装、没启用或会话管理没起来）时读取器只取全局层，插件配置里的值照常生效。读别的插件的设置项不行：读取器只读本实例的字段，跨插件要的值改为调拥有它的插件的服务。见 [api-session-settings](../api/api-session-settings.md)。

### 5.3 监听生命周期事件

子任务完成感知就是事件驱动：`completeSession()` 发 `session:completed`，等待方据此收尾（`plugin-session-manager/src/index.ts`）。

## 6. 配置 / 风险 → 影响（provider 与 consumer 必守）

### 6.1 `metadata` 用自己的顶层键

`updateSession` 与 `updatePlace` 的 `metadata` 按顶层键整键替换：两个插件写同一个顶层键会互相覆盖。用插件自己的名字作顶层键（如会话设置的 `session-settings`），读的时候核形状，写坏的部分按缺失处理。

### 6.2 会话隔离边界

`sessionId` 是隔离边界：`deleteSession` 会**递归删子会话**，先发 `session:deleted`，再经 `memory:clear` 钩子清空该会话历史（§2.5，`plugin-session-manager/src/index.ts`）。消费方不要跨 `sessionId` 复用配置或历史；要取别的会话的历史与媒体，一律先调 `takeFrom`（§2.8），不自己判范围。

### 6.3 子任务指令走顶层 `inputContext`（关键约定）

父会话给子任务下达的指令通过 **顶层 `SessionInfo.inputContext`** 传递，而非写入 `metadata`：

- 写入：`plugin-subtask` `createChildSession(parentId, { inputContext: task, ... })`（`plugin-subtask/src/index.ts`）。
- 读取：子任务上下文注入中间件读 `session.inputContext`（顶层，`plugin-subtask/src/index.ts`）；返回给父会话时也是 `session.inputContext`（`plugin-subtask/src/index.ts`）。

实现只认顶层的 `inputContext`，`metadata` 里同名的键原样存下、不当成任务指令读（§2.4）。**只写入 metadata 不写顶层会让子任务读不到任务指令**。

### 6.4 子任务不可嵌套

`plugin-subtask` 在创建前检查 `parentSession?.parentId`，禁止子任务再开子任务（`plugin-subtask/src/index.ts`）。这是消费侧约定，不是服务硬约束——自定义协调器若复用会话树请自行守住，否则会无限递归派发。

### 6.5 标题生成会调 LLM

自动标题是参考实现自己的行为，不在契约里：它会真发一次 LLM `chat`（模型最浅的思考档，`temperature:0.3`），有成本与延迟；只给带创建来源的根会话（WebUI 新建的、终端建的，§2.6）在首条消息时自动触发，按会话字段判，不按入口平台，且异步不阻塞消息处理（`plugin-session-manager/src/index.ts`）。IM 房间、按 id 建档的会话与子会话不生成，owner 从 WebUI 往房间插话也不拿来给房间起名。标题监听不建档：WebUI 与终端的会话在第一条消息之前都已建档。自己实现会话管理的，要不要自动起标题自行权衡。

### 6.6 IM 房间收录

参考实现在 `recordInbound` 里收录 IM 房间：会话表里还没有记录的会话，首条真人入站（不带 `source`）到达即按这条消息建档，与是否执行过 `/session.set`、开过子任务无关。网关在入站相位之前、会话管理在场时等它兑现（§2.5）。WebUI 与终端的会话在入站之前都已建档（§2.6），不经这里；子会话按 `parentId` 不收录。带 `source` 的是内部注入（workflow 的 send-message 与 agent 节点、定时任务、空闲开话题、宿主通知、好友申请与入群邀请的合成通知），不触发登记，每次 workflow 运行不会多出一个持久的房间。

- 登记：状态为 `waiting`，记下来源字段（§2.6）：出生平台取消息的平台；聊天窗口按这个平台适配器的类型声明经 api-gateway 的 `chatScopeOf` 解析，记下类型名、多方标记、机器人账号（消息上的 `selfId`，没有就不记）与目标（多方为群号，一对一为对端账号）。没有适配器的平台同没声明类型，整个平台算一个一对一类型 `private`；消息带的类型名不在平台的声明里时按多方记下，每个平台与类型名告警一次；消息没带类型名而平台声明了多方类型时按其中第一个、多方记下，每个平台告警一次。来源字段之后不变，同一窗口后来的消息带了别的类型名也不改。收录只登记与补名，不改状态；状态翻转见 §7.1。
- 补记来源字段：按 id 兜底建档的根会话（`createChildSession` 给父会话兜底建的、收录之前 `/session.set` 建的）没有来源字段、创建来源与绑定，第一条原生入站到达时按这条消息补记，与按它建档时记下的相同，现名还是 id 的一并补名。只认这个 id 归消息平台的适配器管（认领它的平台只有 `msg.platform`）的入站，WebUI 与终端往房间插话不算。升级前的记录只记了出生平台、没有聊天窗口（也没有创建来源与绑定）的同样补记，只认出生平台的入站：不补记时它们按窗口 `<平台>::` 共用一个场所。带创建来源的（WebUI 与终端预先建档的）、已有聊天窗口的与子会话（没有窗口）不补记。
- 认领：建档与补记之前用 `@aalis/api-platform` 的 `claimantsOf` 问遍认领这个 id 的适配器（判定与 `resolvePlatformBySession` 相同，逐个问）。认领它的平台不止一个（如终端配置的会话 id 配成了 OneBot 群的 id）时判不出它是哪个平台的窗口，不建档、不补记，每个 id 告警一次，写明哪几个平台认领了它：结果不取决于适配器的登记先后。同一平台的几个实例都认领的仍算一个平台。问的期间别的入站已收录、别处已按 id 建档或会话被删的，问完按会话表此刻的记录判，再同步建档或补记，不会重复建档。
- 所属实例：第一个认领者的插件实例 id 随来源字段记进 `originInstance`（与 `resolvePlatformBySession` 解析到的相同）。会话列表据此把同一插件的多个实例（如两个 OneBot 实例）分组显示；路由不读它。没有适配器认领的（适配器没装好、连接还没上来、账号暂时不属于任何实例）先不记，与读表读进来、还没有 `originInstance` 的房间一样，在下一条真人入站时用 `resolvePlatformBySession` 重新解析，认领到就补记并发 `session:updated`；解析期间会话被删的不写回，同一条记录的解析不并发。已记下的不改；owner 面会话与子任务不记。
- 窗口的场所记录：场所是窗口的房间建档或补记时建它的场所记录（§2.7），显示名取群名或对方昵称（缺省为场所键），之后随出生平台的原生入站更新；owner 的 IM 私聊在默认工作区，不建。
- 取名按多方标记：多方取消息的 `groupName`，一对一取 `nickname`，缺省用会话 id。群的首条入站可能是不带群名的戳一戳，这时同样用 id，不回退到发送者昵称。
- 补名：现名还等于 id 时，后到的出生平台原生入站（`msg.platform` 等于出生平台）带了群名（多方）或昵称（一对一）就补上；从 WebUI 插话的不算，不会把私聊房间起成 owner 的昵称；现名不是 id 的（如 owner 用 `/session.set -n` 起的名）不改；没有聊天窗口的记录（读表时聊天窗口的类型不对被去掉的）判不出取群名还是昵称，不补。
- 规模：每个来过真人消息的群与私聊都登记一次，没有上限。会话表按整表快照落盘（§7.3），每次写的条数随房间数线性增长。

删除 IM 房间与删除其他会话相同，走 scope 为 session 的 `memory:clear`（§6.2），清空它在 Aalis 里的消息历史与长期记忆（摘要、向量记忆等），聊天平台里的消息不受影响；房间里转到后台、仍在运行的工具调用由 plugin-tools 收到 `session:deleted` 后停掉，后台任务登记一并删掉；房间之后再来真人消息会重新登记，记忆从零开始。

### 6.7 子会话的设置在建立时写下

建子会话的插件（会话服务的 `session/create` 带 `parentId`、plugin-subtask 的 `create_subtask`）在建之前调会话设置管理面的 `childMetadata`，把父会话此刻每一项适用于子会话的生效值并进 `createChildSession` 的 `metadata` 一次写下，之后父会话与上面各层再改都不影响它；会话设置不在时不建。session-manager 只是原样存下这份 `metadata`。见 [plugin-subtask](../plugins/plugin-subtask.md) 与 [api-session-settings](../api/api-session-settings.md)。

onebot 等平台派生的房间会话在首条真人入站到达时由 §6.6 的收录登记，之后就出现在会话列表里，能在会话设置里编辑它的本会话层与场所层。

## 7. 注意事项与边界情形

### 7.1 会话状态：回合开始时翻 `active`，同一个中间件收口

参考实现只在回合真正开始时把会话翻成 `active`（「进行中」）：翻转挂在 `agent:turn:before` 中间件上，入站消息本身不改状态，群里只有消息、agent 没有开始回合（被触发判定挡下）的房间不会显示「进行中」。同一个中间件把 `next()` 包在 `try/finally` 里，`finally` 记下这一轮（`lastTurn`），并按这一轮的结局收口仍为 `active` 的会话（根会话与子会话一样）：结局为 `error` 的收口为 `error`，其余（`replied`、`silent`、`aborted`，以及被拦下、没有结局的一轮）为 `completed`（`plugin-session-manager/src/index.ts`）。结局由另一个挂在 `agent:turn:after` 上的中间件按回合 id 记下：

- `next()` 正常返回时整轮已经跑完，`agent:turn:after` 也已执行（agent 只在这个钩子的默认动作里发它）；
- 排在它后面的输入中间件不调用 `next()` 拦下消息，或者抛错时，agent 不发 `agent:turn:after`，由这里的 `finally` 收口，会话不会停在「进行中」；
- 排在它前面的中间件拦下消息时，它根本不运行，会话也不会被翻成 `active`。

这是唯一的收口。子会话以回复完成时，plugin-subtask 在 `agent:turn:after` 里先以回复为结果调 `completeSession()`，这里见它已不是 `active` 就不再改；出错、被停止或静默的子会话由这里收口，父会话的 `wait_subtasks` 随即返回，不等到超时。同一会话一轮接一轮（排着的输入在上一轮结束后开下一轮），中间件按回合 id 登记在飞的回合，会话里没有别的在飞回合时这一轮结束才收口，按的是这一轮的结局。回合中途发出的出站消息（`send_attachment`、`paper_send` 在工具执行中直接发）不收口。

结局为 `replied` 的一轮结束时写入 `lastReplyAt`（她最近开口的时间），别的回合还在跑也照写，随 `session:updated` 推出并落盘；`silent`、`aborted`、`error` 不改它。

每一轮结束时写入 `lastTurn`：结局、结束时间，结局为 `error` 时另带 `agent:turn:after` 的 `error`（一句原因），其余结局即使带了也不记；消息被拦下、没有结局的一轮记为 `silent`，不沿用上一轮的原因。别的回合还在跑也照写，随 `session:updated` 推出并落盘。会话状态里没有「已停止」：被停止的一轮收口为 `completed`，看 `lastTurn.outcome` 是不是 `aborted`。

回合之外建档的会话（终端在发出入站之前建的、`/session.set` 在会话管理收录不了的会话上建的档）状态为 `waiting`：首条消息是被指令相位吞掉的指令时没有回合，指令回复不改状态。回合中建档的（如 `create_subtask` 给父会话兜底建档）为 `active`，由这一轮结束时收口。

边界：未装 agent 时没有回合，会话不会翻 `active`；`waiting`、`completed`、`error` 的会话在新一轮开始时翻回 `active`，已归档的不翻，回合结束时也不收口：归档是 owner 不想在列表里看到它，她在那里跑一轮不该让它回到列表，只有手动恢复（会话协议的 `session/unarchive`）才回来，开口时间照常记下；关停时仍为 `active` 的会话由 `onDrain` 收口（§7.3）。

### 7.2 同步读是内存快照

`getSession`、`placeOf` 等读内存里的会话表，不 `await`。若你在 provider 切换瞬间调用，可能拿到旧 manager 的快照；经 §5.1 的业务句柄 `sessionManager.use` 调用，下一次即打到新的那一家，不要把读到的记录长期留存。

### 7.3 持久化是延迟刷盘 + 拆卸落盘

写操作走 `markDirty()` → 1s 防抖刷盘。`App.stop()` / bounce / unload 时：`lifecycle.use.onDrain` 调用 `settleActiveOnDrain()`，把仍为 `active` 的会话收口为 `completed` 并立刻落盘（`waiting` / 已终态不动；不依赖 agent 钩子）。随后 `lifecycle.use.onDispose(() => manager.shutdown())` 再刷一次（`shutdown()` 幂等：清定时器 + 置 dirty + `persist()`）（`plugin-session-manager/src/index.ts`）。session-manager 对 memory 是普通依赖：关停以激活为单位分 drain / close，消费者整个 close 完提供者才 drain，因此 drain / `onDispose` 落盘期间 memory 仍在。单独卸载 / 禁用 / 重载 memory 时，本插件作为正在用它的 required 下游并入同一批先关，落盘同样成立。会话表跟随本插件选中的 memory 后端（`memory.follow`）：运行中换成另一个后端时，先把未落盘的变更写回旧后端，再从新后端读取会话表整体替换，不跨后端合并；新表加载完成前的改动仍写回旧后端，旧后端已卸载或停用时写回失败，只记 warn。读取会话表失败时按 1、3、10 秒的间隔重试三次（每次重试前记一条 warn），其间仍用原来的会话表与落盘目标。本插件激活时（启动时，或随选中的 memory 后端卸载、停用、重载而重新激活时）等读表（含重试）结束才对外提供服务：后端持续不可用时，这次重算约多等 14 秒，拓扑序排在本插件之后的插件随之推迟激活，启动时 `app:ready` 也随之推迟。14 秒是三次重试间隔之和，各次读取本身的耗时另计：如 memory-mongodb 连不上库时，每次读取要等到服务器选择超时（`connectTimeoutMs`，默认 5 秒）。换后端、停用或停机会中止重试等待。重试用尽或被中止时会话列表为空，在这个后端上的会话改动不落盘，以免空表覆盖后端原有记录；重试用尽记 error，被中止（停用、停机或换后端）只记一行 info。崩溃（非正常退出）可能丢失最后 ~1s 的会话元数据变更。重写 provider 时若要更强一致性，请在关键写操作后同步落盘。

### 7.4 按会话累加 token

参考实现订阅 `@aalis/api-llm` 的 `llm:usage`（服务商登记模型时经 `metered` 发出，对话、摘要、识图、转写的调用都带会话 id），把每次调用的输入与输出 token 累加进这个会话的 `tokens`（`plugin-session-manager/src/index.ts`）。只记已有的会话：没有会话 id 的调用、会话不存在（含已删除）的不记，也不为用量建会话。累加不改 `updatedAt`（用量不算会话的改动，不改列表的先后），记了就发 `session:updated`、随会话落盘；删除会话时一并清掉。`tokens` 只含这个会话自己的调用，子会话的另记在子会话上，按会话树合计由消费方做。按会话的累计放在会话树上，宿主界面不依赖记账插件就能显示。

## 8. 交叉链接

- [服务模型](../concepts/service-model.md) —— DI 按名解析、同名竞争（本插件偏好 > 全局偏好 > priority > 注册顺序）。
- [惰性服务访问](../concepts/lazy-service-access.md) —— 业务句柄为什么是活的。
- [清单元数据](../concepts/manifest-metadata.md) —— `provides`/`uses` 与 `package.json aalis.service` 双源同步与校验。
- [消息-LLM 流水线](../concepts/message-llm-pipeline.md) —— 会话设置的生效值如何进入 `agent:turn:before` / `agent:llm:before` / `agent:turn:after`。
- [api-session-settings](../api/api-session-settings.md) —— 会话设置：层、读取器与管理面。
- [Agent 服务](agent.md) —— 头号消费方。
- [Memory 服务](memory.md) —— 会话元数据与历史的持久化后端。
- [会话级工具状态服务](tool-session.md) —— 按 `sessionId` 隔离的工具态，与本服务共享同一隔离边界。
- [Persona 服务](persona.md) / `plugin-persona` —— 按会话读人设的消费方。
