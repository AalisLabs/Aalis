// ----- 会话管理服务接口（types + 描述符 + 事件 augmentation）-----
//
// 该包是 plugin-session-manager 的契约边界：类型、运行时描述符
// `sessionManager`，以及 session:* 事件 augmentation。
// 下游应 `import { sessionManager } from '@aalis/api-session-manager'`
// 写入 uses；不要依赖 impl 包，以免工作区依赖与编译循环。

import { Buffer } from 'node:buffer';
// 锚定 @aalis/core，使下方 declare module 的 AalisEvents 增强生效。
import type {} from '@aalis/core';
import { defineService } from '@aalis/core';
import type { SchemaField } from '@aalis/schema-config';

/**
 * 会话设置：各设置项的值。本包不认识任何具体的键，键由拥有这项功能的插件登记（{@link SessionSetting}），
 * 值的类型经 declaration merging 注入，与 AalisEvents 同一写法：
 *
 * ```ts
 * declare module '@aalis/api-session-manager' {
 *   interface SessionConfig {
 *     persona?: string;
 *   }
 * }
 * ```
 *
 * 每个键都可选：没有这个键即继承上层。解析结果只含已登记、取值合法的键。
 */
export interface SessionConfig {}

/**
 * 会话档案里存的配置：会话自己对各设置项的覆盖。sessionDefaults 是旧数据里父会话给子会话的默认值，
 * 解析时照常生效（来源为 parent），不再有写入口
 */
export type StoredSessionConfig = SessionConfig & { sessionDefaults?: SessionConfig };

/** 写会话或某一层的设置：给值即写入（按登记的字段校验），null 删掉这一项、恢复继承，没给的键不动 */
export type SessionConfigPatch = { [K in keyof SessionConfig]?: SessionConfig[K] | null };

/**
 * 会话种类：task 为子会话；room 为有出生平台的根会话（IM 房间，含 owner 自己的私聊）；其余为 owner
 * （owner 在 WebUI 与 CLI 的会话，以及 mcp-server、`workflow::<id>` 等没有出生平台的根会话）。
 * 会话列表的分区、设置项的 appliesTo 与会话协议的会话种类都按它。与审批的发起类别是两回事：
 * owner 在自己的私聊里亲手发起的回合照样能产生审批
 */
export type SessionKind = 'owner' | 'room' | 'task';

/** 会话种类：有父会话为 task，有出生平台为 room，其余为 owner */
export function sessionKind(session: Pick<SessionInfo, 'parentId' | 'originPlatform'>): SessionKind {
  if (session.parentId) return 'task';
  return session.originPlatform === undefined ? 'owner' : 'room';
}

/**
 * 设置项的显眼程度：composer 也出现在输入框旁的快捷切换（同一会话最多两项，多出的按 order 退到 common），
 * common 在设置里排在前面，advanced 收进默认折叠的「高级」，按登记它的插件分组
 */
export type SettingProminence = 'composer' | 'common' | 'advanced';

/**
 * 一个会话设置项，由拥有这项功能的插件经 `sessionManager.registerSetting` 登记，随它的激活撤回。
 * 插件没装或没启用时，它的键在会话与各层里原样保留，但不显示、不参与解析，重新启用后恢复。
 *
 * 同一个键可以由几个插件登记，须是同一份内容的定义（逐项深比较，validate 比较函数本身；进程里装了两份契约包时
 * 不是同一个对象也认）：几个插件共同遵守的设置项由契约包导出定义、各自登记，只要还有一个登记者在场，这一项就有效
 */
