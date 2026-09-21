import { agent } from '@aalis/api-agent';
import { listLLMModels, llm, resolveLLMModel } from '@aalis/api-llm';
import { type MemoryService, type MetadataOp, memory } from '@aalis/api-memory';
import { persona } from '@aalis/api-persona';
import { platform } from '@aalis/api-platform';
import {
  type PlatformProfile,
  type SessionConfig,
  type SessionInfo,
  type SessionManagerService,
  type SessionTreeNode,
  sessionManager,
} from '@aalis/api-session-manager';
import { tools } from '@aalis/api-tools';
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
import { type BoundOf, config, definePlugin, events, hooks, lifecycle, logger, optional, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import type { Message } from '@aalis/schema-message';

export type {
  PlatformProfile,
  SessionConfig,
  SessionInfo,
  SessionManagerService,
  SessionTreeNode,
} from '@aalis/api-session-manager';

const configSchema: ConfigSchema = {
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
    default: [],
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
      think: {
        type: 'select',
        label: 'thinking 默认',
        options: [
          { label: '继承 provider 全局配置', value: '' },
          { label: '强制开启', value: 'on' },
          { label: '强制关闭', value: 'off' },
        ],
        description: '该平台会话的深度思考默认档。留空=各 LLM provider 自行决定；会话可用 /session.set -t 进一步覆盖。',
      },
    },
  },
};

// ===== 常量 =====

const METADATA_NAMESPACE = 'sessions';

type MemoryClearData = {
  scope: 'session' | 'all';
  types?: string[];
  sessionId?: string;
  results: Array<{ source: string; success: boolean; message: string }>;
};

// ===== WebuiPages（声明式 UI） =====

/**
 * WebUI 传来的会话配置补丁：JSON 带不了 undefined，前端用 null 表示「删除该键、恢复继承」。
 * updateSession 是合并语义，键置为 undefined 即从生效配置里消失（resolveConfig 会 strip）。
 */
export function normalizeSessionConfigPatch(patch: unknown): Partial<SessionConfig> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('缺少配置');
  return Object.fromEntries(
    Object.entries(patch as Record<string, unknown>).map(([k, v]) => [k, v === null ? undefined : v]),
  ) as Partial<SessionConfig>;
}

const webuiPages: WebuiPage[] = [
  {
    key: 'sessions',
    label: '会话管理',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8M8 14h4"/></svg>',
    order: 6,
    renderer: 'sessions',
  },
];

// ===== 辅助函数 =====

/**
 * 递归归档：先归档所有子会话再归档自己。
 *
 * 写成自由函数而非方法：页面动作是被单独取出调用的（没有 receiver），递归不能依赖 this。
 */
async function archiveRecursively(sm: SessionManagerService, id: string): Promise<void> {
  const session = sm.getSession(id);
  if (session) {
    for (const childId of session.children) {
      const child = sm.getSession(childId);
      if (child && child.status !== 'archived') {
        await archiveRecursively(sm, childId);
      }
    }
  }
  await sm.updateSession(id, { status: 'archived' });
}

function formatConfigSummary(config: SessionConfig): string {
  const parts: string[] = [];
  if (config.llm?.model) parts.push(`${config.llm.provider}/${config.llm.model}`);
  if (config.enabledToolGroups?.length)
    parts.push(config.enabledToolGroups.includes('*') ? 'tools:全部' : `tools:${config.enabledToolGroups.length}组`);
  if (config.persona) parts.push(`persona:${config.persona}`);
  return parts.join(', ') || '(默认)';
}

// ===== SessionManager 实现 =====

/** SessionManager 用到的能力：落盘的 memory、会话事件、memory:clear 钩子、标题生成的 LLM */
type ManagerCaps = Pick<Caps, 'memory' | 'events' | 'hooks' | 'logger' | 'llm'>;

class SessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  private caps: ManagerCaps;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** 平台 → 默认 SessionConfig 模板 */
  private platformProfiles = new Map<string, PlatformProfile>();
  /** 全局默认配置（platform profile 之下的最低层 fallback） */
  private defaults: Omit<SessionConfig, 'sessionDefaults'> = {};

  constructor(caps: ManagerCaps) {
    this.caps = caps;
  }

  /**
   * memory provider 每次惰性查询：ServiceRef.current 返回的是提供者本身，
   * 缓存到 field 在 provider 重载后会失效。每次调用重新解析让 provider 切换
   * 后自然跟随，无需级联 bounce 本插件。
   */
  private get memory(): MemoryService {
    const m = this.caps.memory.current;
    if (!m) throw new Error('session-manager 需要 memory 服务');
    return m;
  }

  /** 从 memory 元数据加载持久化会话列表 */
  async load(): Promise<void> {
    try {
      const entries = await this.memory.listMetadata(METADATA_NAMESPACE);
      for (const { key, data } of entries) {
        const info = data as unknown as SessionInfo;
        if (info && info.id === key) {
          this.sessions.set(key, info);
        }
      }
      this.caps.logger.info(`已加载 ${this.sessions.size} 个会话`);
    } catch (err) {
      this.caps.logger.warn('加载会话数据失败:', err);
    }
  }

  /** 标记需要持久化并延迟刷盘 */
  private markDirty(): void {
    this.dirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.persist().catch(err => this.caps.logger.warn('持久化会话失败:', err));
      }, 1000);
    }
  }

  /**
   * 持久化到 memory metadata —— **一次批量提交**。
   *
   * 逐条 saveMetadata + 全表扫逐个 deleteMetadata 的写法配上开头就置 false 的 `dirty`：
   * 任何一条抛错就停在半新半旧，且下一次 debounce 不会重试。
   *
   * 整批提交的**原子性按后端分档**（见 api-memory 契约）：sqlite/inmemory 真事务，
   * mongodb 只保证按序执行遇错即停，仍可能停在半新半旧。本场景对此免疫，靠的不是原子性
   * 而是**幂等 + 可重试**：每次写的是全量快照（不是增量），失败时 dirty 复位，下一次
   * markDirty 会把完整状态重写一遍并重扫孤儿，前一次的半成品被整体覆盖。
   */
  async persist(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const ops: MetadataOp[] = [...this.sessions].map(([id, info]) => ({
      op: 'put',
      namespace: METADATA_NAMESPACE,
      key: id,
      data: info as unknown as Record<string, unknown>,
    }));
    try {
      // 清理孤儿：元数据里有、内存里没有的记录，与上面的写入同批提交。
      // **这一句必须在 try 内**：它同样会抛（provider 换人的窗口里 `this.memory` getter 就会），
      // 而 dirty 已在上面置 false —— 落在外面就等于「这批变更丢了且永不重试」，正是本方法
      // 要消灭的那个病。
      for (const { key } of await this.memory.listMetadata(METADATA_NAMESPACE)) {
        if (!this.sessions.has(key)) ops.push({ op: 'del', namespace: METADATA_NAMESPACE, key });
      }
      await this.memory.commitMetadata(ops);
    } catch (err) {
      this.dirty = true; // 失败要能重试，否则这批变更永远落不了盘
      throw err;
    }
  }

  /**
   * 按精确 id 幂等 upsert：命中走 updateSession（合并 config + emit `session:updated`），
   * 未命中以传入 id 建 active 记录（emit `session:created`）。
   * 平台派生 sessionId（onebot 等）首次落配置覆盖时用——那些 id 不经 createSession 预建。
   */
  async ensureSession(
    id: string,
    patch: Partial<Pick<SessionInfo, 'name' | 'config' | 'status' | 'metadata' | 'createdBy'>> = {},
  ): Promise<SessionInfo> {
    if (this.sessions.has(id)) {
      // updateSession 不接受 createdBy（建档专用），命中路径剥离后转发
      const { createdBy: _ignore, ...updates } = patch;
      return this.updateSession(id, updates);
    }
    const now = Date.now();
    const session: SessionInfo = {
      id,
      name:
        patch.name ||
        `会话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      title: patch.metadata?.title as string | undefined,
      parentId: undefined,
      children: [],
      status: patch.status || 'active',
      config: patch.config || {},
      createdAt: now,
      updatedAt: now,
      createdBy: patch.createdBy || 'user',
      inputContext: patch.metadata?.inputContext as string | undefined,
      metadata: patch.metadata,
    };
    this.sessions.set(id, session);
    this.markDirty();
    await this.caps.events.emit('session:created', session);
    this.caps.logger.info(`会话建档(ensure): ${session.name} (${id})`);
    return session;
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
      inputContext: opts?.inputContext ?? (opts?.metadata?.inputContext as string | undefined),
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
    await this.caps.events.emit('session:created', session);
    this.caps.logger.info(`会话创建: ${session.name} (${id})`);
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
    await this.caps.events.emit('session:updated', session);
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

    this.markDirty();
    await this.caps.events.emit('session:deleted', id);
    this.caps.logger.info(`会话删除: ${session.name} (${id})`);
  }

  private async clearDeletedSessionData(id: string): Promise<void> {
    const clearData: MemoryClearData = {
      scope: 'session',
      sessionId: id,
      results: [],
    };

    await this.caps.hooks.run('memory:clear', clearData, async () => {
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
      this.caps.logger.warn(
        `会话数据清理存在失败项 [${id}]: ${failed.map(r => `${r.source}: ${r.message}`).join('; ')}`,
      );
    }
  }

  // ---- 树形操作 ----

  async createChildSession(
    parentId: string,
    opts?: Partial<Omit<SessionInfo, 'id' | 'parentId' | 'children' | 'createdAt' | 'updatedAt'>>,
  ): Promise<SessionInfo> {
    // 平台派生会话（cli-default、OneBot 会话 id）从不经 createSession 预建，父档缺失是常态；
    // 先兜底建档再挂子会话，否则 create_subtask 在这些平台必败。
    if (!this.sessions.has(parentId)) await this.ensureSession(parentId);

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
    await this.caps.events.emit('session:completed', session);

    this.caps.logger.info(`会话完成: ${session.name} (${id})${result ? ` - ${result.slice(0, 100)}` : ''}`);
  }

  // ---- 标题管理 ----

  async generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // 已有标题则跳过
    if (session.title) return session.title;

    const entry = resolveLLMModel(this.caps.llm, undefined, ['chat']);
    if (!entry) {
      this.caps.logger.warn(`无可用 LLM，无法生成标题: ${sessionId}`);
      return undefined;
    }
    this.caps.logger.debug(`标题生成使用 LLM: ${entry.contextId}`);
    const model = entry.instance;

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
      const resp = await model.chat({
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
        this.caps.logger.warn(
          `会话标题 LLM 返回空内容: ${sessionId} (resp.content=${JSON.stringify(resp.content)}, reasoning=${(resp.reasoningContent ?? '').length}字)`,
        );
      }
    } catch (err) {
      this.caps.logger.warn(`自动生成标题失败 [${sessionId}]:`, err);
    }

    // 兜底：LLM 失败或返回空时，用用户消息首段作为临时标题，避免会话永远没有标题
    if (!title && userMessage?.trim()) {
      title = userMessage.trim().replace(/\s+/g, ' ').slice(0, 20);
      this.caps.logger.info(`使用用户消息兜底生成标题: ${sessionId} -> ${title}`);
    }

    if (title) {
      session.title = title;
      session.updatedAt = Date.now();
      this.markDirty();
      await this.caps.events.emit('session:updated', session);
      this.caps.logger.info(`会话标题已生成: [${sessionId}] ${title}`);
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
    await this.caps.events.emit('session:updated', session);
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
      this.caps.logger.info(`已加载全局 defaults: ${Object.keys(next).join(', ')}`);
    }
  }

  getPlatformProfiles(): Record<string, PlatformProfile> {
    const result: Record<string, PlatformProfile> = {};
    for (const [platform, profile] of this.platformProfiles) {
      result[platform] = { ...profile };
    }
    return result;
  }

  /** 从配置加载平台 profiles（唯一入口：平台档属插件配置，无运行时写接口——写了也不落盘） */
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
      // think 三态：布尔（yaml 手写）与 'on'/'off'（WebUI select 存字符串）都认；
      // null / 空串 = 未设置（继承 provider 全局配置），维持 null≡undefined 契约。
      if (entry.think === true || entry.think === 'on') profile.think = true;
      else if (entry.think === false || entry.think === 'off') profile.think = false;
      this.platformProfiles.set(entry.platform, profile);
    }
    if (this.platformProfiles.size > 0) {
      this.caps.logger.info(
        `已加载 ${this.platformProfiles.size} 个平台配置模板: ${[...this.platformProfiles.keys()].join(', ')}`,
      );
    }
  }

  /**
   * 关停收尾：仍 `active` 的会话立即收口并落盘。
   *
   * 枚举没有 interrupted：回合结束（含用户停止 / abort）既有收口就是 `completed`，
   * 关停打断在飞回合与那条路径同义，沿用同一状态，不新造值。
   * waiting / completed / error / archived 不是在飞，原样保留。
   *
   * 必须在 onDrain 做完：agent↔SM 是 optional 互用，不能指望 agent 钩子还在。
   * persist 也在这里立刻刷，不走 1s debounce——onDispose 的 shutdown 仍会再刷一次。
   */
  async settleActiveOnDrain(): Promise<void> {
    let closed = 0;
    for (const session of this.sessions.values()) {
      if (session.status !== 'active') continue;
      session.status = 'completed';
      session.updatedAt = Date.now();
      closed++;
    }
    if (closed > 0) this.dirty = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
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

/**
 * 移除值为 undefined / null 的键。
 *
 * null 必须一起剥：清除会话覆盖（`/model 复位`）写入的是 undefined，
 * 而它经 BSON 持久化后读回来是 **null**。不剥的话这个 null 会在 Object.assign 里
 * 把平台 profile 的同名字段盖成空——agent 侧判 `llm?.provider && llm?.model` 不成立、
 * 退回 `resolveLLMModel(undefined)`，静默落到首个注册的 entry。表现就是
 * 「配置里写着 A，实际跑的是 B」，且没有任何告警。persona 同理。
 * 本模型里「没有值」一律等于「继承上层」，null 与 undefined 同义。
 */
function stripUndefined(obj: object | undefined): Record<string, unknown> {
  if (!obj) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) result[key] = value;
  }
  return result;
}

/** stripDefaults 与 stripUndefined 功能相同 —— 只保留有值的字段 */
const stripDefaults = stripUndefined;

// ===== 页面动作 =====

/** 页面动作用到的能力：登记口 webui、读历史的 memory，以及供下拉框枚举选项的 persona / llm / tools / platform */
type ActionCaps = Pick<Caps, 'webui' | 'memory' | 'persona' | 'llm' | 'tools' | 'platform'>;

/**
 * 页面动作全是 apply 里的闭包：直接用这次激活的 manager 与能力，
 * 登记随激活存亡（插件不在，WebUI 就调不到这些方法）。
 */
function registerSessionActions(caps: ActionCaps, manager: SessionManager): void {
  const { webui, memory, persona, llm, tools, platform } = caps;

  webui.registerAction('listSessions', async () =>
    manager.listSessions().map(s => ({
      ...s,
      displayTitle: s.title || s.name,
      configSummary: formatConfigSummary(s.config),
      childCount: s.children.length,
    })),
  );

  webui.registerAction('createSession', async args => {
    const parentId = (args.parentId as string) || undefined;
    // 新建会话时复制当前生效配置，而非留空继承
    let config = (args.config as SessionConfig) || {};
    if (Object.keys(config).length === 0) {
      if (parentId) {
        // 子会话：复制父会话的 resolved config
        config = { ...manager.resolveConfig(parentId, 'webui') };
      } else {
        // 根会话：复制 webui 平台 profile 作为初始配置
        const profiles = manager.getPlatformProfiles();
        if (profiles.webui) config = { ...profiles.webui };
      }
    }
    return manager.createSession({
      name:
        (args.name as string) ||
        `会话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      parentId,
      config,
      createdBy: 'user',
      // 新建的空会话尚未发生任何对话，初始为 'waiting'（等待中）而非 'active'（进行中）。
      // 否则侧栏新建的会话会一直显示"进行中"——直到首条消息触发 inbound→active→turn:after→completed。
      status: 'waiting',
    });
  });

  webui.registerAction('deleteSession', async args => {
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    await manager.deleteSession(id);
    return { success: true };
  });

  webui.registerAction('updateSessionConfig', async args => {
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    return manager.updateSession(id, { config: normalizeSessionConfigPatch(args.config) });
  });

  webui.registerAction('getSessionHistory', async args => {
    const store = memory.current;
    if (!store) throw new Error('memory 服务不可用');
    const sessionId = args.sessionId as string;
    if (!sessionId) throw new Error('缺少 sessionId');
    const limit = (args.limit as number) || 100;
    const history = await store.getHistory(sessionId, limit);
    return { sessionId, messages: history };
  });

  /** 批量归档会话 */
  webui.registerAction('batchArchive', async args => {
    const ids = args.ids as string[];
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('缺少会话 ID 列表');
    let count = 0;
    for (const id of ids) {
      try {
        await manager.updateSession(id, { status: 'archived' });
        count++;
      } catch {
        /* skip */
      }
    }
    return { success: true, count };
  });

  /** 批量删除会话 */
  webui.registerAction('batchDelete', async args => {
    const ids = args.ids as string[];
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('缺少会话 ID 列表');
    let count = 0;
    for (const id of ids) {
      try {
        await manager.deleteSession(id);
        count++;
      } catch {
        /* skip */
      }
    }
    return { success: true, count };
  });

  webui.registerAction('getSessionTree', async () => manager.getTree());

  /** 获取可选项列表（供前端下拉框使用） */
  webui.registerAction('getConfigOptions', async () => {
    // 可用人设列表
    const personaService = persona.current;
    const personas = personaService?.listModels ? await personaService.listModels() : [];

    // 可用 LLM 模型列表（枚举所有 chat-capable entry）
    const models = listLLMModels(llm, { caps: ['chat'] }).map(e => ({
      id: e.instance.id,
      capabilities: [...e.instance.capabilities],
      provider: e.instance.providerId,
      contextId: e.contextId,
    }));

    // 工具分组列表
    const toolGroups = tools.current?.getGroups().map(g => ({ name: g.name, label: g.label })) ?? [];

    // 已注册平台列表
    const platforms: string[] = [];
    for (const entry of platform.all()) {
      const platformName = entry.instance.platform;
      if (platformName && !platforms.includes(platformName)) platforms.push(platformName);
    }

    return { personas, models, toolGroups, platforms, profiles: manager.getPlatformProfiles() };
  });

  /** 获取指定会话的最终生效配置（合并所有层级后的结果） */
  webui.registerAction('getResolvedConfig', async args => {
    const sessionId = args.sessionId as string;
    if (!sessionId) throw new Error('缺少 sessionId');
    return manager.resolveConfig(sessionId, args.platform as string | undefined);
  });

  /**
   * 获取「继承默认」——不含 session 自身 config，只算 platform profile + 父 sessionDefaults。
   * WebUI 「继承 (xxx)」提示用这个，避免显示用户自己的覆盖值。
   */
  webui.registerAction('getInheritedDefaults', async args => {
    const sessionId = args.sessionId as string;
    if (!sessionId) throw new Error('缺少 sessionId');
    return manager.resolveInheritedDefaults(sessionId, args.platform as string | undefined);
  });

  /** 获取会话详情（含完整消息历史，包括已归档消息） */
  webui.registerAction('getSessionDetail', async args => {
    const store = memory.current;
    if (!store) throw new Error('memory 服务不可用');
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    const session = manager.getSession(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    const limit = (args.limit as number) || 200;
    // 优先使用 getFullHistory（含已归档消息），确保 UI 能看到完整对话
    const messages = store.getFullHistory ? await store.getFullHistory(id, limit) : await store.getHistory(id, limit);
    return { session, messages };
  });

  /** 手动重命名会话标题 */
  webui.registerAction('renameSession', async args => {
    const id = args.id as string;
    const title = args.title as string;
    if (!id || !title) throw new Error('缺少 id 或 title');
    await manager.updateSessionTitle(id, title);
    return { success: true };
  });

  /** 归档子会话（父已不再需要） */
  webui.registerAction('archiveSession', async args => {
    const id = args.id as string;
    if (!id) throw new Error('缺少会话 ID');
    await archiveRecursively(manager, id);
    return { success: true };
  });
}

