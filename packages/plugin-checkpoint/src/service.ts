import type { Logger } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { StorageService } from '@aalis/plugin-storage-api';

/**
 * Checkpoint 服务
 *
 * 在 LLM 一次回合（assistant turn）期间记录所有受控存储中的写入/删除/重命名操作，
 * 在改动发生前自动备份原始文件内容，使用户可以从 WebUI 一键回滚整轮操作。
 *
 * 协作模型：
 * - plugin-storage-local 在执行 writeFile/delete/rename 之前，通过
 *   `ctx.getService<CheckpointService>('checkpoint')?.beforeMutate(...)` 探测本服务。
 * - 本服务通过 hooks `agent:input:before` / `agent:turn:after` 维护「当前回合」状态。
 * - exec 工具直接调用系统命令，不在本服务保护范围内（前端 UI 标注「未保护」）。
 */
export interface CheckpointService {
  /** 探测：是否在某个回合内（storage-local 提早判断以避免无谓 stat） */
  isActive(): boolean;
  /**
   * 在 storage 即将修改 uri 时调用。本调用是 op="write"|"delete"|"rename" 之前的一次性快照机会。
   * 如果同一 uri 在当前回合内已被快照过，则跳过（保留最早的原始内容）。
   * loadOriginal 是按需读取原始内容的闭包；首次需要快照时才调用。
   */
  beforeMutate(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    loadOriginal: () => Promise<{ data: Buffer; size: number } | null>,
  ): Promise<void>;
  /** 列出某个 session 的所有回合 checkpoint */
  listTurns(sessionId: string): Promise<TurnSummary[]>;
  /** 读取某回合 manifest */
  getManifest(sessionId: string, turnId: string): Promise<TurnManifest | null>;
  /** 回滚某回合（恢复 / 删除 / 重命名复原）。返回受影响文件计数 */
  rollback(sessionId: string, turnId: string): Promise<RollbackResult>;
  /** 回滚某回合并同步删除本轮对话消息与向量条目 */
  rollbackWithChat(sessionId: string, turnId: string): Promise<RollbackWithChatResult>;
  /** 清除某会话的所有 checkpoint（/clear 与 deleteSession 调用）。幂等；不存在也返回 0。 */
  clearSession(sessionId: string): Promise<number>;
  /** 清除全部 checkpoint（/clear all 调用）。幂等。 */
  clearAll(): Promise<number>;
}

export interface CheckpointFileRecord {
  uri: string;
  /** write=覆盖已有, write-new=新创建, delete=删除, rename=重命名 */
  action: 'write' | 'write-new' | 'delete' | 'rename';
  /** 原始大小（如果有快照） */
  originalSize?: number;
  /** 备份 blob 文件名（相对于 turn 目录） */
  blob?: string;
  /** 跳过原因（过大、读取失败等） */
  skipped?: string;
}

export interface TurnManifest {
  turnId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  files: CheckpointFileRecord[];
  /** 本轮对话内消息的时间戳，用于 rollbackWithChat 精确删除消息与向量条目 */
  messageTimestamps?: number[];
}

export interface TurnSummary {
  turnId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  fileCount: number;
  /** 是否在 turn 内调用过 exec 工具（前端用于显示「部分未保护」） */
  execUsed?: boolean;
  /** 摘要预览（前 3 个文件 URI） */
  filesPreview: string[];
}

export interface RollbackResult {
  ok: boolean;
  restored: string[];
  deleted: string[];
  errors: Array<{ uri: string; reason: string }>;
}

export interface RollbackWithChatResult extends RollbackResult {
  /** 实际从 memory 中删除的消息条数 */
  deletedMessages: number;
  /** chat 删除是否成功；若失败，errors 也会记录原因 */
  chatDeleted: boolean;
}

interface ServiceConfig {
  rootUri: string;
  maxFileSize: number;
  keepSessions: number;
  scopes: string[];
}

/**
 * 实现
 */
export class CheckpointServiceImpl implements CheckpointService {
  private current: TurnManifest | null = null;
  /** 当前回合内已快照过的 uri 集合（用于去重） */
  private snapshotted: Set<string> = new Set();
  /** 文件计数器，用于命名 blob 文件 */
  private blobIndex = 0;

  constructor(
    private readonly cfg: ServiceConfig,
    private readonly logger: Logger,
    private readonly storage: StorageService,
  ) {}

  // ──────────── 生命周期 ────────────

  beginTurn(sessionId: string): string {
    // 如果上一回合没有正常结束，先把它 commit 掉避免遗失
    if (this.current) {
      this.endTurn().catch(err => this.logger.warn(`finalize 旧回合失败: ${(err as Error).message}`));
    }
    const turnId = crypto.randomUUID();
    this.current = {
      turnId,
      sessionId,
      startedAt: Date.now(),
      files: [],
    };
    this.snapshotted = new Set();
    this.blobIndex = 0;
    this.logger.debug(`checkpoint 回合开始 ${sessionId} turn=${turnId}`);
    return turnId;
  }