export interface SessionSetting {
  /** 键：登记它的插件要先经 declaration merging 把它加进 {@link SessionConfig} */
  key: keyof SessionConfig & string;
  /**
   * schema-config 字段：类型、标签、说明、校验与可选项来源（dynamicOptions）。写入时按它校验，不合的拒绝；
   * 存储里不合它的值（旧数据、手写的配置文件）解析时当作没设置并告警，标了 `onInvalid: 'error'` 的则原样交出、
   * 不回落到下面的层，由登记它的插件按拒绝处理（例如金额上限写坏了按 0，不能退成不限）。
   * 没有任何一层设置时解析结果里没有这个键：`default` 只供界面显示，须与「没有这个键」时的行为一致
   */
  field: SchemaField;
  /** 适用的会话种类：会话的设置只列适用于它的种类的项 */
  appliesTo: readonly SessionKind[];
  /**
   * 最窄能设到哪一层：place 即只能设在场所及以上（全局默认、平台档、平台类型档、场所），会话自己的覆盖不收它，会话上存着的
   * 旧值（会话自己的覆盖、父会话给子会话的默认值）也不参与解析。不写即可设到本会话。按房间的设置（如白纸）设在场所上，
   * 换会话不丢
   */
  narrowest?: 'place';
  prominence: SettingProminence;
  /** 同一显眼程度里的先后，小的在前；不写排在写了的后面 */
  order?: number;
  /** 只经继承链实时解析：建子会话复制父会话的生效配置时不带它，免得把当时的值冻结进子会话 */
  liveOnly?: boolean;
  /**
   * 可选项依赖另一项的生效值：取这一项的动态可选项（field.dynamicOptions）时带上那一项在这个会话或这一层的生效值，
   * 那一项变了就重取。例如深度思考的档位按模型取。依赖的须是另一个键，字段须有 dynamicOptions。依赖值只交给会读它的
   * 可选项来源（目前是 webui-server 的 llm-thinking），走服务 listModels() 的可选项拿不到它
   */
  dependsOn?: keyof SessionConfig & string;
  /**
   * 哪一层都没设、字段又没有默认值时这一项的含义，界面在生效值的位置写它（如「按插件配置」「不限」）。写得出具体值的用
   * `field.default`，不用它
   */
  unset?: string;
  /**
   * 取值校验：合法时返回 undefined，不合法时返回原因。写入与解析都先过它，再按字段校验，结果与字段校验不合同样处理。
   * schema-config 不校验外来字段类型（如 api-llm 的 `'llm-ref'`）的取值，所以外来类型的设置项必须给出它，否则登记抛错
   */
  validate?(value: unknown): string | undefined;
}

/** 已登记的设置项：另带登记它的插件实例 id（几个插件登记同一项时取最先登记、仍在场的那个） */
export interface RegisteredSessionSetting extends SessionSetting {
  plugin: string;
}

/**
 * 写会话设置被拒：键没有登记（提供它的插件没装或没启用）、值不合登记的字段，或层的标识不合法。
 * 用 {@link isSessionConfigError} 判定，不用 instanceof
 */
export class SessionConfigError extends Error {
  override name = 'SessionConfigError';
}

/** 判定写会话设置被拒：只按 name 判定，进程里装了两份本包时也认得 */
export function isSessionConfigError(err: unknown): boolean {
  return (err as { name?: unknown } | null | undefined)?.name === 'SessionConfigError';
}

/**
 * 会话设置的层，先后即生效顺序（后面的压过前面的）。读取、解析、来源显示、可设的层与选层都照这张表走，
 * 加一层是这里加一行、会话管理的实现表加一条、{@link SessionConfigLayer} 加一种
 */
export const SESSION_LAYERS = [
  { name: 'defaults', label: '全局默认' },
  { name: 'platform', label: '平台档' },
  { name: 'type', label: '平台类型档' },
  { name: 'place', label: '场所' },
  { name: 'parent', label: '父会话' },
  { name: 'session', label: '本会话' },
] as const;

/** 层名 */
export type SessionLayerName = (typeof SESSION_LAYERS)[number]['name'];

/** 继承链的层（不含本会话） */
export type InheritanceSource = Exclude<SessionLayerName, 'session'>;

/**
 * 会话之上能单独读写的层（父会话与本会话经会话本身读写）：全局默认、某个平台的平台档（按平台名，不区分适配器实例）、
 * 某个平台某种类型的平台类型档、某个场所。平台名与类型名非空、不含 `:`、不是 `*`；场所键是已有的场所记录
 */
export type SessionConfigLayer =
  | { scope: 'defaults' }
  | { scope: 'platform'; platform: string }
  | { scope: 'type'; platform: string; type: string }
  | { scope: 'place'; key: string };

/** 场所：会话长期所在的地方，每个会话恰好一个，子会话取根会话的。场所只管归属、白纸与设置层，不管权限 */
export interface SessionPlace {
  /** window：IM 的群与别人的私聊；workspace：本机的工作区（默认工作区、项目工作区） */
  kind: 'window' | 'workspace';
  /**
   * 场所键：窗口为 `平台:类型:目标`（api-gateway 的 windowKey，不含机器人账号）；工作区为 `workspace:<id>`
   * （id 是建工作区时随机生成的固定编号，不由路径算），默认工作区为 `workspace:default`
   */
  key: string;
}

