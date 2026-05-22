import type { ConfigSchema, Context } from '@aalis/core';
import type { LLMModel } from '@aalis/plugin-llm-api';
import { resolveLLMModel } from '@aalis/plugin-llm-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';
import type { PersonaService } from '@aalis/plugin-persona-api';
import type {
  PlatformProfile,
  SessionConfig,
  SessionInfo,
  SessionManagerService,
  SessionTreeNode,
} from '@aalis/plugin-session-manager-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';

export type {
  PlatformProfile,
  SessionConfig,
  SessionInfo,
  SessionManagerCapability,
  SessionManagerCapabilityRegistry,
  SessionManagerService,
  SessionTreeNode,
} from '@aalis/plugin-session-manager-api';
export { SessionManagerCapabilities } from '@aalis/plugin-session-manager-api';

import { SessionManagerCapabilities } from '@aalis/plugin-session-manager-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-session-manager';
export const displayName = '会话管理';
export const subsystem = 'session';
export const inject = {
  required: ['memory'] as const,
  optional: ['agent', 'platform', 'persona', 'llm'] as const,
};
export const provides = ['session-manager'];

export const configSchema: ConfigSchema = {
  defaults: {
    label: '全局默认配置',
    description:
      '所有平台共享的最低层默认配置（platform profile 之下的 fallback）。LLM 默认模型由各 agent 插件通过 ServicePreference 锁定，不再在此配置；本节仅保留 persona 等通用默认。',
    fields: {
      persona: {
        type: 'select',
        label: '默认人设',
        dynamicOptions: 'persona',
        allowCustom: true,
        description: '所有平台未单独指定时使用的默认人设',
      },
    },
  },
  platformProfiles: {
    type: 'array',
    label: '平台默认配置',
    description: '为每个平台设置默认的会话配置模板。新会话创建时自动应用对应平台的模板。',
    items: {
      platform: {
        type: 'string',
        label: '平台标识',
        required: true,
        description: '平台名（如 onebot、webui、cli）',
      },
      persona: {
        type: 'select',
        label: '人设文件',
        dynamicOptions: 'persona',
        allowCustom: true,
        description: '该平台默认使用的人设文件名（不含后缀）',
      },
      llm: {
        type: 'llm-ref',
        label: '默认模型',
        description: '该平台新会话的默认 LLM (provider + model)。留空则沿用 ServicePreference 锁定的全局默认。',
      },
      enabledToolGroups: {
        type: 'multiselect',
        label: '工具分组',
        dynamicOptions: 'toolGroups',
        allowCustom: true,
        description: '该平台启用的工具分组',
      },
      disableOutputFormat: {
        type: 'boolean',
        label: '禁用结构化输出',
        default: false,
        description: '禁用 JSON 结构化输出，回复纯文本',
      },
      clientSideJsonRendering: {
        type: 'boolean',
        label: '客户端渲染 JSON',
        default: false,
        description: '保留完整 JSON 给前端渲染，不提取回复字段',
      },
    },
  },
};

export const defaultConfig = {
  defaults: {},
  platformProfiles: [],
};

// ===== 常量 =====

const METADATA_NAMESPACE = 'sessions';

type MemoryClearData = {
  scope: 'session' | 'all';
  types?: string[];
  sessionId?: string;
  results: Array<{ source: string; success: boolean; message: string }>;
  rollbacks: Array<{ source: string; fn: () => Promise<void> }>;
};

// ===== WebuiPages（声明式 UI） =====

const webuiPages: WebuiPage[] = [
  {
    key: 'sessions',
    label: '会话管理',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8M8 14h4"/></svg>',
    order: 6,
    renderer: 'sessions',
  },
];

// ===== Actions =====

