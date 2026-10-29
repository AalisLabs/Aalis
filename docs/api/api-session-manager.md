# api-session-manager — 会话、场所与树形管理契约

**包名**: `@aalis/api-session-manager`  
**源码**: `packages/api-session-manager/src/index.ts`  
**实现**: `@aalis/plugin-session-manager`

## 概述

定义会话的树形层级、会话种类、场所与工作区，以及取别的会话的东西的唯一规则。会话管理不认识设置：插件按会话、按场所存的数据放在会话记录与场所记录的 `metadata` 里，各插件自己读写。会话设置（模型、人设、工具分组等插件配置字段按平台档、平台类型档、场所与会话覆盖）由 [api-session-settings](./api-session-settings.md) 定义、[@aalis/plugin-session-settings](../plugins/plugin-session-settings.md) 实现，场所层与本会话层的值就存在这两种记录的 `metadata` 里。

## 会话

```ts
type SessionKind = 'owner' | 'room' | 'task';

/** 子会话为 task，有出生平台为 room（含 owner 自己的私聊），其余为 owner */
function sessionKind(session: Pick<SessionInfo, 'parentId' | 'originPlatform'>): SessionKind;

interface OriginChat {
  type: string;          // 平台类型名
  multiParty: boolean;   // 多方标记：建档时按适配器的声明记下，之后不随声明改动
  selfId?: string;       // 机器人账号：消息上带了才有
  targetId: string;      // 多方为群号，一对一为对端账号；与窗口键第三段同口径
}

interface WorkBinding {
  root: string;          // 绑定目录（真实路径），建会话时定：所属工作区的目录，或为这个会话建的同仓 worktree
  extraRoots: string[];  // 附加可写目录
  worktrees: string[];   // 本会话树经宿主建的同仓 worktree
}

interface SessionInfo {
  id: string;
  name?: string;                   // 没取名的没有，显示经 sessionLabel
  title?: string;
  parentId?: string;
  children: string[];
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  createdAt: number;
  updatedAt: number;
  createdFrom?: string;            // 创建来源：建这个会话的审批面的登记名（webui、cli）
  inputContext?: string;
  result?: string;
  metadata?: Record<string, unknown>;  // 插件按会话存的数据（如会话设置的本会话层），updateSession 合并式改
  kind: SessionKind;               // sessionKind 的结果
  originPlatform?: string;         // 出生平台：IM 房间建档时记下；只有房间的根会话带
  originChat?: OriginChat;         // 聊天窗口：与出生平台同时记下
  workspace?: string;              // 所属工作区的 id（不带 workspace: 前缀）；缺省即默认工作区。只有根会话带
  work?: WorkBinding;              // 绑定：只有项目会话的根会话带
  currentDir?: string;             // 当前目录：每个会话各带一份，没有值时为场所的主目录
  originInstance?: string;         // 有出生平台的房间：接管它的平台适配器的插件实例 id；只供列表分组
  lastReplyAt?: number;            // 她最近一次开口的时间：回合结局为 replied 时写入
  lastTurn?: { outcome: 'replied' | 'silent' | 'aborted' | 'error'; endedAt: number; error?: string | TextRef };  // 最近结束的一轮
  tokens?: { input: number; output: number };  // 这个会话自己的模型调用累计的 token，不含子会话
}
```

会话种类是会话列表的分区、会话设置字段的 `appliesTo` 与会话协议的 `SessionSummary.kind` 共同的来源。它与审批的发起类别是两回事：审批按这一轮的触发者，owner 在哪个会话里亲手发起的回合都能产生审批。

会话之间的差别按字段判，不按会话 ID 的写法：