/**
 * 场所记录对外的样子：显示名。场所自己的设置经按层读写取（层为 `{ scope: 'place', key }`），工作区的目录经
 * {@link WorkspaceInfo} 取
 */
export interface PlaceInfo extends SessionPlace {
  /** 显示名：窗口取群名或对方昵称，随消息更新；默认工作区为「默认工作区」；项目工作区默认取文件夹名，允许重名 */
  name: string;
}

/** 工作区：默认工作区的 id 为 default。目录在不在由用到它的一方在用时检查，不存储 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  /** 目录的真实路径：只有项目工作区带 */
  root?: string;
}

/**
 * 场所的白纸 id：`p:` 加场所键的 UTF-8 十六进制。同一个场所一张白纸，换会话照样是它。白纸目录按 id 取名，十六进制只有
 * 小写，大小写不敏感的文件系统上不同的键不会落进同一个目录
 */
export function placePaperId(key: string): string {
  return `p:${Buffer.from(key, 'utf8').toString('hex')}`;
}

/** 继承链的解析结果：选层用的平台与类型（场所经 {@link SessionManagerService.placeOf} 取），继承值与每个键的来源层 */
export interface SessionInheritance {
  /** 选平台档的平台：有出生平台的会话（子会话按根会话）为出生平台，否则为调用方传入的入口平台 */
  platform?: string;
  /** 选平台类型档的类型名：有聊天窗口的会话（子会话按根会话）才有 */
  type?: string;
  /** 继承值：已登记、取值合法的键 */
  values: SessionConfig;
  /** 每个键最终来自哪一层 */
  sources: Record<string, InheritanceSource>;
}

/**
 * IM 房间的聊天窗口：建档时按入站消息记下（api-gateway 的 chatScopeOf），之后不变
 */
export interface OriginChat {
  /** 平台类型名 */
  type: string;
  /** 多方标记：建档时按适配器的声明记下，之后不随声明改动。安全判断只认它，不认类型名 */
  multiParty: boolean;
  /** 机器人账号：消息上带了才有 */
  selfId?: string;
  /** 目标：多方为窗口 id（群号），一对一为对端账号；与作用域第三段同口径 */
  targetId: string;
}

/** 项目会话的绑定：目录都是真实路径 */
export interface WorkBinding {
  /** 绑定目录：建会话时定，为所属工作区的目录或为这个会话建的同仓 worktree */
  root: string;
  /** 附加可写目录 */
  extraRoots: string[];
  /** 本会话树经宿主建的同仓 worktree */
  worktrees: string[];
}

/**
 * 会话信息
 *
 * 代表一个独立的对话会话，可拥有独立配置和树形层级关系。
 * 树形结构为未来 agent 任务拆分和协作奠定基础。
 *
 * 会话之间的差别一律按字段判（出生平台、聊天窗口、创建来源、所属工作区、绑定），不按会话 id 的写法，也不靠 id 里有没有
 * 冒号：这些字段在建档时记下，子会话不带，按根会话取（{@link rootSessionOf}）
 */
