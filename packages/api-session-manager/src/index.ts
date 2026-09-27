// ----- 会话管理服务接口（types + 描述符 + 事件 augmentation）-----
//
// 该包是 plugin-session-manager 的契约边界：类型、运行时描述符
// `sessionManager`，以及 session:* 事件 augmentation。
// 下游应 `import { sessionManager } from '@aalis/api-session-manager'`
// 写入 uses；不要依赖 impl 包，以免工作区依赖与编译循环。

// 锚定 @aalis/core，使下方 declare module 的 AalisEvents 增强生效。
import type {} from '@aalis/core';
import { defineService } from '@aalis/core';

/** 记忆召回范围：session=仅本会话，platform=同平台，all=不限 */
export type MemoryRecallScope = 'session' | 'platform' | 'all';

/**
 * 会话级配置覆盖
 *
 * 每个会话可以独立配置 LLM 提供者、模型、工具集、人设等。
 * Agent 处理消息时通过 session-manager 的 resolveConfig() 获取最终生效配置。
 *
 * 配置解析优先级（从高到低）：
 * 1. 会话自身 config（手工覆盖 / /model 指令设置）
 * 2. 父会话默认配置（sessionDefaults，供子会话继承）
 * 3. 平台默认配置（platformProfiles[platform]，房间会话另叠加受众条目）
 * 4. 全局默认（getDefaults()，即 @aalis/plugin-session-manager 的 defaults 配置）
 */
export interface SessionConfig {
  /**
   * 会话使用的 LLM 模型引用：`{ provider, model }` 二元组。
   * provider 为 LLM 插件实例 contextId（如 `@aalis/plugin-llm-openai:main`），
   * model 为该 provider 注册的 model id（如 `gpt-4o`）。
   * 由 ConfigSchema type='llm-ref' 字段统一编辑。
   */
  llm?: { provider: string; model: string };
  /** 启用的工具分组；`'*'` = 全部分组。会话未设置时继承平台档，最终为空则只给无分组的通用工具 */
  enabledToolGroups?: string[];
  /** 人格文件名（不含后缀，如 'aalis', 'aalis-webui', 'default'） */
  persona?: string;
  /**
   * 会话级 thinking 覆盖：true=强制开启深度思考，false=强制关闭；未设置=继承上层
   * （平台 profile / 全局默认），最终落到各 provider 自己的全局配置。
   * agent 将解析结果写入 ChatModelRequest.think；ollama 与 deepseek 原生支持请求级
   * 覆盖，openai 兼容中转无对应参数、静默忽略。经 /session.set -t on|off 设置，
   * /session.reset 复位。
   */
  think?: boolean;
  /** 额外系统提示：由 persona 追加在人设提示之后、结构化输出格式说明之前；未装 persona 时不生效 */
  systemPromptExtra?: string;
  /** 最大工具迭代次数覆盖（正整数；非正整数视为未设置，回落 agent 全局配置） */
  maxToolIterations?: number;
  /** 禁用结构化输出格式（该会话回复纯文本） */
  disableOutputFormat?: boolean;
  /** JSON 内容由客户端渲染，服务端不提取回复字段 */
  clientSideJsonRendering?: boolean;
  /** 本房间开启白纸（默认关） */
  paperEnabled?: boolean;
  /** 白纸名；不写则每个房间各一块，属性取白纸枢纽的 defaults */
  paperName?: string;
  /** 允许的远端代理类型（远端代理插件实例 id）；空或缺省 = 关 */
  remoteAgentTypes?: string[];
  /** 每人每天金额上限（美分）；缺省不按人限制，只受本房间与全局上限约束 */
  remoteAgentUserDailyCents?: number;
  /** 每人每天件数上限；缺省不按人限制 */
  remoteAgentUserDailyTasks?: number;
  /** 本房间每天金额上限（美分）；缺省按 0 */
  remoteAgentRoomDailyCents?: number;
  /** 记忆召回范围，只能比记忆插件的配置更窄；随子会话复制，否则经子任务就绕过了收窄 */
  memoryRecallScope?: MemoryRecallScope;
  /** 子会话默认配置（创建子会话时自动继承，子会话可进一步覆盖） */
  sessionDefaults?: Omit<SessionConfig, 'sessionDefaults'>;
}

/**
 * 只经继承链实时解析、不随建会话复制的键。
 *
 * 建会话时复制生效配置（WebUI 建会话、create_subtask 建子会话）会把复制时的值冻结进新会话，
 * 此后房间或平台档改了也不跟着变；子会话还会凭冻结的值继续开远端任务。复制一律经 {@link omitRoomOnlyKeys}。
 */