export const actions: Record<string, (ctx: Context, args: Record<string, unknown>) => Promise<unknown>> = {
  async listSessions(ctx) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) return [];
    const sessions = sm.listSessions();
    const activeId = sm.getActiveSessionId();
    return sessions.map(s => ({
      ...s,
      displayTitle: s.title || s.name,
      configSummary: formatConfigSummary(s.config),
      childCount: s.children.length,
      isActive: s.id === activeId,
    }));
  },

  async createSession(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const parentId = (args.parentId as string) || undefined;
    // 新建会话时复制当前生效配置，而非留空继承
    let config = (args.config as SessionConfig) || {};
    if (Object.keys(config).length === 0) {
      if (parentId) {
        // 子会话：复制父会话的 resolved config
        config = { ...sm.resolveConfig(parentId, 'webui') };
      } else {
        // 根会话：复制 webui 平台 profile 作为初始配置
        const profiles = sm.getPlatformProfiles();
        if (profiles.webui) config = { ...profiles.webui };
      }
    }
    const session = await sm.createSession({
      name:
        (args.name as string) ||
        `会话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      parentId,
      config,
      createdBy: 'user',
    });
    return session;
  },

  async deleteSession(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    await sm.deleteSession(id);
    return { success: true };
  },

  async switchSession(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    sm.setActiveSessionId(id);
    return { success: true, activeSessionId: id };
  },

  async updateSessionConfig(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    const config = args.config as Partial<SessionConfig>;
    if (!config) throw new Error('缺少配置');
    const session = await sm.updateSession(id, { config: config as SessionConfig });
    return session;
  },

  async getSessionHistory(ctx, args) {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory) throw new Error('memory 服务不可用');
    const sessionId = args.sessionId as string;
    if (!sessionId) throw new Error('缺少 sessionId');
    const limit = (args.limit as number) || 100;
    const history = await memory.getHistory(sessionId, limit);
    return { sessionId, messages: history };
  },

  async getActiveSession(ctx) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) return { sessionId: '' };
    return { sessionId: sm.getActiveSessionId() };
  },

  /** 批量归档会话 */
  async batchArchive(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const ids = args.ids as string[];
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('缺少会话 ID 列表');
    let count = 0;
    for (const id of ids) {
      try {
        await sm.updateSession(id, { status: 'archived' });
        count++;
      } catch {
        /* skip */
      }
    }
    return { success: true, count };
  },

  /** 批量删除会话 */
  async batchDelete(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const ids = args.ids as string[];
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('缺少会话 ID 列表');
    let count = 0;
    for (const id of ids) {
      try {
        await sm.deleteSession(id);
        count++;
      } catch {
        /* skip */
      }
    }
    return { success: true, count };
  },

  async getSessionTree(ctx) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) return [];
    return sm.getTree();
  },

  /** 获取可选项列表（供前端下拉框使用） */
  async getConfigOptions(ctx) {
    // 可用人设列表
    const persona = ctx.getService<PersonaService>('persona');
    const personas = persona?.listModels ? await persona.listModels() : [];

    // 可用 LLM 模型列表（枚举所有 chat-capable entry）
    let models: Array<{ id: string; capabilities: string[]; provider?: string; contextId?: string }> = [];
    try {
      const entries = ctx.getAllServices<LLMModel>('llm', ['chat']);
      models = entries.map(e => ({
        id: e.instance.id,
        capabilities: e.capabilities,
        provider: e.instance.providerId,
        contextId: e.contextId,
      }));
    } catch {
      /* llm 服务不可用 */
    }

    // 工具分组列表
    let toolGroups: Array<{ name: string; label: string }> = [];
    try {
      const tools = ctx.getService<ToolService>('tools');
      if (tools) toolGroups = tools.getGroups().map(g => ({ name: g.name, label: g.label }));
    } catch {
      /* tools 服务不可用 */
    }

    // 已注册平台列表
    const platforms: string[] = [];
    try {
      const allPlatforms = ctx.getAllServices<{ platform: string }>('platform');
      for (const p of allPlatforms) {
        if (p.instance.platform && !platforms.includes(p.instance.platform)) {
          platforms.push(p.instance.platform);
        }
      }
    } catch {
      /* platform 服务不可用 */
    }

    // 平台 profiles
    const sm = ctx.getService<SessionManagerService>('session-manager');
    const profiles = sm?.getPlatformProfiles() ?? {};

    return { personas, models, toolGroups, platforms, profiles };
  },

  /** 获取指定会话的最终生效配置（合并所有层级后的结果） */
  async getResolvedConfig(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const sessionId = args.sessionId as string;
    if (!sessionId) throw new Error('缺少 sessionId');
    const platform = args.platform as string | undefined;
    return sm.resolveConfig(sessionId, platform);
  },

  /**
   * 获取「继承默认」——不含 session 自身 config，只算 platform profile + 父 sessionDefaults。
   * WebUI 「继承 (xxx)」提示用这个，避免显示用户自己的覆盖值。
   */
  async getInheritedDefaults(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const sessionId = args.sessionId as string;
    if (!sessionId) throw new Error('缺少 sessionId');
    const platform = args.platform as string | undefined;
    return sm.resolveInheritedDefaults(sessionId, platform);
  },

  /** 更新平台 profile */
  async updatePlatformProfile(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const platform = args.platform as string;
    if (!platform) throw new Error('缺少 platform');
    const profile = args.profile as PlatformProfile;
    if (!profile) throw new Error('缺少 profile');
    sm.setPlatformProfile(platform, profile);
    return { success: true };
  },

  /** 获取会话详情（含完整消息历史，包括已归档消息） */
  async getSessionDetail(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    const memory = ctx.getService<MemoryService>('memory');
    if (!sm || !memory) throw new Error('服务不可用');
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    const session = sm.getSession(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    const limit = (args.limit as number) || 200;
    // 优先使用 getFullHistory（含已归档消息），确保 UI 能看到完整对话
    const messages = memory.getFullHistory
      ? await memory.getFullHistory(id, limit)
      : await memory.getHistory(id, limit);
    return { session, messages };
  },

  /** 手动重命名会话标题 */
  async renameSession(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const id = args.id as string;
    const title = args.title as string;
    if (!id || !title) throw new Error('缺少 id 或 title');
    await sm.updateSessionTitle(id, title);
    return { success: true };
  },

  /** 归档子会话（父已不再需要） */
  async archiveSession(ctx, args) {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) throw new Error('session-manager 服务不可用');
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    // 递归归档：先归档所有子会话
    const session = sm.getSession(id);
    if (session) {
      for (const childId of session.children) {
        const child = sm.getSession(childId);
        if (child && child.status !== 'archived') {
          await this.archiveSession(ctx, { id: childId });
        }
      }
    }
    await sm.updateSession(id, { status: 'archived' });
    return { success: true };
  },
};

// ===== 辅助函数 =====

function formatConfigSummary(config: SessionConfig): string {
  const parts: string[] = [];
  if (config.llm?.model) parts.push(`${config.llm.provider}/${config.llm.model}`);
  if (config.enabledToolGroups?.length) parts.push(`tools:${config.enabledToolGroups.length}组`);
  if (config.persona) parts.push(`persona:${config.persona}`);
  return parts.join(', ') || '(默认)';
}

// ===== SessionManager 实现 =====

class SessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  private activeSessionId: string = '';
  private ctx: Context;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** 平台 → 默认 SessionConfig 模板 */
  private platformProfiles = new Map<string, PlatformProfile>();
  /** 全局默认配置（platform profile 之下的最低层 fallback） */
  private defaults: Omit<SessionConfig, 'sessionDefaults'> = {};

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /**
   * memory provider 每次惰性查询：ServiceRegistry.get 返回的是裸 entry.instance，
   * 缓存到 field 在 provider 重载后会失效。每次调用走 getService 让 provider 切换
   * 后自然跟随，无需级联 bounce 本插件。
   */
  private get memory(): MemoryService {
    const m = this.ctx.getService<MemoryService>('memory');
    if (!m) throw new Error('session-manager 需要 memory 服务');
    return m;
  }

  /** 从 memory 元数据加载持久化会话列表 */
  async load(): Promise<void> {
    if (!this.memory.listMetadata) {
      this.ctx.logger.debug('memory 服务不支持 metadata，会话列表仅保存在内存中');
      return;
    }
    try {
      const entries = await this.memory.listMetadata(METADATA_NAMESPACE);
      for (const { key, data } of entries) {
        const info = data as unknown as SessionInfo;
        if (info && info.id === key) {
          this.sessions.set(key, info);
        }
      }
      // 恢复 activeSessionId
      const activeMeta = this.memory.getMetadata
        ? await this.memory.getMetadata(METADATA_NAMESPACE, '__active__')
        : undefined;
      if (activeMeta?.sessionId && typeof activeMeta.sessionId === 'string') {
        if (this.sessions.has(activeMeta.sessionId as string)) {
          this.activeSessionId = activeMeta.sessionId as string;
        }
      }
      this.ctx.logger.info(`已加载 ${this.sessions.size} 个会话`);
    } catch (err) {
      this.ctx.logger.warn('加载会话数据失败:', err);
    }
  }

  /** 标记需要持久化并延迟刷盘 */
  private markDirty(): void {
    this.dirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.persist().catch(err => this.ctx.logger.warn('持久化会话失败:', err));
      }, 1000);
    }
  }

  /** 持久化到 memory metadata */
  async persist(): Promise<void> {
    if (!this.dirty || !this.memory.saveMetadata) return;
    this.dirty = false;

    // 保存每个会话
    for (const [id, info] of this.sessions) {
      await this.memory.saveMetadata(METADATA_NAMESPACE, id, info as unknown as Record<string, unknown>);
    }
    // 保存活跃会话
    await this.memory.saveMetadata(METADATA_NAMESPACE, '__active__', { sessionId: this.activeSessionId });

    // 清理已删除的会话（元数据中存在但内存中不存在的）
    if (this.memory.listMetadata) {
      const existing = await this.memory.listMetadata(METADATA_NAMESPACE);
      for (const { key } of existing) {
        if (key !== '__active__' && !this.sessions.has(key) && this.memory.deleteMetadata) {
          await this.memory.deleteMetadata(METADATA_NAMESPACE, key);
        }
      }
    }
  }

  /** 直接注入一个完整的会话对象（用于默认会话等特殊场景） */
  injectSession(session: SessionInfo): void {
    this.sessions.set(session.id, session);
    this.markDirty();
  }

  // ---- CRUD ----

  async createSession(
    opts?: Partial<Omit<SessionInfo, 'id' | 'children' | 'createdAt' | 'updatedAt'>>,
  ): Promise<SessionInfo> {
    const id = opts?.parentId
      ? `${opts.parentId}::${crypto.randomUUID().slice(0, 8)}`
      : `session-${crypto.randomUUID().slice(0, 8)}`;

    const now = Date.now();
    const session: SessionInfo = {
      id,
      name:
        opts?.name ||
        `会话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      title: opts?.metadata?.title as string | undefined,
      parentId: opts?.parentId,
      children: [],
      status: opts?.status || 'active',
      config: opts?.config || {},
      createdAt: now,
      updatedAt: now,
      createdBy: opts?.createdBy || 'user',
      inputContext: opts?.metadata?.inputContext as string | undefined,
      metadata: opts?.metadata,
    };

    this.sessions.set(id, session);

    // 如果有父会话，更新父会话的 children
    if (session.parentId) {
      const parent = this.sessions.get(session.parentId);
      if (parent) {
        parent.children.push(id);
        parent.updatedAt = now;
      }
    }

    this.markDirty();
    await this.ctx.emit('session:created', session);
    this.ctx.logger.info(`会话创建: ${session.name} (${id})`);
    return session;
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[] {
    let result = [...this.sessions.values()];
    if (filter) {
      if (filter.parentId !== undefined) {
        if (filter.parentId === null) {
          result = result.filter(s => !s.parentId);
        } else {
          result = result.filter(s => s.parentId === filter.parentId);
        }
      }
      if (filter.status) {
        result = result.filter(s => s.status === filter.status);
      }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async updateSession(
    id: string,
    updates: Partial<Pick<SessionInfo, 'name' | 'config' | 'status' | 'metadata'>>,
  ): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在: ${id}`);

    if (updates.name !== undefined) session.name = updates.name;
    if (updates.status !== undefined) session.status = updates.status;
    if (updates.metadata !== undefined) session.metadata = { ...session.metadata, ...updates.metadata };
    if (updates.config !== undefined) {
      // 合并配置而不是替换
      session.config = { ...session.config, ...updates.config };
    }
    session.updatedAt = Date.now();

    this.markDirty();
    await this.ctx.emit('session:updated', session);
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    // 递归删除所有子会话（含活跃子会话）
    for (const childId of [...session.children]) {
      await this.deleteSession(childId);
    }

    // 从父会话的 children 中移除
    if (session.parentId) {
      const parent = this.sessions.get(session.parentId);
      if (parent) {
        parent.children = parent.children.filter(c => c !== id);
        parent.updatedAt = Date.now();
      }
    }

    this.sessions.delete(id);

    await this.clearDeletedSessionData(id);

    // 如果删除的是活跃会话，切换到剩余会话
    if (this.activeSessionId === id) {
      const remaining = this.listSessions({ parentId: null });
      this.activeSessionId = remaining[0]?.id || '';
      if (this.activeSessionId) {
        await this.ctx.emit('session:switched', this.activeSessionId);
      }
    }

    this.markDirty();
    await this.ctx.emit('session:deleted', id);
    this.ctx.logger.info(`会话删除: ${session.name} (${id})`);
  }

  private async clearDeletedSessionData(id: string): Promise<void> {
    const clearData: MemoryClearData = {
      scope: 'session',
      sessionId: id,
      results: [],
      rollbacks: [],
    };

    await this.ctx.hooks.run('memory:clear', clearData, async () => {
      try {
        await this.memory.clearSession(id);
        clearData.results.push({ source: 'memory', success: true, message: '会话消息历史已清空' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clearData.results.push({ source: 'memory', success: false, message: `会话消息历史清空失败: ${msg}` });
      }
    });

    const failed = clearData.results.filter(r => !r.success);
    if (failed.length > 0) {
      this.ctx.logger.warn(
        `会话数据清理存在失败项 [${id}]: ${failed.map(r => `${r.source}: ${r.message}`).join('; ')}`,
      );
    }
  }

  // ---- 活跃会话 ----

  getActiveSessionId(): string {
    return this.activeSessionId;
  }

  setActiveSessionId(id: string): void {
    if (!this.sessions.has(id)) {
      this.ctx.logger.warn(`尝试切换到不存在的会话: ${id}`);
      return;
    }
    if (this.activeSessionId === id) return;

    this.activeSessionId = id;
    this.markDirty();
    this.ctx.emit('session:switched', id).catch(() => {});
    this.ctx.logger.info(`活跃会话已切换: ${id}`);
  }

  // ---- 树形操作 ----

  async createChildSession(
    parentId: string,
    opts?: Partial<Omit<SessionInfo, 'id' | 'parentId' | 'children' | 'createdAt' | 'updatedAt'>>,
  ): Promise<SessionInfo> {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error(`父会话不存在: ${parentId}`);

    return this.createSession({
      ...opts,
      parentId,
      createdBy: opts?.createdBy || 'agent',
    });
  }

  getChildren(parentId: string): SessionInfo[] {
    return this.listSessions({ parentId });
  }

  getTree(rootId?: string): SessionTreeNode[] {
    const buildNode = (session: SessionInfo): SessionTreeNode => ({
      session,
      children: session.children
        .map(cid => this.sessions.get(cid))
        .filter((s): s is SessionInfo => !!s)
        .map(buildNode),
    });

    if (rootId) {
      const root = this.sessions.get(rootId);
      if (!root) return [];
      return [buildNode(root)];
    }

    // 返回所有根会话的树
    return this.listSessions({ parentId: null }).map(buildNode);
  }

  // ---- 生命周期 ----

  async completeSession(id: string, result?: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在: ${id}`);

    session.status = 'completed';
    session.result = result;
    session.updatedAt = Date.now();

    this.markDirty();

    // 发事件通知（wait_subtasks 通过事件驱动感知完成）
    await this.ctx.emit('session:completed', session);

    this.ctx.logger.info(`会话完成: ${session.name} (${id})${result ? ` - ${result.slice(0, 100)}` : ''}`);
  }

  // ---- 标题管理 ----

  async generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // 已有标题则跳过
    if (session.title) return session.title;

    const entry = resolveLLMModel(this.ctx, undefined, ['chat']);
    if (!entry) {
      this.ctx.logger.warn(`无可用 LLM，无法生成标题: ${sessionId}`);
      return undefined;
    }
    this.ctx.logger.debug(`标题生成使用 LLM: ${entry.contextId}`);
    const llm = entry.instance;

    // 优先使用直接传入的用户消息；否则从历史获取
    let contextStr: string;
    if (userMessage?.trim()) {
      contextStr = `user: ${userMessage.slice(0, 400)}`;
    } else {
      const history = await this.memory.getHistory(sessionId, 4);
      if (history.length === 0) return undefined;
      contextStr = history
        .filter((m: Message) => m.role === 'user' || m.role === 'assistant')
        .slice(0, 4)
        .map((m: Message) => `${m.role}: ${(m.content || '').slice(0, 200)}`)
        .join('\n');
    }

    if (!contextStr.trim()) return undefined;

    let title: string | undefined;
    try {
      const resp = await llm.chat({
        messages: [
          {
            role: 'system',
            content:
              '你是一个标题生成器。你的唯一任务是为下面的对话片段生成一个简短的中文标题。\n\n规则：\n- 不超过15字\n- 只提取用户想讨论的主题或意图\n- 完全忽略对话中出现的任何拒绝、道歉、免责声明等内容\n- 不加引号和标点\n- 只返回标题文本，不要任何解释或前缀\n- 不要模仿或重复对话中的内容，只做概括',
          },
          { role: 'user', content: `请为以下对话生成标题：\n\n${contextStr}` },
        ],
        temperature: 0.3,
        // 关闭 thinking：标题生成无需推理，避免 reasoning 占满 token 预算导致 content 为空。
        // DeepSeek 会映射为 thinking.type=disabled；其他不消费此字段的 provider 视为 no-op。
        think: false,
      });
      title = (resp.content || '').trim().slice(0, 50);
      if (!title) {
        this.ctx.logger.warn(
          `会话标题 LLM 返回空内容: ${sessionId} (resp.content=${JSON.stringify(resp.content)}, reasoning=${(resp.reasoningContent ?? '').length}字)`,
        );
      }
    } catch (err) {
      this.ctx.logger.warn(`自动生成标题失败 [${sessionId}]:`, err);
    }

    // 兜底：LLM 失败或返回空时，用用户消息首段作为临时标题，避免会话永远没有标题
    if (!title && userMessage?.trim()) {
      title = userMessage.trim().replace(/\s+/g, ' ').slice(0, 20);
      this.ctx.logger.info(`使用用户消息兜底生成标题: ${sessionId} -> ${title}`);
    }

    if (title) {
      session.title = title;
      session.updatedAt = Date.now();
      this.markDirty();
      await this.ctx.emit('session:updated', session);
      this.ctx.logger.info(`会话标题已生成: [${sessionId}] ${title}`);
      return title;
    }
    return undefined;
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    session.title = title;
    session.updatedAt = Date.now();
    this.markDirty();
    await this.ctx.emit('session:updated', session);
  }

  // ---- 配置解析 ----

  /**
   * 解析指定会话的最终生效配置
   *
   * 合并优先级（从高到低）：
   * 1. 会话自身 config
   * 2. 父会话的 sessionDefaults
   * 3. 平台 profile
   * 4. 全局 defaults（最低）
   */
  resolveConfig(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'> {
    const session = this.sessions.get(sessionId);

    const result: Omit<SessionConfig, 'sessionDefaults'> = {};

    // 4. 全局 defaults（最低优先级）
    Object.assign(result, stripUndefined(this.defaults));

    // 3. 平台 profile —— 无论 session 是否存在都应用
    if (platform) {
      const profile = this.platformProfiles.get(platform);
      if (profile) Object.assign(result, stripDefaults(profile));
    }

    if (!session) return result;

    // 2. 父会话 sessionDefaults
    if (session.parentId) {
      const parent = this.sessions.get(session.parentId);
      if (parent?.config?.sessionDefaults) {
        Object.assign(result, stripUndefined(parent.config.sessionDefaults));
      }
    }

    // 1. 会话自身 config（最高优先级）
    Object.assign(result, stripUndefined(session.config));

    // 移除 sessionDefaults（不传递到消费方）
    delete (result as Record<string, unknown>).sessionDefaults;

    return result;
  }

  /**
   * 解析「继承默认」：不含 session 自身 config，只算 defaults + platform profile + 父 sessionDefaults。
   *
   * WebUI 「继承 (xxx)」提示应该用这个值，否则会显示用户自己的覆盖值。
   */
  resolveInheritedDefaults(sessionId: string, platform?: string): Omit<SessionConfig, 'sessionDefaults'> {
    const result: Omit<SessionConfig, 'sessionDefaults'> = {};

    // 3. 全局 defaults（最低）
    Object.assign(result, stripUndefined(this.defaults));

    // 2. 平台 profile
    if (platform) {
      const profile = this.platformProfiles.get(platform);
      if (profile) Object.assign(result, stripDefaults(profile));
    }

    // 1. 父会话 sessionDefaults（最高，覆盖 profile/defaults）
    const session = this.sessions.get(sessionId);
    if (session?.parentId) {
      const parent = this.sessions.get(session.parentId);
      if (parent?.config?.sessionDefaults) {
        Object.assign(result, stripUndefined(parent.config.sessionDefaults));
      }
    }

    delete (result as Record<string, unknown>).sessionDefaults;
    return result;
  }

  getDefaults(): Omit<SessionConfig, 'sessionDefaults'> {
    return { ...this.defaults };
  }

  /** 从配置加载全局 defaults */
  loadDefaults(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const next: Omit<SessionConfig, 'sessionDefaults'> = {};
    if (typeof r.persona === 'string' && r.persona) next.persona = r.persona;
    this.defaults = next;
    if (Object.keys(next).length > 0) {
      this.ctx.logger.info(`已加载全局 defaults: ${Object.keys(next).join(', ')}`);
    }
  }

  getPlatformProfiles(): Record<string, PlatformProfile> {
    const result: Record<string, PlatformProfile> = {};
    for (const [platform, profile] of this.platformProfiles) {
      result[platform] = { ...profile };
    }
    return result;
  }

  setPlatformProfile(platform: string, profile: PlatformProfile): void {
    this.platformProfiles.set(platform, profile);
    this.markDirty();
    this.ctx.logger.info(`平台 profile 已更新: ${platform}`);
  }

  /** 从配置加载平台 profiles */
  loadPlatformProfiles(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || typeof entry.platform !== 'string') continue;
      const profile: PlatformProfile = {};
      if (entry.persona) profile.persona = entry.persona;
      if (entry.llm && typeof entry.llm === 'object' && entry.llm.provider && entry.llm.model) {
        profile.llm = { provider: String(entry.llm.provider), model: String(entry.llm.model) };
      }
      if (Array.isArray(entry.enabledToolGroups)) profile.enabledToolGroups = entry.enabledToolGroups;
      if (entry.disableOutputFormat !== undefined) profile.disableOutputFormat = !!entry.disableOutputFormat;
      if (entry.clientSideJsonRendering !== undefined)
        profile.clientSideJsonRendering = !!entry.clientSideJsonRendering;
      this.platformProfiles.set(entry.platform, profile);
    }
    if (this.platformProfiles.size > 0) {
      this.ctx.logger.info(
        `已加载 ${this.platformProfiles.size} 个平台配置模板: ${[...this.platformProfiles.keys()].join(', ')}`,
      );
    }
  }

  /** 强制持久化并清理定时器 */
  async shutdown(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = true;
    await this.persist();
  }
}