export interface SessionInfo {
  /** 会话唯一标识 */
  id: string;
  /** 会话显示名称 */
  name: string;
  /** 自动生成的会话标题（AI 总结，或父会话指定） */
  title?: string;
  /** 父会话 ID（根会话为 undefined） */
  parentId?: string;
  /** 子会话 ID 列表 */
  children: string[];
  /**
   * 会话状态。回合开始翻 active；最后一轮结束时仍为 active 的（根会话与子会话一样）按这一轮的结局收口：出错为 error，
   * 其余为 completed，被停止的从 {@link lastTurn} 看出
   */
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  /** 会话自己的设置覆盖（原样存储：含没启用的插件的键与旧数据里的 sessionDefaults） */
  config: StoredSessionConfig;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后更新时间戳 */
  updatedAt: number;
  /**
   * 创建来源：建这个会话的审批面的登记名（api-approval 的 registerSurface，如 webui、cli）。只有会话服务的
   * session/create 与终端经专用参数（{@link SessionCreation}）写：建档时写，终端另给按 id 兜底建档留下的空记录补写；
   * 不收调用方经会话字段传值
   */
  createdFrom?: string;
  /** 父会话传入的指令/上下文（创建子会话时由父会话填写） */
  inputContext?: string;
  /** 完成结果摘要（子会话完成后填充，用于向父会话汇报） */
  result?: string;
  /** 扩展元数据（供插件自由使用） */
  metadata?: Record<string, unknown>;
  /** 会话种类（{@link sessionKind}），由 session-manager 按 parentId 与出生平台推出，不收调用方传值 */
  kind: SessionKind;
  /**
   * 出生平台：IM 房间建档时按入站消息记下，之后不变。只有有出生平台的根会话带（与 {@link originChat} 同时记下），
   * 读方不从会话 id 推；不收调用方传值
   */
  originPlatform?: string;
  /** 聊天窗口：与出生平台同时记下，只有 IM 房间的根会话带。不收调用方传值 */
  originChat?: OriginChat;
  /**
   * 所属工作区的 id（不带 `workspace:` 前缀）；缺省即默认工作区。只有根会话带，只在建档时经 {@link SessionCreation} 写，
   * 取消登记这个工作区时清掉
   */
  workspace?: string;
  /** 绑定：只有项目会话的根会话带，只经会话管理的专用方法写 */
  work?: WorkBinding;
  /**
   * 当前目录（真实路径）：每个会话各带一份，没有值时为场所的主目录；子会话建时取父会话此刻的值。只经 setCurrentDir 改
   */
  currentDir?: string;
  /**
   * 有出生平台的房间：接管它的平台适配器的插件实例 id（api-platform 的 `resolvePlatformBySession`）。
   * 只供会话列表按实例分组，路由不读它；还没有适配器认领的为 undefined，下一条真人入站时补记，记下后不再重算。
   * 不收调用方传值
   */
  originInstance?: string;
  /** 她最近一次开口的时间：回合结局为 replied 时由 session-manager 写入。不收调用方传值 */
  lastReplyAt?: number;
  /**
   * 最近结束的一轮：结局（取值同 api-agent 的 agent:turn:after，被拦下、没有结局的一轮记为 silent）、结束时间，
   * 结局为 error 时带 agent 给的一句原因。每一轮结束时由 session-manager 写入，不收调用方传值
   */
  lastTurn?: { outcome: 'replied' | 'silent' | 'aborted' | 'error'; endedAt: number; error?: string };
  /** 这个会话自己的模型调用累计的输入与输出 token（api-llm 的 llm:usage），不含子会话。由 session-manager 累加，不收调用方传值 */
  tokens?: { input: number; output: number };
}

/** 建会话时调用方能给的字段：配置按登记的设置项校验 */
export type NewSessionFields = Partial<
  Omit<
    SessionInfo,
    | 'id'
    | 'children'
    | 'createdAt'
    | 'updatedAt'
    | 'kind'
    | 'createdFrom'
    | 'originPlatform'
    | 'originChat'
    | 'workspace'
    | 'work'
    | 'currentDir'
    | 'originInstance'
    | 'lastReplyAt'
    | 'lastTurn'
    | 'tokens'
    | 'config'
  >
> & { config?: SessionConfigPatch };

/**
 * 建档专用的参数：只在建档时生效（例外是 ensureSession 给兜底建档留下的空记录补写创建来源），不并进
 * {@link NewSessionFields}。只有会话服务（owner 连接的 session/create）与终端传
 */
export interface SessionCreation {
  /** 创建来源：建这个会话的审批面的登记名 */
  createdFrom: string;
  /** 所属工作区的 id：须是已有的工作区；不带（或带 default）即默认工作区 */
  workspace?: string;
  /**
   * 绑定目录（真实路径，由调用方校验：工作区的目录，或为这个会话建的同仓 worktree）。在项目工作区里建会话时必带，
   * 默认工作区不收
   */
  work?: { root: string };
}

/**
 * 会话树的根会话：沿父会话上溯；会话不在表里、某一级父会话不在表里，或父会话链成环（坏数据）时为 undefined
 */
export function rootSessionOf(
  info: SessionInfo | undefined,
  lookup: (id: string) => SessionInfo | undefined,
): SessionInfo | undefined {
  const visited = new Set<string>();
  let session = info;
  while (session?.parentId) {
    if (visited.has(session.id)) return undefined;
    visited.add(session.id);
    session = lookup(session.parentId);
  }
  return session;
}

/**
 * 房间类别：这个会话的受众里有谁，由此定回合最多能触及什么。owner-only 是受众只有 owner 的会话，room 是受众里有别人的，
 * internal 是没有受众的内部会话与判不出的
 */
