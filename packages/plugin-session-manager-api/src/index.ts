// ----- 会话管理服务接口（types + capability 声明 + 事件 augmentation）-----
//
// 该包是 plugin-session-manager 的"类型 + 能力声明"边界。
// 仅需要类型（如 ctx.getService<SessionManagerService>()）或仅需要
// 触发 session:* 事件 augmentation 的下游插件应当依赖本包，而不是 impl 包，
// 以避免不必要的工作区依赖与编译循环风险。

import { registerCapabilityProbe } from '@aalis/core';

/**
 * 会话级配置覆盖
 *
 * 每个会话可以独立配置 LLM 提供者、模型、工具集、人设等。
 * Agent 处理消息时通过 session-manager 的 resolveConfig() 获取最终生效配置。
 *
 * 配置解析优先级（从高到低）：
 * 1. 会话自身 config（手工覆盖 / /model 指令设置）
 * 2. 父会话默认配置（sessionDefaults，供子会话继承）
 * 3. 平台默认配置（platformProfiles[platform]）
 * 4. 全局默认（各插件的 defaultConfig）
 */
export interface SessionConfig {
  /** LLM 提供者 contextId（指定使用哪个 LLM 插件实例） */
  llmProvider?: string;
  /** 模型 ID（如 'gpt-4o', 'deepseek-chat'） */
  model?: string;
  /** 启用的工具分组列表（为空时使用全局默认） */
  enabledToolGroups?: string[];
  /** 人格文件名（不含后缀，如 'aalis', 'aalis-webui', 'default'） */
  persona?: string;
  /** 额外系统提示（追加到人格提示之后） */
  systemPromptExtra?: string;
  /** 最大工具迭代次数覆盖 */
  maxToolIterations?: number;
  /** 禁用结构化输出格式（该会话回复纯文本） */
  disableOutputFormat?: boolean;
  /** JSON 内容由客户端渲染，服务端不提取回复字段 */
  clientSideJsonRendering?: boolean;
  /** 子会话默认配置（创建子会话时自动继承，子会话可进一步覆盖） */
  sessionDefaults?: Omit<SessionConfig, 'sessionDefaults'>;
}

/**
 * 平台配置模板
 *
 * 为每个平台设定默认的 SessionConfig。
 * 新建会话时，根据消息来源的平台自动应用对应模板。
 * 在 session-manager 的 configSchema 中通过 WebUI 配置。
 */
export type PlatformProfile = SessionConfig;

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
  createSession(opts?: Partial<Omit<SessionInfo, 'id' | 'children' | 'createdAt' | 'updatedAt'>>): Promise<SessionInfo>;
  /** 获取指定会话（不存在返回 undefined） */
  getSession(id: string): SessionInfo | undefined;
  /** 列出会话（可按 parentId 和 status 过滤） */
  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
  /** 更新会话属性 */
  updateSession(id: string, updates: Partial<Pick<SessionInfo, 'name' | 'config' | 'status' | 'metadata'>>): Promise<SessionInfo>;
  /** 删除会话（同时清理其消息历史） */
  deleteSession(id: string): Promise<void>;

  // ---- 活跃会话（WebUI） ----

  /** 获取当前活跃会话 ID */
  getActiveSessionId(): string;
  /** 切换活跃会话 */
  setActiveSessionId(id: string): void;

  // ---- 树形操作 ----

  /** 创建子会话 */
  createChildSession(parentId: string, opts?: Partial<Omit<SessionInfo, 'id' | 'parentId' | 'children' | 'createdAt' | 'updatedAt'>>): Promise<SessionInfo>;
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
   * 返回合并后的完整 SessionConfig（不含 sessionDefaults 字段）
   */
  resolveConfig(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'>;

  /** 获取已配置的平台 profile 列表 */
  getPlatformProfiles(): Record<string, PlatformProfile>;

  /** 设置指定平台的 profile */
  setPlatformProfile(platform: string, profile: PlatformProfile): void;

  // ---- 标题管理 ----

  /** 自动生成会话标题（调用 LLM 总结），返回生成的标题或 undefined。可传入 userMessage 避免依赖历史记录。 */
  generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;
  /** 手动更新会话标题 */
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
}

// ----- 会话管理能力声明（capability 框架）-----

export interface SessionManagerCapabilityRegistry {
  /** 基础 CRUD（create/get/update/delete） */
  SessionCrud: 'session-crud';
  /** 支持树形会话（createChildSession/getTree） */
  SessionTree: 'session-tree';
}

export type SessionManagerCapability = SessionManagerCapabilityRegistry[keyof SessionManagerCapabilityRegistry];

export const SessionManagerCapabilities = {
  SessionCrud: 'session-crud',
  SessionTree: 'session-tree',
} as const satisfies SessionManagerCapabilityRegistry;

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    'session-manager': SessionManagerCapability;
  }
  /** 会话生命周期事件（由 plugin-session-manager 增量声明） */
  interface AalisEvents {
    'session:created': [session: SessionInfo];
    'session:updated': [session: SessionInfo];
    'session:completed': [session: SessionInfo];
    'session:deleted': [sessionId: string];
    'session:switched': [sessionId: string];
  }
}

registerCapabilityProbe('session-manager', SessionManagerCapabilities.SessionCrud, inst => {
  const i = inst as { createSession?: unknown; getSession?: unknown; deleteSession?: unknown };
  return typeof i.createSession === 'function' && typeof i.getSession === 'function' && typeof i.deleteSession === 'function'
    ? true
    : 'SessionManagerService.createSession()/getSession()/deleteSession() are required for capability "session-crud"';
});

registerCapabilityProbe('session-manager', SessionManagerCapabilities.SessionTree, inst => {
  const i = inst as { getTree?: unknown; getChildren?: unknown };
  return typeof i.getTree === 'function' && typeof i.getChildren === 'function'
    ? true
    : 'SessionManagerService.getTree()/getChildren() are required for capability "session-tree"';
});