export const ROOM_ONLY_CONFIG_KEYS = [
  'paperEnabled',
  'paperName',
  'remoteAgentTypes',
  'remoteAgentUserDailyCents',
  'remoteAgentUserDailyTasks',
  'remoteAgentRoomDailyCents',
] as const satisfies readonly (keyof SessionConfig)[];

/** 去掉 {@link ROOM_ONLY_CONFIG_KEYS}，返回新对象 */
export function omitRoomOnlyKeys<T extends SessionConfig>(config: T): Omit<T, (typeof ROOM_ONLY_CONFIG_KEYS)[number]> {
  const out = { ...config };
  for (const key of ROOM_ONLY_CONFIG_KEYS) delete out[key];
  return out;
}

/**
 * 平台配置模板
 *
 * 为每个平台设定默认的 SessionConfig，经继承链实时生效：房间会话按出生平台选档，其余按入口平台
 * （见 {@link SessionManagerService.resolveInheritance}）。同一平台可另写只对群或只对私聊生效的受众条目，
 * 只列与基础档不同的键，叠加在基础档上。
 * 在 session-manager 的 configSchema 中通过 WebUI 配置。
 */
export type PlatformProfile = SessionConfig;

/** 继承链的层：全局 defaults、平台档、平台档的受众条目、父会话的 sessionDefaults */
export type InheritanceSource = 'defaults' | 'platform' | 'audience' | 'parent';

/** 继承链的解析结果：选档用的平台与受众、继承值与每个键的来源层 */
export interface SessionInheritance {
  /** 选档用的平台：有出生平台的会话为出生平台，否则为调用方传入的入口平台 */
  platform?: string;
  /** 选档用的受众：有出生平台的会话为它的受众，owner 面会话没有（不取受众条目） */
  audience?: Exclude<RoomAudience, 'owner'>;
  /** 继承值（不含会话自身 config 与 sessionDefaults） */
  values: Omit<SessionConfig, 'sessionDefaults'>;
  /** 每个键最终来自哪一层 */
  sources: Partial<Record<keyof SessionConfig, InheritanceSource>>;
}

/** 会话种类：room 为聊天用的会话（IM 群与私聊、owner 在 WebUI 与 CLI 的聊天）；task 为挂在发起它的会话下面的子会话 */
export type SessionKind = 'room' | 'task';

/**
 * 房间受众：private、group 为 IM 房间；owner 只表示「不是 IM 房间」（没有出生平台的根会话，含 mcp-server、
 * `workflow::<id>` 等），只供列表分区，不代表 owner 在场，按受众定触及上限前须按主体重判。
 * 非房间会话（含以后的工作会话）的 id 不得含单冒号，否则会被当成房间。
 */
export type RoomAudience = 'owner' | 'private' | 'group';

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
  /** 会话状态 */
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  /** 会话级配置覆盖 */
  config: SessionConfig;
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
  /** 由 session-manager 按 parentId 推出（有 parentId 为 task），不收调用方传值 */
  kind: SessionKind;
  /** 出生平台（api-gateway 的 resolveSessionOrigin）；owner 面会话及其子会话为 undefined */
  originPlatform?: string;
  /** 只有 room 带：有出生平台的取 group 或 private，其余为 owner */
  audience?: RoomAudience;
}

/**
 * 会话树节点（递归结构）
 *
 * 用于前端展示会话树和 agent 任务树状图。
 */
export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

/** 会话列表的分区：owner=我的会话（WebUI、CLI 等 owner 面会话），rooms=IM 房间 */
export type SessionListSection = 'owner' | 'rooms';

/** 按受众分区的纯函数：private、group 为 rooms，其余为 owner。服务端页面动作与以后的客户端协议共用 */
export function sessionListSection(session: Pick<SessionInfo, 'audience'>): SessionListSection {
  return session.audience === 'private' || session.audience === 'group' ? 'rooms' : 'owner';
}

/** 会话列表的一个分区 */
export interface SessionTreeSection {
  key: SessionListSection;
  /** 显示名：「我的会话」「IM 房间」 */
  label: string;
  /** 根会话（子会话挂在各自父节点下） */
  nodes: SessionTreeNode[];
}

/**
 * 会话管理服务
 *
 * 负责会话的创建、查询、配置和树形管理。
 * 由 plugin-session-manager 实现并注册为 'session-manager' 服务。
 *
 * 设计要点：
 * - 每个会话拥有独立的 SessionConfig，Agent 处理消息时查询并应用
 * - 树形结构通过 parentId/children 维护，支持未来的任务拆分场景
 * - 会话生命周期事件通过 EventBus 广播
 */