export type RoomClass = 'owner-only' | 'room' | 'internal';

/**
 * 按会话字段判房间类别，子会话取根会话的：有出生平台的，聊天窗口为多方的是 room，一对一而对端是 owner 身份的是
 * owner-only，其余一对一是 room（只认多方标记，不认类型名）；没有出生平台、带创建来源的是 owner-only；其余（不在会话表里的、
 * 按 id 建档的、mcp-server、编排与定时任务的会话）一律 internal，失败关闭。isOwner 由调用方传入（如 authority 的 owner 判定）
 */
export function roomClass(
  info: SessionInfo | undefined,
  lookup: (id: string) => SessionInfo | undefined,
  isOwner: (platform: string, userId: string) => boolean,
): RoomClass {
  const root = rootSessionOf(info, lookup);
  if (root?.originPlatform !== undefined) {
    const chat = root.originChat;
    return chat && !chat.multiParty && isOwner(root.originPlatform, chat.targetId) ? 'owner-only' : 'room';
  }
  return root?.createdFrom !== undefined ? 'owner-only' : 'internal';
}

/** 改会话时调用方能给的字段：配置按登记的设置项校验，与原有覆盖合并 */
export type SessionUpdates = Partial<Pick<SessionInfo, 'name' | 'status' | 'metadata'>> & {
  config?: SessionConfigPatch;
};

/**
 * 会话管理服务
 *
 * 负责会话的创建、查询、配置和树形管理。
 * 由 plugin-session-manager 实现并注册为 'session-manager' 服务。
 *
 * 设计要点：
 * - 会话设置项由插件登记，session-manager 只做通用的存储、继承链与校验
 * - 树形结构通过 parentId/children 维护，支持未来的任务拆分场景
 * - 会话生命周期事件通过 EventBus 广播
 *
 * 写配置的方法（建会话、改会话、改某一层）遇到没登记的键或不合字段的值时抛 {@link SessionConfigError}，什么都不改。
 */
export interface SessionManagerService {
  // ---- CRUD ----

  /**
   * 创建新会话，返回完整的 SessionInfo。creation 是建档专用的参数（创建来源、所属工作区、绑定），只给根会话：带 parentId
   * 时抛错；工作区没有记录、项目工作区缺绑定、默认工作区带绑定时抛错。建档不写当前目录（没有值即场所的主目录）；
   * 子会话的当前目录取父会话此刻的值
   */
  createSession(opts?: NewSessionFields, creation?: SessionCreation): Promise<SessionInfo>;
  /** 获取指定会话（不存在返回 undefined） */
  getSession(id: string): SessionInfo | undefined;
  /** 列出会话（可按 parentId 和 status 过滤） */
  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
  /** 更新会话属性；配置补丁与原有覆盖合并，改了配置时另发 `session:config:changed` */
  updateSession(id: string, updates: SessionUpdates): Promise<SessionInfo>;
  /**
   * 按精确 id 幂等 upsert 会话。
   * - 已存在 → 合并式 update（emit `session:updated`）
   * - 不存在 → 以传入 id（**不自生成**）建记录（emit `session:created`）；`status` 缺省时，这个会话有回合在跑为
   *   `active`（回合结束时收口），否则为 `waiting`
   *
   * 用于按固定 id 落档：终端配置的会话 id、/session.set 落配置覆盖等。createSession 会自生成 id、updateSession
   * 缺记录会抛错，故需要本方法。按 id 建出的记录不带来源字段：IM 房间的来源字段由原生入站建档时记下，按 id 建出的由之后的原生入站补记。
   * creation 是创建来源：建档时写；已有记录既没有创建来源、也没有出生平台与绑定（按 id 兜底建档留下的空记录）时补写，
   * 随这次更新落盘、发 `session:updated`；其余已有记录不改
   */
  ensureSession(
    id: string,
    patch?: SessionUpdates,
    creation?: Pick<SessionCreation, 'createdFrom'>,
  ): Promise<SessionInfo>;
  /** 删除会话（同时清理其消息历史） */
  deleteSession(id: string): Promise<void>;

  // ---- 树形操作 ----

  /** 创建子会话；父会话还没建档时先按 id 兜底建档（名字为 id、不带来源字段，是房间的由参考实现的入站收录补记） */
  createChildSession(parentId: string, opts?: Omit<NewSessionFields, 'parentId'>): Promise<SessionInfo>;
  /** 获取直接子会话列表 */
  getChildren(parentId: string): SessionInfo[];