- 来源字段 `originPlatform` 与 `originChat`：会话表里还没有记录的会话收到第一条原生入站（不带 `source`、不是子会话）时，参考实现在 `recordInbound` 里按这条消息记下（出生平台取消息的平台，聊天窗口经 api-gateway 的 `chatScopeOf` 按这个平台的类型声明解析），之后不变。只有 IM 房间的根会话带，子会话按根会话取（`rootSessionOf`）。按 ID 建档（`ensureSession`、`createChildSession` 给父会话兜底建档）的记录建档时不带，没有创建来源与绑定的根会话由之后第一条归消息平台的适配器管的原生入站补记；认领这个 ID 的平台不止一个时判不出它是谁的窗口，不收录、不补记。读表时缺这两个字段的记录按没有出生平台，运行时不从 ID 推。
- 创建来源 `createdFrom`：建这个会话的审批面的登记名，经专用参数写（`createSession` 的第二个参数、`ensureSession` 的第三个参数，类型 `SessionCreation`），只有会话服务（owner 连接的 `session/create`，写这条连接所在审批面的登记名）与终端（写 `cli`）传。建档时写；`ensureSession` 碰上既没有创建来源、也没有出生平台与绑定的已有记录（按 ID 兜底建档留下的空记录）时补写，随这次更新落盘、发 `session:updated`，其余已有记录不改。专用参数只给根会话：`createSession` 带 `parentId` 又带它时抛错，子会话按根会话取。
- 所属工作区 `workspace` 与绑定 `work`：只在建档时经 `SessionCreation` 写，只用于根会话，子会话随根会话。`workspace` 是工作区的 id，须有记录（没有时抛错）；不带或带 `default` 即默认工作区，不记。在项目工作区（有目录的）里建会话必带 `work: { root }`（绑定目录，由调用方校验：工作区的目录，或为这个会话建的 worktree），默认工作区带绑定抛错。之后绑定只经 `setExtraRoots`、`addWorktree` 改（写在根会话上），取消登记工作区时清掉。
- 当前目录 `currentDir`：建档不写，没有值即场所的主目录；子会话建时取父会话此刻的值，之后各改各的。只经 `setCurrentDir` 改，全部会话都有。
- 所属工作区、绑定与当前目录随会话表持久化，任何清空都不清，删除会话时随记录删除。

`createSession`、`createChildSession`、`ensureSession` 的会话字段参数里带上这几项一律丢弃。`kind` 由 session-manager 按 `parentId` 与出生平台推出，新建、建档、补记与加载时覆盖写入，调用方传的值与存储里的旧值都不采信；参数类型里同样没有它们，也没有下面四个由 session-manager 写入的字段。

房间类别 `roomClass(info, lookup, isOwner)` 是按这些字段判「受众里有谁」的纯函数，子会话取根会话的；它用在按受众定的行为上（网关的结构性放行、摘要模板、检查点的默认范围、发送者前缀、上传的文件内不内联等），另有一处按它定能不能取（api-media 本机文件判法里非人回合的条款）：有出生平台的，聊天窗口为多方的是 `room`，一对一而对端是 owner 身份的是 `owner-only`（`isOwner` 由调用方传入），其余一对一是 `room`，只认多方标记、不认类型名；没有出生平台、带创建来源的是 `owner-only`；其余（不在会话表里的、按 ID 建档的、`mcp-server`、编排与定时任务的会话）一律 `internal`。

`originChatOf(sessionId, sessionManager)` 取会话所在的聊天窗口，即根会话建档时记下的 `originChat`（子会话取根会话的）；会话管理缺席、会话不在表里或根会话没有聊天窗口时为 `undefined`。判是不是多方读它的 `multiParty`。

`fromElsewhere(message, sessionManager)` 判一条入站是不是从别的平台发进房间的（owner 从 WebUI 往群里插话）：入口平台与房间（子会话取根会话）的出生平台不同。`sessionManager` 只用 `present` 与 `use`；会话管理缺席、房间没有出生平台时判不出，按否。触发插件与流控对它直接放行。

