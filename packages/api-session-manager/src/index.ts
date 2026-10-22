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
import type { TextRef } from '@aalis/schema-i18n';
import type { IncomingMessage } from '@aalis/schema-message';
import { t } from './texts.js';

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

/** 场所按哪种会话算（如会话设置的场所层适用哪些项）：窗口按房间，工作区按 owner 的会话 */
export function placeKind(place: Pick<SessionPlace, 'kind'>): SessionKind {
  return place.kind === 'window' ? 'room' : 'owner';
}

/** 场所：会话长期所在的地方，每个会话恰好一个，子会话取根会话的。场所只管归属与插件按场所存的数据（白纸、设置），不管权限 */
export interface SessionPlace {
  /** window：IM 的群与别人的私聊；workspace：本机的工作区（默认工作区、项目工作区） */
  kind: 'window' | 'workspace';
  /**
   * 场所键：窗口为 `平台:类型:目标`（api-gateway 的 windowKey，不含机器人账号）；工作区为 `workspace:<id>`
   * （id 是建工作区时随机生成的固定编号，不由路径算），默认工作区为 `workspace:default`
   */
  key: string;
}

/** 场所记录对外的样子：显示名与插件的扩展元数据。工作区的目录经 {@link WorkspaceInfo} 取 */
export interface PlaceInfo extends SessionPlace {
  /**
   * 显示名：窗口取群名或对方昵称，随消息更新；项目工作区默认取文件夹名，允许重名；默认工作区没有（旧记录里可能存着生成的名字）。
   * 显示经 {@link placeLabel}
   */
  name?: string;
  /** 扩展元数据（供插件自由使用，与 {@link SessionInfo.metadata} 同一写法）：随场所记录落盘、随取消登记删除，经 updatePlace 改 */
  metadata?: Record<string, unknown>;
}

/** 场所的显示名：没有名字时为「默认工作区」（文字对象，按读者语言显示；交给模型的取它的 source） */
export function placeLabel(place: Pick<PlaceInfo, 'name'>): string | TextRef {
  return place.name ?? t('defaultWorkspace');
}