export interface SessionManagerService {
  // ---- CRUD ----

  /** 创建新会话，返回完整的 SessionInfo */
  createSession(
    opts?: Partial<
      Omit<SessionInfo, 'id' | 'children' | 'createdAt' | 'updatedAt' | 'kind' | 'originPlatform' | 'audience'>
    >,
  ): Promise<SessionInfo>;
  /** 获取指定会话（不存在返回 undefined） */
  getSession(id: string): SessionInfo | undefined;
  /** 列出会话（可按 parentId 和 status 过滤） */
  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
  /** 更新会话属性 */
  updateSession(
    id: string,
    updates: Partial<Pick<SessionInfo, 'name' | 'config' | 'status' | 'metadata'>>,
  ): Promise<SessionInfo>;
  /**
   * 按精确 id 幂等 upsert 会话。
   * - 已存在 → 合并式 update（emit `session:updated`）
   * - 不存在 → 以传入 id（**不自生成**）建记录（emit `session:created`）；`status` 缺省时，这个会话有回合在跑为
   *   `active`（回合结束时收口），否则为 `waiting`
   *
   * 用于平台派生 sessionId（如 `onebot:<self>:group:<gid>`）：这些 id 不经
   * createSession 预建，首次设置模型/人设覆盖时需按其原样 id 落档——而 createSession
   * 会自生成 id、updateSession 缺记录会抛错，故需要本方法。
   */
  ensureSession(
    id: string,
    patch?: Partial<Pick<SessionInfo, 'name' | 'config' | 'status' | 'metadata' | 'createdBy'>>,
  ): Promise<SessionInfo>;
  /** 删除会话（同时清理其消息历史） */
  deleteSession(id: string): Promise<void>;

  // ---- 树形操作 ----

  /** 创建子会话 */
  createChildSession(
    parentId: string,
    opts?: Partial<
      Omit<
        SessionInfo,
        'id' | 'parentId' | 'children' | 'createdAt' | 'updatedAt' | 'kind' | 'originPlatform' | 'audience'
      >
    >,
  ): Promise<SessionInfo>;
  /** 获取直接子会话列表 */
  getChildren(parentId: string): SessionInfo[];
  /** 获取会话树（传入 rootId 则只返回该子树，否则返回所有根会话的树） */
  getTree(rootId?: string): SessionTreeNode[];

  // ---- 生命周期 ----

  /** 标记会话完成（触发 session:completed 事件，通知父会话） */
  completeSession(id: string, result?: string): Promise<void>;

  // ---- 配置解析 ----

  /**
   * 解析指定会话的最终生效配置
   *
   * 合并优先级：会话 config > 父会话 sessionDefaults > 平台 profile > 全局默认
   * 返回合并后的完整 SessionConfig（不含 sessionDefaults 字段）。平台档的选法同 {@link resolveInheritance}：
   * 房间会话钉死出生平台，传入的入口平台只对没有出生平台的会话起作用。
   */
  resolveConfig(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'>;

  /**
   * 继承链解析（不含会话自身 config）：全局 defaults → 平台档 → 平台档的受众条目 → 父会话 sessionDefaults。
   * 会话有出生平台（api-gateway 的 resolveSessionOrigin，子任务按父会话算）时按出生平台选档、忽略传入的 platform，
   * 并按它的受众（group 或 private）叠加受众条目；没有时（WebUI、CLI 等 owner 面会话）按传入的入口平台，不取受众条目。
   *
   * WebUI 的「继承 (xxx)」提示与 `/session` 的来源显示用它：只看继承值，才不会把会话自己的覆盖当成继承来的。
   */
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance;

  /**
   * 获取已配置的平台 profile 列表（平台档只从插件配置加载，无运行时写入口）。
   * 受众条目不在返回之列；要知道某个房间的某个键是否来自平台档，看 `resolveInheritance(id).sources[键]`
   * 是 `platform` 还是 `audience`。
   */
  getPlatformProfiles(): Record<string, PlatformProfile>;

  /**
   * 获取全局默认配置（platform profile 之下的最低层 fallback）。
   * 当 session 自身、父会话 sessionDefaults、platform profile 都未指定某字段时，
   * resolveConfig 会回落到这里。配置位置：`@aalis/plugin-session-manager.defaults`。
   */
  getDefaults(): Omit<SessionConfig, 'sessionDefaults'>;

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
    'session:updated': [session: SessionInfo];
    'session:completed': [session: SessionInfo];
    'session:deleted': [sessionId: string];
  }
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const sessionManager = defineService<SessionManagerService>('session-manager');