- `originInstance`：接管这个房间的适配器的插件实例 id（`contextId`），与 `@aalis/api-platform` 的 `resolvePlatformBySession` 解析到的相同：收录与补记来源字段之前已问过认领这个 ID 的适配器（`claimantsOf`），第一个认领者随来源字段一起记下，落盘保存，记下后不再重算。会话列表据此把同一插件的多个实例分组显示；路由不读它，平台动作仍按会话 ID 实时路由。还没有适配器认领（适配器没装好、连接还没上来、账号暂时不属于任何实例）的为 undefined，下一条真人入站时重新解析，认领到就补记并发 `session:updated`；同一条记录已有解析在途的不重复解析。按 ID 建档（`ensureSession`）的记录没有出生平台，补记来源字段时才记下。
- `lastReplyAt`：回合结局（`agent:turn:after` 的 `outcome`）为 `replied` 时写入，`silent`、`aborted`、`error` 不改；同一会话别的回合还在跑时同样写入，随 `session:updated` 推出。
- `lastTurn`：每一轮结束时写入这一轮的结局（取值同 `agent:turn:after` 的 `outcome`；消息被拦下、没有结局的一轮记为 `silent`）与结束时间；结局为 `error` 时带 `agent:turn:after` 给的一句原因（`error`，最多留 200 字，空串当作没给），其余结局不带。别的回合还在跑时同样写入，随 `session:updated` 推出并落盘。被停止的会话收口为 `completed`，从 `lastTurn.outcome` 为 `aborted` 看出。
- `tokens`：按 `@aalis/api-llm` 的 `llm:usage` 累加这个会话自己的输入与输出 token（对话、摘要、识图、转写的调用都带会话 id），不含子会话。只记已有的会话，不为用量建会话；不改 `updatedAt`，记了就发 `session:updated`；随会话落盘，删除会话时一并清掉。

`status` 的变化：回合开始时翻 `active`；会话里最后一轮结束时，仍为 `active` 的会话（根会话与子会话一样）按这一轮的结局收口，结局为 `error` 的收口为 `error`，其余（含被停止、消息被拦下、没有结局的一轮）为 `completed`。子会话以回复完成时，plugin-subtask 在回合结束之前先以回复为结果调 `completeSession`。种类 `owner` 只表示「没有出生平台」，包括 `mcp-server`、`workflow::<id>` 与定时任务指定的目标会话，不代表 owner 本人在场。

收录与空记录：

- `recordInbound(message)` 是原生入站的收录与补记，可等待：这个会话正在删除时先等删除做完；带 `source` 的、没有会话 ID 的直接兑现，子会话按 `parentId` 不收录；要收录或补记的，问完认领者、建档或补记落定之后才兑现；已收录的照旧补名、更新窗口的显示名，不等这些。同一会话并发调用共用同一次收录，收录失败只告警、不拒绝。网关在入站相位之前等它（[api-gateway](./api-gateway.md)），入站管道里的读取方（指令、回复策略、agent、记忆、人设、工具等）看到的都是已收录、带聊天窗口的会话。
- `isUnfiled(root)` 判根会话是不是按 ID 兜底建档留下的空记录：没有出生平台、创建来源与绑定。这种记录由 `createChildSession` 给不在表里的父会话兜底建档等路径造出，IM 房间收到原生入站后补记出生平台，之后不再是。会话设置对空记录不取场所层，会话协议的会话摘要对它不给场所。

建会话与改会话：

- `createSession`、`createChildSession`、`ensureSession` 的 `metadata` 原样存下，里面的 `title`、`inputContext` 不当成同名字段读：标题与任务指令只认同名字段。
- `updateSession` 的 `metadata` 与原有的合并，顶层键整键替换，发 `session:updated`。

删除与清空：