/** 工作区：默认工作区的 id 为 default，没有名字（显示经 {@link placeLabel}）。目录在不在由用到它的一方在用时检查，不存储 */
export interface WorkspaceInfo {
  id: string;
  name?: string;
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

/** 白纸在白纸根（宿主家目录的 stage/paper）里的目录名：白纸 id 的 `:` 换成 `-`。白纸插件与触及都按它取，不各写一份 */
export function paperDirName(paperId: string): string {
  return paperId.replace(':', '-');
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
  /** 目标：多方为窗口 id（群号），一对一为对端账号；与窗口键第三段同口径 */
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
  /**
   * 会话显示名称：建会话时给的，IM 房间取群名或对方昵称（取不到时不取名，之后的入站补上）。没取名的没有（旧记录里可能存着
   * 生成的名字），显示经 {@link sessionLabel}
   */
  name?: string;
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
   * 结局为 error 时带 agent 给的一句原因（字符串或文字对象，交给模型的取 source）。每一轮结束时由 session-manager 写入，
   * 不收调用方传值
   */
  lastTurn?: { outcome: 'replied' | 'silent' | 'aborted' | 'error'; endedAt: number; error?: string | TextRef };
  /** 这个会话自己的模型调用累计的输入与输出 token（api-llm 的 llm:usage），不含子会话。由 session-manager 累加，不收调用方传值 */
  tokens?: { input: number; output: number };
}

/**
 * 会话的显示名称：没取名时根会话为「会话 <建档时间>」、子会话为「子任务 <建档时间>」（文字对象，按读者语言显示；
 * 交给模型的取它的 source）。标题另算，读者按「标题，没有时用它」取
 */
export function sessionLabel(session: Pick<SessionInfo, 'name' | 'parentId' | 'createdAt'>): string | TextRef {
  if (session.name !== undefined) return session.name;
  return session.parentId ? t('subtaskName', { t: session.createdAt }) : t('sessionName', { t: session.createdAt });
}

/** 建会话时调用方能给的字段：标题与任务指令只认同名字段，metadata 原样存下、不当成这些字段读 */
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
  >
>;

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
 * 根会话是不是按 id 兜底建档留下的空记录：没有出生平台、创建来源与绑定（不在表里的父会话上开子会话、在会话管理收录不了的会话上
 * 写设置时建出）。对根会话问；IM 房间收到原生入站后补记出生平台，之后不再是
 */
export function isUnfiled(session: Pick<SessionInfo, 'originPlatform' | 'createdFrom' | 'work'>): boolean {
  return session.originPlatform === undefined && session.createdFrom === undefined && session.work === undefined;
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

/** 改会话时调用方能给的字段：metadata 合并式改（顶层键整键替换） */
export type SessionUpdates = Partial<Pick<SessionInfo, 'name' | 'status' | 'metadata'>>;

/**
 * 会话管理服务
 *
 * 负责会话的创建、查询、场所与树形管理。
 * 由 plugin-session-manager 实现并注册为 'session-manager' 服务。
 *
 * 设计要点：
 * - 会话管理不认识设置：插件按会话、按场所存的数据放在两种记录的 metadata 里（如会话设置）
 * - 树形结构通过 parentId/children 维护，支持未来的任务拆分场景
 * - 会话生命周期事件通过 EventBus 广播
 */
export interface SessionManagerService {
  // ---- CRUD ----

  /**
   * 创建新会话，返回完整的 SessionInfo。creation 是建档专用的参数（创建来源、所属工作区、绑定），只给根会话：带 parentId
   * 时抛错；工作区没有记录、项目工作区缺绑定、默认工作区带绑定时抛错。建档不写当前目录（没有值即场所的主目录）；
   * 子会话的当前目录取父会话此刻的值。自生成的 id 不落在平台的 id 写法里（子会话一样，不带父会话的 id）：适配器按
   * 会话 id 认领窗口与出站，子会话没有窗口
   */
  createSession(opts?: NewSessionFields, creation?: SessionCreation): Promise<SessionInfo>;
  /** 获取指定会话（不存在返回 undefined） */
  getSession(id: string): SessionInfo | undefined;
  /** 列出会话（可按 parentId 和 status 过滤） */
  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
  /** 更新会话属性：metadata 与原有的合并（顶层键整键替换），发 `session:updated` */
  updateSession(id: string, updates: SessionUpdates): Promise<SessionInfo>;
  /**
   * 按精确 id 幂等 upsert 会话。
   * - 已存在 → 合并式 update（emit `session:updated`）
   * - 不存在 → 以传入 id（**不自生成**）建记录（emit `session:created`）；`status` 缺省时，这个会话有回合在跑为
   *   `active`（回合结束时收口），否则为 `waiting`
   *
   * 用于按固定 id 落档：终端配置的会话 id、在会话管理收录不了的会话上写设置等。createSession 会自生成 id、updateSession
   * 缺记录会抛错，故需要本方法。按 id 建出的记录不带来源字段：IM 房间的来源字段由原生入站建档时记下，按 id 建出的由之后的原生入站补记。
   * creation 是创建来源：建档时写；已有记录既没有创建来源、也没有出生平台与绑定（按 id 兜底建档留下的空记录）时补写，
   * 随这次更新落盘、发 `session:updated`；其余已有记录不改
   */
  ensureSession(
    id: string,
    patch?: SessionUpdates,
    creation?: Pick<SessionCreation, 'createdFrom'>,
  ): Promise<SessionInfo>;
  /**
   * 删除会话，连同下面各级子会话：先从表里摘掉并发 `session:deleted`（监听方在这里停掉这个会话在跑的东西），再经 memory:clear
   * 清它的消息历史与各插件按会话存的数据
   */
  deleteSession(id: string): Promise<void>;

  /**
   * 原生入站的收录与补记，可等待：带 source 的、没有会话 id 的直接兑现，子会话按 parentId 不收录；已收录的照旧补名、更新窗口的
   * 显示名（不等这些）；要收录或补记的问完认领者、建档或补记落定之后才兑现。同一会话并发调用共用同一次收录。不会拒绝
   * （收录失败只告警）。网关在入站相位之前等它，入站管道里的读取方看到的都是已收录的会话
   */
  recordInbound(message: IncomingMessage): Promise<void>;

  // ---- 树形操作 ----
  // 会话的消息历史被清空（memory:clear 没指定类型或类型含 context，且消息历史那一行清成功）时，它的子会话一并删除：
  // 范围为 session 删这个会话的，为 all 删全部子会话

  /** 创建子会话；父会话还没建档时先按 id 兜底建档（没有名字、不带来源字段，是房间的由参考实现的入站收录补记） */
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
  /** 全部场所记录：默认工作区在前，其余按键排 */
  listPlaces(): PlaceInfo[];
  /** 合并式改场所记录的 metadata（顶层键整键替换），随会话表落盘；没有这个键的记录时抛错 */
  updatePlace(key: string, updates: Pick<PlaceInfo, 'metadata'>): Promise<PlaceInfo>;
  /**
   * 登记项目工作区：root 是已校验的真实路径（调用方做目录校验）。同一个真实路径只登记一个，已登记的返回那一个
   * （existed 为 true）；否则生成随机的固定编号，显示名取文件夹名
   */
  addWorkspace(root: string): { workspace: WorkspaceInfo; existed: boolean };
  /** 全部工作区：默认工作区在前，其后按登记先后 */
  listWorkspaces(): WorkspaceInfo[];
  /**
   * 取消登记项目工作区：只删工作区记录（连同它的 metadata），不动文件；原属会话（根会话记下的是它的）清掉所属工作区与绑定，
   * 会话树里的当前目录一并清掉，回到默认工作区，各发 session:updated。默认工作区与没有记录的 id 抛错
   */
  removeWorkspace(id: string): Promise<void>;

  // ---- 生命周期 ----

  /** 标记会话完成（触发 session:completed 事件，通知父会话） */
  completeSession(id: string, result?: string): Promise<void>;

  // ---- 标题管理 ----

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
    /** 会话已从表里摘掉、它的数据还没清时发：监听方在这里停掉这个会话在跑的东西，清理按会话存的数据也可以在这里做 */
    'session:deleted': [sessionId: string];
  }
}

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const sessionManager = defineService<SessionManagerService>('session-manager');