  async endTurn(): Promise<void> {
    if (!this.current) return;
    this.current.endedAt = Date.now();
    // 在持久化前抓取本轮对话的消息时间戳（供 rollbackWithChat 使用）
    // 即使本轮无文件改动，只要有消息就会持久化 manifest
    if (this._memory && typeof this._memory.getMessagesBySessionRange === 'function') {
      try {
        // 宽松边界 200ms，用于容纳 archiveIncoming/saveMessage 时钟偏差
        const msgs = await this._memory.getMessagesBySessionRange(
          this.current.sessionId,
          this.current.startedAt - 200,
          this.current.endedAt + 200,
        );
        this.current.messageTimestamps = msgs.map(m => m.timestamp).filter((t): t is number => typeof t === 'number');
      } catch (err) {
        this.logger.warn(`抓取本轮消息时间戳失败: ${(err as Error).message}`);
      }
    }
    // 若整个回合没有任何文件改动且没有任何消息时间戳，跳过持久化
    if (
      this.current.files.length === 0 &&
      (!this.current.messageTimestamps || this.current.messageTimestamps.length === 0)
    ) {
      this.logger.debug(`checkpoint 回合无改动，跳过 ${this.current.turnId}`);
      this.current = null;
      return;
    }
    const turnDir = this.turnDir(this.current.sessionId, this.current.turnId);
    await this.storage.writeFile(joinUri(turnDir, 'manifest.json'), JSON.stringify(this.current, null, 2));
    this.logger.info(`checkpoint 回合提交 turn=${this.current.turnId} 文件数=${this.current.files.length}`);
    this.current = null;
    this.gc().catch(err => this.logger.warn(`checkpoint GC 失败: ${(err as Error).message}`));
  }

  /** 标记当前回合调用过 exec，UI 端会提示「部分未保护」 */
  markExecUsed(): void {
    if (!this.current) return;
    (this.current as TurnManifest & { execUsed?: boolean }).execUsed = true;
  }

  // ──────────── beforeMutate ────────────

  isActive(): boolean {
    return this.current !== null;
  }

  async beforeMutate(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    loadOriginal: () => Promise<{ data: Buffer; size: number } | null>,
  ): Promise<void> {
    if (!this.current) return; // 回合外，忽略
    if (this.snapshotted.has(uri)) return; // 同回合已快照过
    this.snapshotted.add(uri);

    let original: { data: Buffer; size: number } | null = null;
    try {
      original = await loadOriginal();
    } catch (err) {
      this.logger.warn(`checkpoint 加载原文件失败 ${uri}: ${(err as Error).message}`);
    }

    // 情况 1：write 且原文件不存在 → 标记为新创建（回滚时需要删除）
    if (!original && op === 'write') {
      this.current.files.push({ uri, action: 'write-new' });
      return;
    }

    // 情况 2：原文件不存在但是 delete/rename → 不可能，跳过
    if (!original) return;

    // 情况 3：过大 → 跳过快照但记录为「skipped」
    if (original.size > this.cfg.maxFileSize) {
      this.current.files.push({
        uri,
        action: op === 'rename' ? 'rename' : op,
        originalSize: original.size,
        skipped: `文件过大 (${original.size} > ${this.cfg.maxFileSize})`,
      });
      return;
    }

    // 情况 4：正常快照
    const blobName = `${this.blobIndex++}.bin`;
    const turnDir = this.turnDir(this.current.sessionId, this.current.turnId);
    await this.storage.writeFile(joinUri(turnDir, `blobs/${blobName}`), original.data);

    this.current.files.push({
      uri,
      action: op === 'rename' ? 'rename' : op,
      originalSize: original.size,
      blob: blobName,
    });
  }

  // ──────────── 查询 ────────────