- `deleteSession(id)` 连同下面各级子会话删除：先从表里摘掉，再发 `session:deleted`、经 `memory:clear` 清它的消息历史与各插件按会话存的数据。监听方在 `session:deleted` 里停掉这个会话在跑的东西，所以消息历史在它们停下之后才清。参考实现有 agent 时摘掉之后就把整个删除（先删各级子会话，再发事件、清数据）交给它的 `clearing`（[api-agent](./api-agent.md)），先停下这个会话的回合并按住它，到清完。新旧两代按代号分（`generationOf`）：开始删除之后到的同一会话的消息（带 `source` 的也一样）在 `recordInbound` 里等删除做完，是新的一代，不被这次删除停下，存档也不被它清掉；这之前已过 `recordInbound` 的是旧的一代，网关交给 agent 之前、agent 交给通道之前比代号放掉、不归档。
- `generationOf(sessionId)` 是这个会话此刻的代号：开始删除时（与让新来的入站在 `recordInbound` 里等着同一步，同步地，带子会话的先于删子会话）换成这个会话没给过的值；其余时候不变，删过的 ID 之后再建档也不变，所以要一直留着。只按相等比。据它比对的只有上一条说的两处（[api-agent](./api-agent.md) 的 `handleMessage`、[plugin-gateway](../plugins/plugin-gateway.md)）：入站相位里挂过删完时刻的旧一代，指令照样执行，被触发判定或流控吞掉的照旧影子归档（IM 房间按下一条重新建档后在新的历史里）。会话管理不在时没有删除，两边都不比。参考实现按 ID 记开始删除的次数，没删过的为 0，删过的 ID 每个占一项；这张表随会话管理的这次激活，重新激活（重启、改它的配置、重载）时清空，这期间在途的消息可能被误放掉，删除之前的一代也可能被放过。
- 一个会话的消息历史被清空（`memory:clear` 没指定类型或类型含 `context`，且消息历史那一行清成功，判法是 [api-memory](./api-memory.md) 的 `historyCleared`）时，它的子会话一并删除：范围为 `session` 删这个会话的子会话，为 `all` 删全部子会话。只清别的类型、或消息历史没清成时不删。

## 取别的会话的东西

一个会话能不能取另一个会话的东西（历史、媒体）只有一条规则，就是服务上的必填方法 `canTake`；消费方一律调包装函数 `takeFrom`。

```ts
type TakeVerdict = { ok: true } | { ok: false; reason: TextRef };
/** 判不出会话的来历时的原因：包装函数与实现共用 */
const TAKE_UNKNOWN: TextRef;
/** 会话管理在时转调 canTake；不在时只放行同一会话 id，其余回 TAKE_UNKNOWN */
function takeFrom(
  sessionManager: Pick<ServiceSelection<SessionManagerService>, 'present' | 'use'>,
  currentId: string,
  targetId: string,
  principal?: { platform: string; userId: string },
): TakeVerdict;
/** IM 的一对一窗口是不是授权身份自己与她的私聊（room 是根会话） */
function oneToOneWith(
  room: Pick<SessionInfo, 'originPlatform' | 'originChat'>,
  principal: { platform: string; userId: string } | undefined,
  declared: boolean,
  isOwner?: (platform: string, userId: string) => boolean,
): boolean;
```

`canTake(currentId, targetId, principal?)` 同步给出、不抛错，`principal` 是这次动作的一个授权身份（取用类工具经工具调用上下文的 `approveFor` 逐个参与者传，按条过滤的与回复里的标记传 api-tools 的 `actingIdentity`，几个人时是无主体，账号为空的与不传一样；跨会话历史的被动注入不传）。依次：

1. 同一会话 id，或两边的根会话都判得出且是同一个：放行。
2. 任一边的根会话判不出（不在会话表里、父会话链断了、`isUnfiled` 的空记录、有出生平台却没有聊天窗口）：拒绝，原因 `TAKE_UNKNOWN`。
3. 范围，取当前会话的生效值：本会话拒绝；同平台要两边根会话的平台相等（IM 房间取出生平台，WebUI、终端与项目会话取创建来源）；全部不比。
4. 按目标：两边同平台、都记了机器人账号且不同，要「跨机器人账号」；目标多方要「读别的群」；目标一对一（IM 的一对一窗口，以及按与 owner 的一对一处理的 WebUI、终端与项目会话）是授权身份自己的私聊的放行，否则要「读别人的私聊」。