  // ---- 当前目录与项目会话的绑定 ----
  // 当前目录是每个会话自己的；绑定写在项目会话的根会话上，子会话里的改动也写到那里。都随会话表持久化，任何清空都不清，
  // 删除会话时随记录删除。会话不存在时抛错，改绑定时会话不在项目会话树里也抛错。改了发 session:updated

  /** 改这个会话自己的当前目录（真实路径，由调用方校验）：全部会话都有 */
  setCurrentDir(sessionId: string, dir: string): Promise<void>;
  /** 整份替换附加可写目录（真实路径，由调用方校验） */
  setExtraRoots(sessionId: string, extraRoots: readonly string[]): Promise<void>;
  /** 记下本会话树经宿主建的 worktree（真实路径）；已记过的不重复记 */
  addWorktree(sessionId: string, path: string): Promise<void>;

  // ---- 场所与工作区 ----
  // 场所记录存在记忆后端里（跟随胜者，与会话表同一套），删除会话不删场所。默认工作区的记录激活时就在；窗口的记录在 IM 房间
  // 建档时建（owner 的 IM 私聊在默认工作区，不建），显示名随入站消息更新；工作区的记录在添加工作区时建

  /**
   * 会话的场所，子会话取根会话的：有出生平台的，一对一而对端是 owner（authority 判定；没有 authority 时不认）的为默认
   * 工作区，其余为窗口（聊天窗口缺失或目标为空的坏数据同样是窗口，键里缺的段按空串拼，日志点名）；没有出生平台的按记下
   * 的工作区，没记的、记下的没有记录（坏数据，日志点名）的为默认工作区。
   * 不在会话表里的 id 为默认工作区
   */
  placeOf(sessionId: string): SessionPlace;
  /** 场所记录；没有这个键的记录时为 undefined */
  getPlace(key: string): PlaceInfo | undefined;
  /**
   * 登记项目工作区：root 是已校验的真实路径（调用方做目录校验）。同一个真实路径只登记一个，已登记的返回那一个
   * （existed 为 true）；否则生成随机的固定编号，显示名取文件夹名
   */
  addWorkspace(root: string): { workspace: WorkspaceInfo; existed: boolean };
  /** 全部工作区：默认工作区在前，其后按登记先后 */
  listWorkspaces(): WorkspaceInfo[];
  /**
   * 取消登记项目工作区：只删工作区记录与它的场所设置，不动文件；原属会话（根会话记下的是它的）清掉所属工作区与绑定，
   * 会话树里的当前目录一并清掉，回到默认工作区，各发 session:updated。默认工作区与没有记录的 id 抛错
   */
  removeWorkspace(id: string): Promise<void>;

  // ---- 生命周期 ----

  /** 标记会话完成（触发 session:completed 事件，通知父会话） */
  completeSession(id: string, result?: string): Promise<void>;

  // ---- 会话设置 ----

  /**
   * 登记一个设置项（提供者一侧；插件经绑定门面 `sessionManager.registerSetting` 登记，随激活撤回）。
   * 键不合法，或同一个键已由别的插件以不同的定义登记时抛错。登记与撤回都发 `session:config:changed`
   */
  registerSetting(setting: SessionSetting, plugin: string): () => void;
  /** 已登记的设置项 */
  listSettings(): RegisteredSessionSetting[];

  /**
   * 解析指定会话的最终生效配置：继承链（{@link resolveInheritance}）之上叠会话自己的覆盖。只含已登记、取值合法的键；
   * 取值不合登记的字段的跳过并告警一次。全局默认层由服务偏好承担的项（字段类型为 llm-ref 的「模型」）在全局默认之上
   * 各层都没设时不给值：取用方交给 api-llm 的 resolveLLMModel，落到服务此刻解析到的那一个
   */
  resolveConfig(sessionId: string, platform?: string): SessionConfig;

  /**
   * 继承链解析（不含会话自身 config），按层表 {@link SESSION_LAYERS} 的先后：全局默认 → 平台档 → 平台类型档 → 场所 →
   * 父会话的 sessionDefaults（旧数据）。子会话一律按根会话取：平台档按出生平台，没有出生平台的按传入的入口平台；平台类型档
   * 按聊天窗口的类型名，没有聊天窗口的不取；场所按 {@link placeOf}。只看继承值，才不会把会话自己的覆盖当成继承来的
   */
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance;