// ===== 插件入口 =====

const uses = {
  /** 会话档案与消息历史的唯一落点：没有 memory 就没有会话管理 */
  memory,
  /**
   * 本插件不调用 agent 的方法；声明它是为了 agent:* 钩子的键类型。
   * 关停顺序由 core 按实际绑定编排：optional 互用的两方只保证彼此 drain 期间存活，
   * 不保证对方 close 之后钩子还在。在飞会话由本插件 onDrain 自行收口落盘，
   * 不依赖 agent 中间件先于自己消失。
   */
  agent: optional(agent),
  /** 自动标题的模型来源；没有 LLM 时退回用户消息首段 */
  llm: optional(llm),
  /** 下列三项只供 WebUI 下拉框枚举选项，缺席即空列表 */
  persona: optional(persona),
  platform: optional(platform),
  tools: optional(tools),
  /** 页面与页面动作的登记口；无 WebUI 时会话管理照常在后台运行 */
  webui: optional(webuiServer),
  events,
  hooks,
  lifecycle,
  logger,
  config,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-session-manager',
  displayName: '会话管理',
  subsystem: 'session',
  configSchema,
  provides: [sessionManager],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { memory, webui, events, hooks, lifecycle, logger, provide } = caps;

  // 注册 WebUI 页面
  for (const page of webuiPages) webui.registerPage(page);

  if (memory.current === undefined) {
    logger.error('memory 服务不可用，会话管理无法启动');
    return;
  }

  const manager = new SessionManager(caps);

  // 从持久化存储加载
  await manager.load();

  // 加载平台 profiles
  manager.loadPlatformProfiles(caps.config.platformProfiles);
  // 加载全局 defaults
  manager.loadDefaults(caps.config.defaults);

  // 注册服务
  provide(sessionManager, manager, { label: '会话管理' });

  registerSessionActions(caps, manager);

  // ===== 会话状态自治管理 =====
  // 监听消息事件，自动维护会话状态（从 Agent 职责中迁出）

  events.on('inbound:message', (msg: { sessionId: string }) => {
    if (!msg.sessionId) return;
    const session = manager.getSession(msg.sessionId);
    if (session && session.status !== 'active') {
      manager.updateSession(msg.sessionId, { status: 'active' }).catch(() => {});
    }
  });

  events.on('outbound:message', (msg: { sessionId: string }) => {
    if (!msg.sessionId) return;
    const session = manager.getSession(msg.sessionId);
    // 子会话（有 parentId）由 plugin-session-tools 的 agent:turn:after 中间件负责完成并提取 result
    if (session && session.status === 'active' && !session.parentId) {
      manager.updateSession(msg.sessionId, { status: 'completed' }).catch(() => {});
    }
  });

  // 回合终态收口：agent 在 replied/silent/aborted/error 四条路径都会发 agent:turn:after。
  // 上面的 outbound:message 只覆盖"产生了回复"的情形——用户中途停止生成（aborted）或
  // 空回复（silent）时不发 outbound:message，会话会永远停在 'active'（即"进行中"）。
  // 这里订阅生命周期钩子作幂等互补，确保任何回合结束都把根会话收口为 'completed'。
  hooks.middleware('agent:turn:after', async (data, next) => {
    await next();
    if (!data.sessionId) return;
    const session = manager.getSession(data.sessionId);
    // 子会话由 plugin-session-tools 负责完成并回传 result，这里只收口根会话。
    if (session && session.status === 'active' && !session.parentId) {
      manager.updateSession(data.sessionId, { status: 'completed' }).catch(() => {});
    }
  });

  // 监听用户消息事件 → 自动生成会话标题
  // 在用户首次发消息时即生成标题，无需等待 AI 回复
  // 仅对 webui / cli 等用户交互平台生效，onebot 等外部平台不生成标题
  const TITLE_PLATFORMS = new Set(['webui', 'cli']);
  const titleGenerating = new Set<string>();
  events.on('inbound:message', (msg: { content: string; sessionId: string; platform?: string }) => {
    const { sessionId, platform } = msg;
    if (!sessionId) {
      logger.debug('标题生成跳过: 缺少 sessionId');
      return;
    }
    if (titleGenerating.has(sessionId)) return;
    // 仅对指定平台生成标题；非 webui/cli 平台（如 onebot）静默跳过，避免日志污染。
    // platform 缺省同样跳过：白名单是正向门，来路不明的消息不该顺带建档 + 烧一次 LLM 生成标题。
    if (!platform || !TITLE_PLATFORMS.has(platform)) return;
    const session = manager.getSession(sessionId);
    // 已有标题或子任务会话跳过（静默）
    if (session && (session.title || session.parentId)) return;
    titleGenerating.add(sessionId);
    logger.info(`开始生成会话标题: ${sessionId} (platform=${platform})`);
    // 平台派生会话（cli-default 等）从不经 createSession 预建，缺档是常态：先兜底建档再生成
    // 标题（与 createChildSession 同路），否则这些平台永远没有标题、且每条消息告警一次。
    // 异步生成，不阻塞消息处理；直接传入用户消息避免依赖历史
    (session ? Promise.resolve() : manager.ensureSession(sessionId).then(() => undefined))
      .then(() => manager.generateTitle(sessionId, msg.content))
      .catch(err => logger.warn('标题生成失败:', err))
      .finally(() => titleGenerating.delete(sessionId));
  });

  // 关停收尾：仍 active 的会话在 onDrain 收口并落盘（不依赖 agent 钩子还在）。
  // 持久化仍走 onDispose：覆盖 bounce / unload / updateConfig 等全部拆卸路径
  // （只在全局停机触发的话，热重载即丢会话元数据）。
  // 异步收尾由编排层的 disposeAsync 等待完成；app.stop() 的拓扑逆序保证此时 memory 提供者
  // 尚未关闭，单独热重载/禁用 memory 提供者时无此保证。shutdown() 幂等：清 timer + 置 dirty + 落盘。
  lifecycle.onDrain(() => manager.settleActiveOnDrain(), '收口在飞会话');
  lifecycle.onDispose(() => manager.shutdown());

  logger.info('会话管理服务已启用');
}
