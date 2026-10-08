// ----- 会话管理服务接口（types + 描述符 + 事件 augmentation）-----
//
// 该包是 plugin-session-manager 的契约边界：类型、运行时描述符
// `sessionManager`，以及 session:* 事件 augmentation。
// 下游应 `import { sessionManager } from '@aalis/api-session-manager'`
// 写入 uses；不要依赖 impl 包，以免工作区依赖与编译循环。

// 锚定 @aalis/core，使下方 declare module 的 AalisEvents 增强生效。
import type {} from '@aalis/core';
import { defineService, type ServiceRef, serviceRef } from '@aalis/core';
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
 * 会话种类：task 为子会话；room 为受众是群或私聊的根会话（IM 房间，含 owner 自己的私聊）；其余为 owner
 * （owner 在 WebUI 与 CLI 的会话，以及 mcp-server、`workflow::<id>` 等没有出生平台的根会话）。
 * 会话列表的分区、设置项的 appliesTo 与会话协议的会话种类都按它。与审批的发起类别是两回事：
 * owner 在自己的私聊里亲手发起的回合照样能产生审批
 */
export type SessionKind = 'owner' | 'room' | 'task';

/** 会话种类：有父会话为 task，受众为群或私聊为 room，其余为 owner */
export function sessionKind(session: Pick<SessionInfo, 'parentId' | 'audience'>): SessionKind {
  if (session.parentId) return 'task';
  return session.audience === 'group' || session.audience === 'private' ? 'room' : 'owner';
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
 * 房间受众：private、group 为 IM 房间；owner 只表示「不是 IM 房间」（没有出生平台的根会话，含 mcp-server、
 * `workflow::<id>` 等），只供列表分区，不代表 owner 在场，按受众定触及上限前须按主体重判。
 * 非房间会话（含以后的工作会话）的 id 不得含单冒号，否则会被当成房间。
 */
export type RoomAudience = 'owner' | 'private' | 'group';

/**
 * 会话设置在会话之上的一层：全局默认、某个平台的平台档、平台档的受众条目（只对这个平台的群或私聊房间生效）。
 * 平台档按平台名生效，不区分适配器实例
 */
export type SessionConfigLayer =
  | { scope: 'defaults' }
  | { scope: 'platform'; platform: string }
  | { scope: 'audience'; platform: string; audience: Exclude<RoomAudience, 'owner'> };

/** 继承链的层：全局默认、平台档、平台档的受众条目、父会话给子会话的默认值（旧数据） */
export type InheritanceSource = 'defaults' | 'platform' | 'audience' | 'parent';

/** 继承链的解析结果：选档用的平台与受众、继承值与每个键的来源层 */
export interface SessionInheritance {
  /** 选档用的平台：有出生平台的会话为出生平台，否则为调用方传入的入口平台 */
  platform?: string;
  /** 选档用的受众：有出生平台的会话为它的受众，owner 面会话没有（不取受众条目） */
  audience?: Exclude<RoomAudience, 'owner'>;
  /** 继承值：已登记、取值合法的键 */
  values: SessionConfig;
  /** 每个键最终来自哪一层 */
  sources: Record<string, InheritanceSource>;
}

/**
 * 会话信息
 *
 * 代表一个独立的对话会话，可拥有独立配置和树形层级关系。
 * 树形结构为未来 agent 任务拆分和协作奠定基础。
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
  /** 创建者类型 */
  createdBy?: 'user' | 'agent' | 'scheduler' | 'system';
  /** 父会话传入的指令/上下文（创建子会话时由父会话填写） */
  inputContext?: string;
  /** 完成结果摘要（子会话完成后填充，用于向父会话汇报） */
  result?: string;
  /** 扩展元数据（供插件自由使用） */
  metadata?: Record<string, unknown>;
  /** 会话种类（{@link sessionKind}），由 session-manager 按 parentId 与受众推出，不收调用方传值 */
  kind: SessionKind;
  /** 出生平台（api-gateway 的 resolveSessionOrigin）；owner 面会话及其子会话为 undefined */
  originPlatform?: string;
  /** 只有根会话带：有出生平台的取 group 或 private，其余为 owner */
  audience?: RoomAudience;
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
    | 'originPlatform'
    | 'audience'
    | 'originInstance'
    | 'lastReplyAt'
    | 'lastTurn'
    | 'tokens'
    | 'config'
  >
> & { config?: SessionConfigPatch };

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

  /** 创建新会话，返回完整的 SessionInfo */
  createSession(opts?: NewSessionFields): Promise<SessionInfo>;
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
   * 两种情况下，还没记下 `originInstance` 的房间随后都解析一次，认领到就记下并 emit `session:updated`，
   * 本方法等它落定再返回；同一条记录已有解析在途的不重复解析，也不等它
   *
   * 用于平台派生 sessionId（如 `onebot:<self>:group:<gid>`）：这些 id 不经
   * createSession 预建，首次设置模型/人设覆盖时需按其原样 id 落档——而 createSession
   * 会自生成 id、updateSession 缺记录会抛错，故需要本方法。
   */
  ensureSession(id: string, patch?: SessionUpdates & Pick<NewSessionFields, 'createdBy'>): Promise<SessionInfo>;
  /** 删除会话（同时清理其消息历史） */
  deleteSession(id: string): Promise<void>;

  // ---- 树形操作 ----

  /** 创建子会话 */
  createChildSession(parentId: string, opts?: Omit<NewSessionFields, 'parentId'>): Promise<SessionInfo>;
  /** 获取直接子会话列表 */
  getChildren(parentId: string): SessionInfo[];

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
   * 解析指定会话的最终生效配置：会话自己的覆盖 > 父会话的 sessionDefaults（旧数据）> 受众条目 > 平台档 > 全局默认。
   * 只含已登记、取值合法的键；取值不合登记的字段的跳过并告警一次。平台档的选法同 {@link resolveInheritance}：
   * 房间会话钉死出生平台，传入的入口平台只对没有出生平台的会话起作用。
   */
  resolveConfig(sessionId: string, platform?: string): SessionConfig;

  /**
   * 继承链解析（不含会话自身 config）：全局默认 → 平台档 → 平台档的受众条目 → 父会话 sessionDefaults。
   * 会话有出生平台（api-gateway 的 resolveSessionOrigin，子任务按父会话算）时按出生平台选档、忽略传入的 platform，
   * 并按它的受众（group 或 private）叠加受众条目；没有时（WebUI、CLI 等 owner 面会话）按传入的入口平台，不取受众条目。
   * 只看继承值，才不会把会话自己的覆盖当成继承来的。
   */
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance;

  /** 会话自己的覆盖里已登记、取值合法的项 */
  getOwnConfig(sessionId: string): SessionConfig;

  /** 建子会话时复制的配置：父会话的生效配置去掉 liveOnly 的项 */
  childConfig(parentId: string, platform?: string): SessionConfig;

  /**
   * 可以设的各层：全局默认总在第一个，其后按平台名，每个平台先平台档、再群与私聊的受众条目。平台档是已装适配器的平台加上
   * 配置里写过的平台；受众条目按适配器声明的 sessionTypes 出，加上配置里写过的
   */
  listLayers(): SessionConfigLayer[];
  /** 这一层自己的值：已登记、取值合法的项 */
  getLayer(layer: SessionConfigLayer): SessionConfig;
  /** 解析到这一层为止的生效值与来源：全局默认 → 平台档 → 受众条目 */
  resolveLayer(layer: SessionConfigLayer): Pick<SessionInheritance, 'values' | 'sources'>;
  /**
   * 改一层的值并保存（存放在宿主配置文档的 sessionConfig 字段里）。补丁按登记的设置项校验；宿主没有提供配置文档时
   * 抛错；保存失败时撤回文档里的改动、以拒绝传出。保存成功后发 `session:config:changed`
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
    /** 会话设置可能变了：设置项登记或撤回（插件启停）、某一层的值被改写、某个会话的覆盖被改写 */
    'session:config:changed': [];
  }
}

/** `sessionManager` 的绑定接口：调用面之外，登记的设置项随本次激活撤回 */
export interface BoundSessionManager extends ServiceRef<SessionManagerService> {
  /** 登记一个会话设置项（同一激活内同键重复登记为替换）；返回撤回 */
  registerSetting(setting: SessionSetting): () => void;
}

// ----- 服务描述符（按激活绑定；调用型 + 登记设置项）-----
export const sessionManager = defineService<SessionManagerService, BoundSessionManager>('session-manager', port => {
  const settings = port.registrar<SessionSetting>({
    key: setting => setting.key,
    register: (service, setting) => service.registerSetting(setting, port.id),
  });
  return serviceRef(port, { registerSetting: (setting: SessionSetting) => settings.add(setting) });
});