  /** 会话自己的覆盖里已登记、取值合法的项；只能设到场所为止（narrowest）的项不算 */
  getOwnConfig(sessionId: string): SessionConfig;

  /** 建子会话时复制的配置：父会话的生效配置去掉 liveOnly 与只能设到场所为止（narrowest）的项 */
  childConfig(parentId: string, platform?: string): SessionConfig;

  /**
   * 全局默认层由服务偏好承担的项此刻实际落到的值：真正调模型的 agent 插件按它的偏好、全局偏好、提供者自带的优先级与注册
   * 先后解析到的能对话的模型（偏好指向的模型不在时是服务落到的那一个）。没有可用的模型时没有这一项。设置界面据此写
   * 「默认（…）」、标出偏好指向的模型不在
   */
  resolvedDefaults(): SessionConfig;

  /**
   * 可以设的各层，按层表的先后：全局默认；各平台档（已装适配器的平台加配置里写过的）；各平台类型档（适配器声明的类型加
   * 配置里写过的，没声明类型的平台不单列）；全部场所记录（默认工作区在前）。同一层里按名字排
   */
  listLayers(): SessionConfigLayer[];
  /**
   * 这一层自己的值：已登记、取值合法的项。全局默认层由服务偏好承担的项（字段类型为 llm-ref）取 llm 服务的偏好。
   * 层的标识不合法时抛 {@link SessionConfigError}
   */
  getLayer(layer: SessionConfigLayer): SessionConfig;
  /**
   * 解析到这一层为止的生效值与来源：窗口场所在它的平台档与平台类型档之上，工作区场所只在全局默认之上。
   * 层的标识不合法时抛 {@link SessionConfigError}
   */
  resolveLayer(layer: SessionConfigLayer): Pick<SessionInheritance, 'values' | 'sources'>;
  /**
   * 改一层的值并保存，成功后发 `session:config:changed`。补丁按登记的设置项校验，层的标识不合法时抛 {@link SessionConfigError}。
   * 全局默认、平台档与平台类型档存放在宿主配置文档的 sessionConfig 字段里：宿主没有提供配置文档时抛错，保存失败时撤回
   * 文档里的改动、以拒绝传出。全局默认层由服务偏好承担的项写的是 llm 服务的偏好（运行态与文档的 servicePreferences，
   * null 即取消偏好），保存失败时一并撤回。场所层写进场所记录，随会话表落盘
   */
  updateLayer(layer: SessionConfigLayer, patch: SessionConfigPatch): Promise<void>;

  // ---- 标题管理 ----

  /** 自动生成会话标题（调用 LLM 总结），返回生成的标题或 undefined。可传入 userMessage 避免依赖历史记录。 */
  generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;
  /** 手动更新会话标题 */
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
}

declare module '@aalis/core' {
  /** 会话生命周期事件（由 plugin-session-manager 增量声明） */
  interface AalisEvents {
    'session:created': [session: SessionInfo];
    /** 会话档案变了；建、删子会话时父会话的子会话列表也变了，父会话随后发一次 */
    'session:updated': [session: SessionInfo];
    'session:completed': [session: SessionInfo];
    'session:deleted': [sessionId: string];
    /**
     * 会话设置可能变了：设置项登记或撤回（插件启停）、某一层的值被改写、某个会话的覆盖被改写、全局默认的模型变了（llm 服务
     * 的偏好改了、提供者上下线）
     */
    'session:config:changed': [];
  }
}

/** `sessionManager` 的业务层：调用转发给选中的那一家，登记的设置项随本次激活撤回 */
export interface BoundSessionManager extends SessionManagerService {
  /** 登记一个会话设置项（同一激活内同键重复登记为替换）；返回撤回 */
  registerSetting(setting: SessionSetting): () => void;
}

// ----- 服务描述符（按激活绑定；调用型 + 登记设置项）-----
export const sessionManager = defineService<SessionManagerService, BoundSessionManager>('session-manager', port => {
  const settings = port.registrar<SessionSetting>({
    key: setting => setting.key,
    register: (service, setting) => service.registerSetting(setting, port.id),
  });
  return Object.assign(Object.create(port.provider) as BoundSessionManager, {
    registerSetting: (setting: SessionSetting) => settings.add(setting),
  });
});