范围与三个开关是参考实现的按会话字段（[plugin-session-manager](../plugins/plugin-session-manager.md#配置)），对所有人一样，owner 也不例外。拒绝的原因是文字对象，交给模型的取它的 `source`，不写平台名。

`oneToOneWith` 判「自己的私聊」：`declared` 是调用方算好的「出生平台的适配器明确声明了这个窗口的类型为一对一」（推断出的不算；本包不读适配器的声明）；成立时对端就是授权身份的账号、授权身份的平台就是出生平台，或者两边都是 owner 的身份（`isOwner` 由调用方给，不给时只认前一种）。没有授权身份、授权身份没有账号的不算。

`canTake` 是 `SessionManagerService` 的必填成员：自己实现会话管理的要实现它，没有可选写法。

## 场所与工作区

每个会话恰好一个场所，子会话取根会话的。场所只管归属与插件按场所存的数据（白纸、会话设置的场所层），不管权限（触及的上限按这一轮的主体）。

```ts
interface SessionPlace {
  kind: 'window' | 'workspace';   // window：IM 的群与别人的私聊；workspace：本机的工作区
  key: string;                    // 窗口为 `平台:类型:目标`；工作区为 `workspace:<id>`，默认工作区为 `workspace:default`
}
interface PlaceInfo extends SessionPlace {
  name?: string;                  // 显示名；默认工作区没有，显示经 placeLabel。工作区的目录经 WorkspaceInfo 取
  metadata?: Record<string, unknown>;  // 插件按场所存的数据，经 updatePlace 合并式改，随场所记录落盘
}
interface WorkspaceInfo {
  id: string;                     // 默认工作区为 default
  name?: string;
  root?: string;
}
/** 场所的显示名：没有名字时为「默认工作区」（文字对象） */
function placeLabel(place: Pick<PlaceInfo, 'name'>): string | TextRef;
/** 场所的白纸 id：`p:` 加场所键的 UTF-8 十六进制（只有小写，大小写不敏感的文件系统上不同的键不会落进同一个目录） */
function placePaperId(key: string): string;
/** 白纸在白纸根（stage/paper）里的目录名：白纸 id 的 `:` 换成 `-`；白纸插件与触及都按它取 */
function paperDirName(paperId: string): string;
```

`placeOf(sessionId)` 按根会话取第一条：

1. 有出生平台：一对一而对端是 owner 身份的（owner 的 IM 私聊）为默认工作区；其余为窗口，键由 api-gateway 的 `windowKey` 拼出，不含机器人账号，同一个群里两个账号的会话是同一个窗口。聊天窗口缺失（读表时类型不对被去掉）或目标为空的坏数据同样为窗口，键里缺的段按空串拼，日志点名一次，不落进默认工作区：owner 给工作区设的值不会套到房间上。owner 谓词取 authority 的 `isOwner`（与房间类别同一判据），没有 authority 时一对一窗口按窗口算。
2. 没有出生平台的按根会话记下的工作区：有值的为 `workspace:<id>`（绑定在这个工作区仓库的 worktree 上的会话也是它，不看绑定目录）；没有的为默认工作区——WebUI 与终端在默认工作区建的会话、没有发起会话的内部会话（`mcp-server`、编排、定时任务）、按 ID 建档且还没补记来源字段的会话，以及会话表里没有的 ID。记下的工作区没有记录（坏数据）时按默认工作区，日志点名。

场所记录 `{ key, kind, name?, root?, metadata?, createdAt, updatedAt }` 存在记忆后端元数据的 `places` 命名空间，与会话表一同跟随选中的记忆后端加载与写回。`listPlaces()` 列出全部场所记录（默认工作区在前，其余按键排）；`updatePlace(key, { metadata })` 合并式改 `metadata`（顶层键整键替换），没有这个键的记录时抛错。默认工作区的记录在激活时补上；窗口的记录在 IM 房间建档或补记来源字段时建（owner 的 IM 私聊在默认工作区，不建），显示名取群名或对方昵称，随出生平台的入站更新；删除会话不删场所，同一窗口换了会话照样取到它的数据（如场所层的设置）。窗口场所不提供删除。

工作区：

- `addWorkspace(root)`：root 是已校验的真实路径（目录校验由调用方做）。同一个真实路径只登记一个，已登记的返回那一个（`existed: true`）；否则生成随机的固定编号（不由路径算），显示名取文件夹名，允许重名。
- `listWorkspaces()`：全部工作区，默认工作区在前，其后按登记先后。目录在不在由用到它的一方在用时检查，不存储。
- `removeWorkspace(id)`：只删工作区记录（连同它的 `metadata`），不动文件；原属会话（根会话记下的是它的）清掉所属工作区与绑定，会话树里的当前目录一并清掉，回到默认工作区，各发 `session:updated`。默认工作区与没有记录的 ID 抛错。之后再添加同一个目录得到的是新工作区。

## 服务接口（节选）

描述符 `sessionManager`（`name: 'session-manager'`），调用型：业务层就是 `SessionManagerService` 形状的活句柄。

```ts
interface SessionManagerService {
  createSession(opts?, creation?: SessionCreation): Promise<SessionInfo>;
  getSession(id: string): SessionInfo | undefined;
  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
  updateSession(id, updates: SessionUpdates): Promise<SessionInfo>;   // metadata 合并式改
  ensureSession(id, patch?, creation?: { createdFrom: string }): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;                            // 先发 session:deleted，再清数据
  recordInbound(message: IncomingMessage): Promise<void>;              // 原生入站的收录与补记，可等待
  generationOf(sessionId: string): number;                             // 代号：开始删除时换，分删除前后的两代
  canTake(currentId: string, targetId: string, principal?): TakeVerdict;  // 取别的会话的东西，消费方经 takeFrom 调
  createChildSession(parentId, opts?): Promise<SessionInfo>;
  getChildren(parentId: string): SessionInfo[];
  completeSession(id: string, result?: string): Promise<void>;

  setCurrentDir(sessionId: string, dir: string): Promise<void>;                    // 这个会话自己的当前目录
  setExtraRoots(sessionId: string, extraRoots: readonly string[]): Promise<void>;  // 写到项目会话的根会话上
  addWorktree(sessionId: string, path: string): Promise<void>;                     // 写到项目会话的根会话上

  placeOf(sessionId: string): SessionPlace;
  getPlace(key: string): PlaceInfo | undefined;
  listPlaces(): PlaceInfo[];
  updatePlace(key: string, updates: Pick<PlaceInfo, 'metadata'>): Promise<PlaceInfo>;
  addWorkspace(root: string): { workspace: WorkspaceInfo; existed: boolean };
  listWorkspaces(): WorkspaceInfo[];
  removeWorkspace(id: string): Promise<void>;

  updateSessionTitle(sessionId: string, title: string): Promise<void>;
}
```

> 完整签名以源码 `index.ts` 为准；上面是消费方最常用的部分。

事件：`session:created`、`session:updated`（建、删子会话时父会话的子会话列表也变了，父会话随后发一次）、`session:completed`、`session:deleted`（会话已从表里摘掉、它的数据还没清时发）。

## 实现者

- [@aalis/plugin-session-manager](../plugins/plugin-session-manager.md) — 会话与场所记录持久化到 `MemoryService` 的 `sessions`、`places` namespace

## 相关

- 会话设置（层、读取器、`/session` 系列指令）见 [api-session-settings](./api-session-settings.md) 与 [plugin-session-settings](../plugins/plugin-session-settings.md)
- 会话在会话协议上的读写见 [api-session-protocol](./api-session-protocol.md)