  async listTurns(sessionId: string): Promise<TurnSummary[]> {
    const sessionDir = joinUri(this.cfg.rootUri, encodeSegment(sessionId));
    let entries: string[];
    try {
      const listed = await this.storage.list(sessionDir);
      entries = listed.entries.filter(e => e.isDirectory).map(e => e.name);
    } catch {
      return [];
    }
    const summaries: TurnSummary[] = [];
    for (const turnId of entries) {
      const manifest = await this.getManifest(sessionId, turnId);
      if (!manifest) continue;
      summaries.push({
        turnId: manifest.turnId,
        sessionId: manifest.sessionId,
        startedAt: manifest.startedAt,
        endedAt: manifest.endedAt,
        fileCount: manifest.files.length,
        execUsed: (manifest as TurnManifest & { execUsed?: boolean }).execUsed,
        filesPreview: manifest.files.slice(0, 3).map(f => f.uri),
      });
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries;
  }

  async getManifest(sessionId: string, turnId: string): Promise<TurnManifest | null> {
    const uri = joinUri(this.turnDir(sessionId, turnId), 'manifest.json');
    try {
      const raw = await this.storage.readFile(uri, 'utf-8');
      return JSON.parse(String(raw)) as TurnManifest;
    } catch {
      return null;
    }
  }

  // ──────────── 回滚 ────────────

  async rollback(sessionId: string, turnId: string): Promise<RollbackResult> {
    const manifest = await this.getManifest(sessionId, turnId);
    if (!manifest) {
      return { ok: false, restored: [], deleted: [], errors: [{ uri: '', reason: 'checkpoint 不存在' }] };
    }
    // 通过 storage service 来执行回滚操作，避免直接绕过权限
    // 此处通过模块外部注入 writeBack/deleteBack 函数
    const result: RollbackResult = { ok: true, restored: [], deleted: [], errors: [] };
    if (!this._backendWrite || !this._backendDelete) {
      return { ok: false, restored: [], deleted: [], errors: [{ uri: '', reason: '回滚后端未注入' }] };
    }
    const turnDir = this.turnDir(sessionId, turnId);

    for (const file of manifest.files) {
      try {
        if (file.action === 'write-new') {
          // 新创建的文件 → 删除
          await this._backendDelete(file.uri);
          result.deleted.push(file.uri);
        } else if (file.skipped) {
          // 跳过快照的，无法恢复
          result.errors.push({ uri: file.uri, reason: file.skipped });
        } else if (file.blob) {
          const data = await this.storage.readFile(joinUri(turnDir, `blobs/${file.blob}`));
          await this._backendWrite(file.uri, Buffer.from(data as Uint8Array));
          result.restored.push(file.uri);
        }
      } catch (err) {
        result.errors.push({ uri: file.uri, reason: (err as Error).message });
      }
    }
    if (result.errors.length > 0) result.ok = false;
    return result;
  }

  // ──────────── 回滚后端注入 ────────────
  private _backendWrite?: (uri: string, data: Buffer) => Promise<void>;
  private _backendDelete?: (uri: string) => Promise<void>;
  private _memory?: MemoryService;
  private _emitMessagesDeleted?: (sessionId: string, timestamps: number[]) => void;
  private _emitHistoryChanged?: (sessionId: string) => void;

  setBackend(write: (uri: string, data: Buffer) => Promise<void>, del: (uri: string) => Promise<void>): void {
    this._backendWrite = write;
    this._backendDelete = del;
  }

  /** 注入聊天回滚所需的依赖：memory 服务 + 事件发出器 */
  setChatRollbackDeps(deps: {
    memory: MemoryService;
    emitMessagesDeleted: (sessionId: string, timestamps: number[]) => void;
    emitHistoryChanged: (sessionId: string) => void;
  }): void {
    this._memory = deps.memory;
    this._emitMessagesDeleted = deps.emitMessagesDeleted;
    this._emitHistoryChanged = deps.emitHistoryChanged;
  }

  async rollbackWithChat(sessionId: string, turnId: string): Promise<RollbackWithChatResult> {
    const manifest = await this.getManifest(sessionId, turnId);
    if (!manifest) {
      return {
        ok: false,
        restored: [],
        deleted: [],
        errors: [{ uri: '', reason: 'checkpoint 不存在' }],
        deletedMessages: 0,
        chatDeleted: false,
      };
    }
    // 先执行文件回滚
    const fileResult = await this.rollback(sessionId, turnId);
    const result: RollbackWithChatResult = {
      ...fileResult,
      deletedMessages: 0,
      chatDeleted: false,
    };

    const timestamps = manifest.messageTimestamps ?? [];
    if (timestamps.length === 0) {
      // 无消息可删（例如旧 checkpoint），仅文件回滚生效
      result.chatDeleted = true;
      return result;
    }

    if (!this._memory || typeof this._memory.deleteMessagesByTimestamps !== 'function') {
      result.errors.push({ uri: '', reason: '当前 memory 后端不支持 deleteMessagesByTimestamps' });
      result.ok = false;
      return result;
    }

    try {
      result.deletedMessages = await this._memory.deleteMessagesByTimestamps(sessionId, timestamps);
      result.chatDeleted = true;
    } catch (err) {
      result.errors.push({ uri: '', reason: `删除消息失败: ${(err as Error).message}` });
      result.ok = false;
      return result;
    }

    // 通知向量插件清理同时间戳的向量条目
    try {
      this._emitMessagesDeleted?.(sessionId, timestamps);
    } catch (err) {
      this.logger.warn(`emit memory:messages-deleted 失败: ${(err as Error).message}`);
    }
    // 通知前端刷新历史
    try {
      this._emitHistoryChanged?.(sessionId);
    } catch (err) {
      this.logger.warn(`emit history:changed 失败: ${(err as Error).message}`);
    }

    return result;
  }

  // ──────────── GC ────────────

  private async gc(): Promise<void> {
    if (this.cfg.keepSessions <= 0) return;
    let sessions: Array<{ name: string; uri: string }>;
    try {
      const listed = await this.storage.list(this.cfg.rootUri);
      sessions = listed.entries.filter(e => e.isDirectory).map(e => ({ name: e.name, uri: e.uri }));
    } catch {
      return;
    }
    if (sessions.length <= this.cfg.keepSessions) return;

    // 按 session 目录的最新 mtime 排序，淘汰最旧的
    const sessionInfo: Array<{ name: string; uri: string; mtime: number }> = [];
    for (const item of sessions) {
      try {
        const s = await this.storage.stat(item.uri);
        sessionInfo.push({ name: item.name, uri: item.uri, mtime: new Date(s.mtime).getTime() || 0 });
      } catch {
        /* skip */
      }
    }
    sessionInfo.sort((a, b) => b.mtime - a.mtime);
    const toDelete = sessionInfo.slice(this.cfg.keepSessions);
    for (const item of toDelete) {
      try {
        await this.storage.delete(item.uri);
      } catch (err) {
        this.logger.warn(`GC 删除 ${item.name} 失败: ${(err as Error).message}`);
      }
    }
  }

  private turnDir(sessionId: string, turnId: string): string {
    return joinUri(this.cfg.rootUri, `${encodeSegment(sessionId)}/${encodeSegment(turnId)}`);
  }

  // ──────────── 会话级清理 ────────────
  // 与 plugin-commands / plugin-session-manager 的 memory:clear 调度对齐，
  // 避免 /clear 与 deleteSession 后 checkpoint 目录泄露。
  async clearSession(sessionId: string): Promise<number> {
    const sessionDir = joinUri(this.cfg.rootUri, encodeSegment(sessionId));
    try {
      const listed = await this.storage.list(sessionDir);
      const count = listed.entries.filter(e => e.isDirectory).length;
      await this.storage.delete(sessionDir);
      if (count > 0) this.logger.info(`checkpoint 清理 session=${sessionId} 共 ${count} 个 turn`);
      return count;
    } catch (err) {
      // 目录不存在是正常情况
      this.logger.debug(`checkpoint clearSession ${sessionId} 跳过: ${(err as Error).message}`);
      return 0;
    }
  }

  async clearAll(): Promise<number> {
    try {
      const listed = await this.storage.list(this.cfg.rootUri);
      const sessions = listed.entries.filter(e => e.isDirectory);
      for (const item of sessions) {
        try {
          await this.storage.delete(item.uri);
        } catch (err) {
          this.logger.warn(`checkpoint clearAll 删 ${item.name} 失败: ${(err as Error).message}`);
        }
      }
      if (sessions.length > 0) this.logger.info(`checkpoint 全量清理：${sessions.length} 个 session`);
      return sessions.length;
    } catch (err) {
      this.logger.debug(`checkpoint clearAll 跳过: ${(err as Error).message}`);
      return 0;
    }
  }
}

function joinUri(base: string, rel: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${rel.replace(/^\/+/, '')}`;
}

/** 文件系统路径段：把 ":" "/" "\" 等特殊字符 URL 编码 */
function encodeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, c => `_${c.charCodeAt(0).toString(16)}`);
}

export function resolveConfig(raw: Record<string, unknown>): ServiceConfig {
  const rootInput = typeof raw.rootDir === 'string' ? raw.rootDir : 'data:/checkpoints';
  const rawScopes = raw.scopes;
  const scopes: string[] = Array.isArray(rawScopes)
    ? rawScopes.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : typeof rawScopes === 'string' && rawScopes.length > 0
      ? rawScopes
          .split(/[,\s]+/)
          .map(s => s.trim())
          .filter(Boolean)
      : ['webui:*'];
  return {
    rootUri: toUri(rootInput),
    maxFileSize: typeof raw.maxFileSize === 'number' ? Math.max(1024, raw.maxFileSize) : 10 * 1024 * 1024,
    keepSessions: typeof raw.keepSessions === 'number' ? Math.max(0, Math.floor(raw.keepSessions)) : 20,
    scopes,
  };
}

function toUri(input: string): string {
  const s = String(input ?? '').trim();
  if (!s) return 'data:/checkpoints';
  if (s.includes(':/')) return s;
  const cleaned = s.replace(/^\.?\/+/, '');
  const idx = cleaned.indexOf('/');
  return idx > 0 ? `${cleaned.slice(0, idx)}:/${cleaned.slice(idx + 1)}` : `data:/${cleaned}`;
}