// ===== 工具函数 =====

/** 移除值为 undefined 的键 */
function stripUndefined(obj: object | undefined): Record<string, unknown> {
  if (!obj) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** stripDefaults 与 stripUndefined 功能相同 —— 只保留有值的字段 */
const stripDefaults = stripUndefined;

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  // 注册 WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  if (!ctx.hasService('memory')) {
    ctx.logger.error('memory 服务不可用，会话管理无法启动');
    return;
  }

  const manager = new SessionManager(ctx);

  // 从持久化存储加载
  await manager.load();

  // 加载平台 profiles
  manager.loadPlatformProfiles(config.platformProfiles);
  // 加载全局 defaults
  manager.loadDefaults(config.defaults);

  // 注册服务
  ctx.provide('session-manager', manager, {
    capabilities: [SessionManagerCapabilities.SessionCrud, SessionManagerCapabilities.SessionTree],
    label: '会话管理',
  });

  // 监听 session:switched 事件，通过 WebSocket 广播到客户端
  ctx.on('session:switched', (sessionId: string) => {
    // WebUI server 会监听此事件并广播给所有客户端
    ctx.logger.debug(`广播会话切换: ${sessionId}`);
  });

  // ===== 会话状态自治管理 =====
  // 监听消息事件，自动维护会话状态（从 Agent 职责中迁出）

  ctx.on('inbound:message', (msg: { sessionId: string }) => {
    if (!msg.sessionId) return;
    const session = manager.getSession(msg.sessionId);
    if (session && session.status !== 'active') {
      manager.updateSession(msg.sessionId, { status: 'active' }).catch(() => {});
    }
  });

  ctx.on('outbound:message', (msg: { sessionId: string }) => {
    if (!msg.sessionId) return;
    const session = manager.getSession(msg.sessionId);
    // 子会话（有 parentId）由 plugin-session-tools 的 agent:turn:after 中间件负责完成并提取 result
    if (session && session.status === 'active' && !session.parentId) {
      manager.updateSession(msg.sessionId, { status: 'completed' }).catch(() => {});
    }
  });

  // 监听用户消息事件 → 自动生成会话标题
  // 在用户首次发消息时即生成标题，无需等待 AI 回复
  // 仅对 webui / cli 等用户交互平台生效，onebot 等外部平台不生成标题
  const TITLE_PLATFORMS = new Set(['webui', 'cli']);
  const titleGenerating = new Set<string>();
  ctx.on('inbound:message', (msg: { content: string; sessionId: string; platform?: string }) => {
    const { sessionId, platform } = msg;
    if (!sessionId) {
      ctx.logger.debug('标题生成跳过: 缺少 sessionId');
      return;
    }
    if (titleGenerating.has(sessionId)) return;
    // 仅对指定平台生成标题；非 webui/cli 平台（如 onebot）静默跳过，避免日志污染。
    if (platform && !TITLE_PLATFORMS.has(platform)) return;
    const session = manager.getSession(sessionId);
    if (!session) {
      ctx.logger.warn(`标题生成跳过: 会话不存在 ${sessionId}`);
      return;
    }
    // 已有标题或子任务会话跳过（静默）
    if (session.title || session.parentId) return;
    titleGenerating.add(sessionId);
    ctx.logger.info(`开始生成会话标题: ${sessionId} (platform=${platform ?? 'unknown'})`);
    // 异步生成，不阻塞消息处理；直接传入用户消息避免依赖历史
    manager
      .generateTitle(sessionId, msg.content)
      .catch(err => ctx.logger.warn('标题生成失败:', err))
      .finally(() => titleGenerating.delete(sessionId));
  });

  // 应用停止时持久化：在 app:stopping 阶段执行，此时各 memory 插件尚未 dispose（数据库连接仍在）
  ctx.on('app:stopping', async () => {
    await manager.shutdown();
  });

  ctx.logger.info('会话管理服务已启用');
}
