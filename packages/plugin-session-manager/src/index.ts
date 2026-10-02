import { agent } from '@aalis/api-agent';
import { resolveSessionOrigin } from '@aalis/api-gateway';
import { type HookContextMap, hooks } from '@aalis/api-hooks';
import { hostConfig } from '@aalis/api-host-config';
import { llm, resolveLLMModel } from '@aalis/api-llm';
import { type MemoryService, type MetadataOp, memory } from '@aalis/api-memory';
import { getPlatformNames, platform, resolvePlatformBySession } from '@aalis/api-platform';
import {
  type InheritanceSource,
  type NewSessionFields,
  type RegisteredSessionSetting,
  type SessionConfig,
  type SessionConfigLayer,
  type SessionConfigPatch,
  type SessionInfo,
  type SessionInheritance,
  type SessionManagerService,
  type SessionSetting,
  type SessionTreeNode,
  type SessionUpdates,
  sessionKind,
  sessionManager,
} from '@aalis/api-session-manager';
import { type BoundOf, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import type { IncomingMessage, Message } from '@aalis/schema-message';
import {
  AUDIENCE_NAMES,
  applyPatch,
  assertLayer,
  checkPatch,
  type Layers,
  listLayers,
  rawLayer,
  readLayers,
  readSetting,
  SettingRegistry,
  type SettingValues,
  writeLayer,
} from './settings.js';

// ===== 常量 =====

const METADATA_NAMESPACE = 'sessions';
/** 读会话表失败后的重试间隔（毫秒）；用尽仍失败按读表失败处理 */
const LOAD_RETRY_DELAYS = [1000, 3000, 10_000];
/**
 * owner 面的交互入口：自动标题只给它们的会话生成；它们发进 IM 房间的消息是 owner 插话，不是房间的原生入站，
 * 不拿来判 id 前缀与平台名是否一致
 */
const OWNER_ENTRY_PLATFORMS: ReadonlySet<string> = new Set(['webui', 'cli']);

// ===== 辅助函数 =====

/** 等待 ms 毫秒，signal 中止时提前返回。不用 node:timers/promises：全局定时器测试里能用假时钟推进 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// ===== SessionManager 实现 =====

/**
 * SessionManager 用到的能力：落盘的 memory、会话事件、memory:clear 钩子、标题生成的 LLM、中止读表重试的 lifecycle，
 * 解析接管房间的适配器实例的 platform，以及存放会话设置各层的宿主配置文档
 */
type ManagerCaps = Pick<
  Caps,
  'memory' | 'events' | 'hooks' | 'logger' | 'llm' | 'lifecycle' | 'platform' | 'hostConfig'
>;

/** 回合的结局（api-agent 的 agent:turn:after） */
type TurnOutcome = HookContextMap['agent:turn:after']['outcome'];

class SessionManager implements SessionManagerService {
  private sessions = new Map<string, SessionInfo>();
  private caps: ManagerCaps;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /**
   * 本进程显式删除、尚未落盘的会话（墓碑）。persist 写全量快照，但只删这些键，不按「后端有、内存无」清扫：
   * 后端里还可能有本进程没读到的会话，按差集清扫会把它们当孤儿删掉。每条墓碑带令牌，提交成功后只清掉
   * 提交时那一版，提交期间再删的保留到下一次。换后端时墓碑随旧表一起作废。
   */
  private deleted = new Map<string, symbol>();
  /**
   * 会话表所在的 memory 实例：跟随 memory 胜者。换人时先把旧表的未落盘变更写回旧实例，再从新实例读表整体替换
   * （换后端即换库，不跨后端合并）。新表加载完成前仍指向旧实例，落盘不会把旧表写进新后端；加载窗口里的改动
   * 在换表时写回旧实例。读表失败时为 undefined：空表不能当作权威，否则落盘会用新建的空白记录覆盖后端原记录。
   */
  private store: MemoryService | undefined;
  /** 最近一次挂接的加载；apply 等它完成再对外提供服务 */
  loading: Promise<void> = Promise.resolve();
  /** 插件登记的设置项：登记与撤回都发 session:config:changed */
  private readonly settings = new SettingRegistry(() => void this.caps.events.emit('session:config:changed'));
  /** 已告警过的设置问题：取值无效、文档形状不对。解析每轮都跑，同一处只告警一次 */
  private readonly warned = new Set<string>();
  /**
   * 在飞的回合：turnId → 所在会话与这一轮的结局。agent:input:before 进出登记与注销，结局由 agent:turn:after 记下
   * （消息被拦下的一轮不发它，没有结局）。同一会话按 lane 可以并行多轮（后台命令结束通知、白纸通知与真人回合），
   * 根会话在最后一轮结束时才收口；回合之外建档的会话按这里有没有回合定初始状态（见 ensureSession）
   */
  private turns = new Map<string, { sessionId: string; outcome?: TurnOutcome }>();
  /** 正在解析所属实例的会话记录：同一条记录不并发解析，后到的调用不等它、直接返回 */
  private resolving = new WeakSet<SessionInfo>();

  constructor(caps: ManagerCaps) {
    this.caps = caps;
  }

  /**
   * 消息历史类操作（清空、读历史）用当前胜者：新消息写在当前胜者里。每次惰性查询，provider 切换后自然跟随。
   * 会话表另经 {@link store} 跟随，见 {@link attach}。
   */
  private get memory(): MemoryService {
    const m = this.caps.memory.current;
    if (!m) throw new Error('session-manager 需要 memory 服务');
    return m;
  }

  /**
   * memory 胜者的 follow 挂接：从这个实例读会话表并整体替换内存里的这份。
   * 返回的清理在换人或关闭时执行：中止读表重试的等待，等本次加载落定，再把未落盘的变更写回这个实例。
   */
  attach(instance: MemoryService): () => Promise<void> {
    const detached = new AbortController();
    this.loading = this.load(instance, AbortSignal.any([detached.signal, this.caps.lifecycle.signal]));
    return async () => {
      detached.abort();
      await this.loading;
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      await this.persist().catch(err => this.caps.logger.warn('换后端前落盘会话失败:', err));
    };
  }

  /**
   * 从 memory 元数据加载持久化会话列表，加载完成后以它为会话表与落盘目标。读表失败按 {@link LOAD_RETRY_DELAYS}
   * 有限重试，其间仍用原来的会话表与落盘目标；用尽或被中止（换人、停机）时会话表为空且不落盘。
   */
  private async load(instance: MemoryService, signal: AbortSignal): Promise<void> {
    let sessions: Map<string, SessionInfo> | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const entries = await instance.listMetadata(METADATA_NAMESPACE);
        sessions = new Map();
        for (const { key, data } of entries) {
          const info = data as unknown as SessionInfo;
          if (info && info.id === key) sessions.set(key, { ...info, ...describeSession(key, info.parentId) });
        }
        break;
      } catch (err) {
        const delay = LOAD_RETRY_DELAYS[attempt];
        if (delay !== undefined && !signal.aborted) {
          this.caps.logger.warn(`加载会话数据失败，${delay}ms 后重试:`, err);
          await wait(delay, signal);
          if (!signal.aborted) continue;
        }
        if (signal.aborted) this.caps.logger.info('已中止加载会话数据（停用、停机或换后端）');
        else this.caps.logger.error('加载会话数据失败，在这个后端上的会话改动不落盘（以免覆盖原有记录）:', err);
        break;
      }
    }
    // 加载窗口里旧表的改动：落盘目标此前仍是旧实例，换表前取快照，换表后写回
    const previous = this.store;
    const pending = previous && this.dirty ? this.snapshot().ops : undefined;
    this.sessions = sessions ?? new Map();
    this.deleted.clear();
    this.dirty = false;
    this.store = sessions ? instance : undefined;
    if (sessions) this.caps.logger.info(`已加载 ${sessions.size} 个会话`);
    if (previous && pending)
      await previous.commitMetadata(pending).catch(err => this.caps.logger.warn('换后端时写回旧后端失败:', err));
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
   * 而是**幂等 + 可重试**：每次写的是全量快照（不是增量），删除只针对墓碑；失败时 dirty 复位、
   * 墓碑保留，下一次 markDirty 会把完整状态重写一遍，前一次的半成品被整体覆盖。
   */
  async persist(): Promise<void> {
    const target = this.store;
    if (!this.dirty || !target) return;
    this.dirty = false;

    const { ops, tombstones } = this.snapshot();
    try {
      // 写入目标取落盘开始时的会话表所在实例：换人窗口里当前胜者可能已是新后端，旧表不能写过去
      await target.commitMetadata(ops);
      for (const [key, token] of tombstones) if (this.deleted.get(key) === token) this.deleted.delete(key);
    } catch (err) {
      this.dirty = true; // 失败要能重试，否则这批变更永远落不了盘
      throw err;
    }
  }

  /** 会话表的全量快照：每个会话一条 put，墓碑各一条 del */
  private snapshot(): { ops: MetadataOp[]; tombstones: Array<[string, symbol]> } {
    const ops: MetadataOp[] = [...this.sessions].map(([id, info]) => ({
      op: 'put',
      namespace: METADATA_NAMESPACE,
      key: id,
      data: info as unknown as Record<string, unknown>,
    }));
    const tombstones = [...this.deleted];
    for (const [key] of tombstones) {
      if (!this.sessions.has(key)) ops.push({ op: 'del', namespace: METADATA_NAMESPACE, key });
    }
    return { ops, tombstones };
  }

  /**
   * 按精确 id 幂等 upsert：命中走 updateSession（合并 config + emit `session:updated`），
   * 未命中以传入 id 建记录（emit `session:created`），状态缺省按有没有回合在跑：有为 active（回合结束时收口），
   * 没有为 waiting（指令回复等回合之外的出站不改状态，建成 active 就会一直停在进行中）。
   * 平台派生 sessionId（onebot 等）首次落配置覆盖时用——那些 id 不经 createSession 预建。
   */
  async ensureSession(
    id: string,
    patch: SessionUpdates & Pick<NewSessionFields, 'createdBy'> = {},
  ): Promise<SessionInfo> {
    if (this.sessions.has(id)) {
      // updateSession 不接受 createdBy（建档专用），命中路径剥离后转发
      const { createdBy: _ignore, ...updates } = patch;
      return this.updateSession(id, updates);
    }
    const config = this.checkedConfig(patch.config);
    const now = Date.now();
    const session: SessionInfo = {
      id,
      name:
        patch.name ||
        `会话 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      title: patch.metadata?.title as string | undefined,
      parentId: undefined,
      children: [],
      status: patch.status || (this.hasTurnInFlight(id) ? 'active' : 'waiting'),
      config,
      createdAt: now,
      updatedAt: now,
      createdBy: patch.createdBy || 'user',
      inputContext: patch.metadata?.inputContext as string | undefined,
      metadata: patch.metadata,
      ...describeSession(id, undefined),
    };
    this.sessions.set(id, session);
    this.markDirty();
    await this.caps.events.emit('session:created', session);
    this.caps.logger.info(`会话建档(ensure): ${session.name} (${id})`);
    await this.recordOriginInstance(session);
    return session;
  }

  /**
   * 有出生平台的房间还没记下接管它的适配器实例时，解析并记下，会话列表按它分组；已记下的不改，子任务与 owner 面
   * 会话不记。建档与真人入站调用它：建档时没有适配器认领（适配器没装好、连接还没上来、账号暂时
   * 不属于任何实例）的房间与读表读进来的旧房间，下一次有消息进来时补记。建档时记录先建好再解析：解析是异步的，
   * 先占住 id，等待期间别的建档调用走合并更新，不会重复建档。解析期间会话被删除或换表的不再写回。不会拒绝。
   */
  async recordOriginInstance(session: SessionInfo): Promise<void> {
    if (session.kind !== 'room' || session.originInstance || this.resolving.has(session)) return;
    this.resolving.add(session);
    try {
      const entry = await resolvePlatformBySession(this.caps.platform, session.id, this.caps.logger);
      if (!entry || this.sessions.get(session.id) !== session) return;
      session.originInstance = entry.contextId;
      this.markDirty();
      await this.caps.events.emit('session:updated', session);
    } finally {
      this.resolving.delete(session);
    }
  }

  // ---- CRUD ----

  async createSession(opts?: NewSessionFields): Promise<SessionInfo> {
    const config = this.checkedConfig(opts?.config);
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
      config,
      createdAt: now,
      updatedAt: now,
      createdBy: opts?.createdBy || 'user',
      inputContext: opts?.inputContext ?? (opts?.metadata?.inputContext as string | undefined),
      metadata: opts?.metadata,
      ...describeSession(id, opts?.parentId),
    };

    this.sessions.set(id, session);

    // 挂到父会话的 children 下：父会话的子会话列表变了，建档之后再给它发一次 session:updated
    const parent = session.parentId ? this.sessions.get(session.parentId) : undefined;
    if (parent) {
      parent.children.push(id);
      parent.updatedAt = now;
    }

    this.markDirty();
    await this.caps.events.emit('session:created', session);
    if (parent) await this.caps.events.emit('session:updated', parent);
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

  async updateSession(id: string, updates: SessionUpdates): Promise<SessionInfo> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    // 先校验再动记录：配置被拒时什么都不改
    const config = updates.config && checkPatch(this.settings, updates.config);

    if (updates.name !== undefined) session.name = updates.name;
    if (updates.status !== undefined) session.status = updates.status;
    if (updates.metadata !== undefined) session.metadata = { ...session.metadata, ...updates.metadata };
    if (config) session.config = applyPatch(session.config, config);
    session.updatedAt = Date.now();

    this.markDirty();
    await this.caps.events.emit('session:updated', session);
    if (config) await this.caps.events.emit('session:config:changed');
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    // 递归删除所有子会话（含活跃子会话）
    for (const childId of [...session.children]) {
      await this.deleteSession(childId);
    }

    // 从父会话的 children 中移除：父会话的子会话列表变了，删除之后再给它发一次 session:updated
    const parent = session.parentId ? this.sessions.get(session.parentId) : undefined;
    if (parent) {
      parent.children = parent.children.filter(c => c !== id);
      parent.updatedAt = Date.now();
    }

    this.sessions.delete(id);
    this.deleted.set(id, Symbol(id));

    await this.clearDeletedSessionData(id);

    this.markDirty();
    await this.caps.events.emit('session:deleted', id);
    if (parent) await this.caps.events.emit('session:updated', parent);
    this.caps.logger.info(`会话删除: ${session.name} (${id})`);
  }

  private async clearDeletedSessionData(id: string): Promise<void> {
    const clearData: HookContextMap['memory:clear'] = {
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

  async createChildSession(parentId: string, opts?: Omit<NewSessionFields, 'parentId'>): Promise<SessionInfo> {
    // 平台派生会话（cli-default、OneBot 会话 id）从不经 createSession 预建，父档缺失是常态；
    // 先兜底建档再挂子会话，否则 create_subtask 在这些平台必败。有出生平台的房间以 id 为名：带 source 的
    // 注入回合开子任务时房间还没收录，名字留给出生平台之后的真人入站按「现名等于 id」补上群名或昵称。
    if (!this.sessions.has(parentId)) {
      await this.ensureSession(parentId, resolveSessionOrigin(parentId) ? { name: parentId } : {});
    }

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

  // ---- 会话设置 ----

  registerSetting(setting: SessionSetting, plugin: string): () => void {
    return this.settings.register(setting, plugin);
  }

  listSettings(): RegisteredSessionSetting[] {
    return this.settings.list();
  }

  /**
   * 解析指定会话的最终生效配置
   *
   * 合并优先级（从高到低）：
   * 1. 会话自身 config
   * 2. 父会话的 sessionDefaults（旧数据）
   * 3. 受众条目与平台档（房间会话按出生平台，见 {@link resolveInheritance}）
   * 4. 全局默认（最低）
   */
  resolveConfig(sessionId: string, platform?: string): SessionConfig {
    return { ...this.resolveInheritance(sessionId, platform).values, ...this.getOwnConfig(sessionId) };
  }

  /**
   * 继承链解析：不含 session 自身 config，只算全局默认 + 平台档 + 受众条目 + 父 sessionDefaults，另记下每个键来自哪一层。
   * 房间会话钉死出生平台：不论从哪个入口驱动都按房间自己的平台档，并按房间的受众叠加受众条目；
   * 传入的入口平台只对没有出生平台的会话起作用，这类会话不取受众条目。
   */
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance {
    const origin = resolveSessionOrigin(sessionId);
    const pinned = origin?.platform ?? platform;
    const parts = this.layerChain(this.layers(), pinned, origin?.audience);
    const session = this.sessions.get(sessionId);
    const parent = session?.parentId ? this.sessions.get(session.parentId) : undefined;
    if (parent) parts.push([parent.config.sessionDefaults, 'parent', `会话 ${parent.id} 给子会话的默认值`]);
    return { platform: pinned, audience: origin?.audience, ...this.stack(parts) };
  }

  getOwnConfig(sessionId: string): SessionConfig {
    return this.valid(this.sessions.get(sessionId)?.config, `会话 ${sessionId} `);
  }

  childConfig(parentId: string, platform?: string): SessionConfig {
    const config = this.resolveConfig(parentId, platform) as SettingValues;
    for (const setting of this.settings.list()) if (setting.liveOnly) delete config[setting.key];
    return config;
  }

  listLayers(): SessionConfigLayer[] {
    return listLayers(this.layers());
  }

  getLayer(layer: SessionConfigLayer): SessionConfig {
    return this.valid(rawLayer(this.layers(), layer), describeLayer(layer));
  }

  resolveLayer(layer: SessionConfigLayer): Pick<SessionInheritance, 'values' | 'sources'> {
    const platform = layer.scope === 'defaults' ? undefined : layer.platform;
    return this.stack(
      this.layerChain(this.layers(), platform, layer.scope === 'audience' ? layer.audience : undefined),
    );
  }

  async updateLayer(layer: SessionConfigLayer, patch: SessionConfigPatch): Promise<void> {
    assertLayer(layer);
    const host = this.caps.hostConfig.current;
    if (!host) throw new Error('宿主没有提供配置文档（host-config），会话设置的各层无处保存');
    const checked = checkPatch(this.settings, patch);
    const layers = this.layers();
    const previous = host.get('sessionConfig');
    host.set('sessionConfig', writeLayer(layers, layer, applyPatch(rawLayer(layers, layer), checked)));
    try {
      await host.save();
    } catch (err) {
      // 拒写与写入失败都撤回：免得下一次任意保存把这次没存下的修改写进文件
      host.set('sessionConfig', previous);
      throw err;
    }
    void this.caps.events.emit('session:config:changed');
  }

  /** 宿主配置文档里的各层；没有文档时为空 */
  private layers(): Layers {
    return readLayers(this.caps.hostConfig.current?.get('sessionConfig'), message => this.warnOnce(message));
  }

  /** 全局默认 → 平台档 → 受众条目：给了平台才有平台档，再给了受众才有受众条目 */
  private layerChain(
    layers: Layers,
    platform: string | undefined,
    audience: 'group' | 'private' | undefined,
  ): Array<[values: object | undefined, source: InheritanceSource, where: string]> {
    const parts: Array<[object | undefined, InheritanceSource, string]> = [[layers.defaults, 'defaults', '全局默认']];
    if (platform === undefined) return parts;
    parts.push([layers.platforms.get(platform), 'platform', describeLayer({ scope: 'platform', platform })]);
    if (audience) {
      parts.push([
        layers.audiences.get(platform)?.[audience],
        'audience',
        describeLayer({ scope: 'audience', platform, audience }),
      ]);
    }
    return parts;
  }

  /** 按顺序叠加几处设置：后面的覆盖前面的，逐键记下来源 */
  private stack(
    parts: Array<[values: object | undefined, source: InheritanceSource, where: string]>,
  ): Pick<SessionInheritance, 'values' | 'sources'> {
    const values: SettingValues = {};
    const sources: Record<string, InheritanceSource> = {};
    for (const [raw, source, where] of parts) {
      for (const [key, value] of Object.entries(this.valid(raw, where))) {
        values[key] = value;
        sources[key] = source;
      }
    }
    return { values, sources };
  }

  /**
   * 一处设置里已登记的项：没登记的不参与解析；取值不合登记字段的当作没设置，字段标了 onInvalid: 'error' 的原样交出、
   * 由登记它的插件按拒绝处理。取值不合的同一处同一项只告警一次
   */
  private valid(values: object | undefined, where: string): SettingValues {
    const out: SettingValues = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      // 清掉的覆盖经 BSON 落盘读回来是 null，与没有同义
      if (value === undefined || value === null) continue;
      const setting = this.settings.get(key);
      if (!setting) continue;
      const read = readSetting(setting, value);
      if (!('invalid' in read)) {
        if (read.value !== undefined) out[key] = read.value;
      } else if (setting.field.onInvalid === 'error') {
        this.warnOnce(`${where}的设置项 ${key} 取值无效（${read.invalid}），原样交给登记它的插件按拒绝处理`);
        out[key] = value;
      } else {
        this.warnOnce(`${where}的设置项 ${key} 取值无效（${read.invalid}），按没设置处理`);
      }
    }
    return out;
  }

  /** 建会话时给的配置：校验后作为会话自己的覆盖 */
  private checkedConfig(config: SessionConfigPatch | undefined): SettingValues {
    return config ? applyPatch({}, checkPatch(this.settings, config)) : {};
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.caps.logger.warn(message);
  }

  private hasTurnInFlight(sessionId: string): boolean {
    for (const turn of this.turns.values()) if (turn.sessionId === sessionId) return true;
    return false;
  }

  /** 回合开始：登记这一轮；已有记录且不是 active 的翻 active（归档的也翻：她在那里跑一轮就是进行中） */
  beginTurn(id: string, turnId: string): void {
    this.turns.set(turnId, { sessionId: id });
    const session = this.sessions.get(id);
    if (session && session.status !== 'active') this.updateSession(id, { status: 'active' }).catch(() => {});
  }

  /** 记下这一轮的结局，回合结束时用 */
  recordOutcome(turnId: string, outcome: TurnOutcome): void {
    const turn = this.turns.get(turnId);
    if (turn) turn.outcome = outcome;
  }

  /**
   * 回合结束：注销这一轮。结局为 replied 的记下她开口的时间；会话里的最后一轮结束时，仍为 active 的根会话按这一轮的
   * 结局收口，出错为 error，其余（含被拦下、没有结局的一轮）为 completed。子会话由 plugin-subtask 收口
   */
  endTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    const session = this.sessions.get(turn.sessionId);
    if (!session) return;
    const settle = session.status === 'active' && !session.parentId && !this.hasTurnInFlight(session.id);
    if (turn.outcome !== 'replied' && !settle) return;
    if (turn.outcome === 'replied') session.lastReplyAt = Date.now();
    const status = turn.outcome === 'error' ? 'error' : 'completed';
    this.updateSession(session.id, settle ? { status } : {}).catch(() => {});
  }

  /**
   * 关停收尾：仍 `active` 的会话立即收口并落盘。
   *
   * 枚举没有 interrupted：回合结束（含用户停止 / abort）既有收口就是 `completed`，
   * 关停打断在飞回合与那条路径同义，沿用同一状态，不新造值。
   * waiting / completed / error / archived 不是在飞，原样保留。
   *
   * 第一方栈由 core 关停编排（optional 环成员先全部 drain）与回合结束时的收口（{@link endTurn}）处理；
   * 此处兜的是未装 agent 或钩子未挂上的路径。
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
 * 会话的种类、出生平台与受众，只由 id 与 parentId 推出。新建、建档与加载入表时覆盖写入，调用方传的值与存储里的
 * 旧值都不采信；三个键都带上（没有的为 undefined），才盖得掉旧值。
 */
function describeSession(
  id: string,
  parentId: string | undefined,
): Pick<SessionInfo, 'kind' | 'originPlatform' | 'audience'> {
  const origin = resolveSessionOrigin(id);
  const audience = parentId ? undefined : (origin?.audience ?? 'owner');
  return { kind: sessionKind({ parentId, audience }), originPlatform: origin?.platform, audience };
}

/** 一层在日志里的称呼 */
function describeLayer(layer: SessionConfigLayer): string {
  if (layer.scope === 'defaults') return '全局默认';
  if (layer.scope === 'platform') return `平台档 ${layer.platform} `;
  return `平台档 ${layer.platform} 的${AUDIENCE_NAMES[layer.audience]}条目`;
}

// ===== 插件入口 =====

const uses = {
  /** 会话档案与消息历史的唯一落点：没有 memory 就没有会话管理 */
  memory,
  /**
   * 本插件不调用 agent 的方法；声明它是为了 agent:* 钩子的键类型。
   * 第一方栈由 core 关停编排（optional 环成员先全部 drain）与回合结束时的收口处理；
   * 此处 onDrain 兜的是未装 agent 或钩子未挂上的路径。
   */
  agent: optional(agent),
  /** 自动标题的模型来源；没有 LLM 时退回用户消息首段 */
  llm: optional(llm),
  /** 解析接管房间的适配器实例（originInstance），判断会话 id 前缀是不是已注册的平台名 */
  platform: optional(platform),
  /**
   * 会话设置的全局默认、平台档与受众条目存放在宿主配置文档的 sessionConfig 字段里。由宿主在根上提供、没有插件
   * provide 它，写进激活闸只会挂一条解析不到提供者的告警；缺席时各层为空、按层写被拒
   */
  hostConfig: optional(hostConfig),
  events,
  hooks,
  lifecycle,
  logger,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-session-manager',
  displayName: '会话管理',
  subsystem: 'session',
  provides: [sessionManager],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { memory, events, hooks, lifecycle, logger, provide } = caps;

  if (memory.current === undefined) {
    logger.error('memory 服务不可用，会话管理无法启动');
    return;
  }

  const manager = new SessionManager(caps);

  // 会话表跟随 memory 胜者：首次挂接即加载；运行中胜者换人时先写回旧后端再读新后端
  memory.follow(instance => manager.attach(instance));
  await manager.loading;
  // 读表（含重试等待）期间停用或停机的，不再发布服务与登记
  lifecycle.signal.throwIfAborted();

  // 注册服务
  provide(sessionManager, manager, { label: '会话管理' });

  // ===== IM 房间收录 =====
  // 有出生平台、不是子任务的会话，首条真人入站（不带 source，触发判定之前）即登记。带 source 的是内部注入
  //（工作流、定时任务、空闲开话题、宿主通知、好友申请与入群邀请的合成通知），不登记。
  // 名字只采信出生平台自己的入站：群取群名、私聊取对方昵称，缺省用 id（从 WebUI 插话时消息带的是 owner 的昵称；
  // 群的首条入站可能是不带群名的戳一戳，不回退到昵称）。现名还是 id 时由后到的原生入站补上，起过的名字不动。
  // 已登记、还没记下所属实例的房间，每条真人入站都再解析一次，认领到就补记。
  const warnedPrefixes = new Set<string>();
  events.on('inbound:message', (msg: IncomingMessage) => {
    const { sessionId } = msg;
    if (!sessionId || msg.source || sessionId.includes('::')) return;
    const origin = resolveSessionOrigin(sessionId);
    if (!origin) return;
    // 原生入站的前缀既不是发来消息的平台、也不是已注册的平台名：多半是适配器的 id 前缀与平台名不一致，这个前缀的
    // 房间全部按一份不存在的平台档选档、落到全局默认。每个前缀告警一次。WebUI、CLI 往房间插话不在此列：
    // 房间的适配器停用或还没加载时，它的平台名同样不在已注册之列
    if (
      origin.platform !== msg.platform &&
      !OWNER_ENTRY_PLATFORMS.has(msg.platform) &&
      !warnedPrefixes.has(origin.platform) &&
      !getPlatformNames(caps.platform).includes(origin.platform)
    ) {
      warnedPrefixes.add(origin.platform);
      logger.warn(
        `会话 id 前缀「${origin.platform}」不是已注册的平台名，消息经平台「${msg.platform}」发来（${sessionId}）：` +
          `这个前缀的房间按平台档「${origin.platform}」选档，没有这份档就落到全局默认。多人房间的会话 id 须以适配器自己的平台名加冒号开头`,
      );
    }
    const nativeName =
      msg.platform === origin.platform ? (origin.audience === 'group' ? msg.groupName : msg.nickname) : undefined;
    const session = manager.getSession(sessionId);
    if (!session) {
      manager
        .ensureSession(sessionId, { name: nativeName || sessionId, createdBy: 'system', status: 'waiting' })
        .catch(err => logger.warn(`IM 房间登记失败 (${sessionId}):`, err));
      return;
    }
    if (nativeName && session.name === sessionId) {
      manager.updateSession(sessionId, { name: nativeName }).catch(() => {});
    }
    void manager.recordOriginInstance(session);
  });

  // ===== 会话状态 =====
  // 回合真正开始时（agent:input:before）才翻 active：群里只有消息、她没开口的房间不显示「进行中」
  //（触发判定在入站相位，挡下的消息到不了这里）。同一个中间件在 finally 里收口根会话，这是唯一的收口：next() 返回时
  // 整轮已跑完、agent:turn:after 也已执行（agent 只在这个钩子的默认动作里发它），结局已经记下；后面的中间件不调 next()
  // 或抛错时 agent 不发回合收尾，同样由这里兜住。按回合 id 登记在飞的回合，会话里最后一轮结束才收口，别的 lane 还在跑时
  // 不显示已完成；回合中途的出站（send_attachment、paper_send 在工具执行中直接发）不收口。子会话由 plugin-subtask 收口。
  hooks.middleware('agent:input:before', async (data, next) => {
    manager.beginTurn(data.message.sessionId, data.turnId);
    try {
      await next();
    } finally {
      manager.endTurn(data.turnId);
    }
  });
  hooks.middleware('agent:turn:after', async (data, next) => {
    manager.recordOutcome(data.turnId, data.outcome);
    await next();
  });

  // 监听用户消息事件 → 自动生成会话标题
  // 在用户首次发消息时即生成标题，无需等待 AI 回复
  // 仅对 webui / cli 等用户交互平台生效，onebot 等外部平台不生成标题；从 WebUI 往 IM 房间插话同样不生成
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
    if (!platform || !OWNER_ENTRY_PLATFORMS.has(platform)) return;
    // 有出生平台的是 IM 房间：不拿 owner 插的话给房间起名，也不经这里建档
    if (resolveSessionOrigin(sessionId)) return;
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

  // 关停收尾：仍 active 的会话在 onDrain 收口并落盘。
  // 第一方栈由 core 关停编排（optional 环成员先全部 drain）与回合结束时的收口处理；
  // 此处兜的是未装 agent 或钩子未挂上的路径。
  // 持久化仍走 onDispose：覆盖 bounce / unload / updateConfig 等全部拆卸路径
  // （只在全局停机触发的话，热重载即丢会话元数据）。
  // 异步收尾由编排层的 disposeAsync 等待完成；app.stop() 的拓扑逆序保证此时 memory 提供者
  // 尚未关闭，单独热重载/禁用 memory 提供者时无此保证。shutdown() 幂等：清 timer + 置 dirty + 落盘。
  lifecycle.onDrain(() => manager.settleActiveOnDrain(), '收口在飞会话');
  lifecycle.onDispose(() => manager.shutdown());

  logger.info('会话管理服务已启用');
}
