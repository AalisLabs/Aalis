import type { MemoryService } from '@aalis/api-memory';
import { type StorageService, toStorageUri } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';

/** 不记账的根类型：多会话/多平台共享写入区（data、pluginData、logs）与回合结束前就清掉的临时目录（tmp）。 */
const UNPROTECTED_ROOT_KINDS: ReadonlySet<string> = new Set(['data', 'tmp', 'pluginData', 'logs']);

/**
 * Checkpoint 服务
 *
 * 在 LLM 一次回合（assistant turn）期间记录受控存储中的写入/删除/重命名操作（data / tmp / pluginData /
 * logs 这几类共享根与临时根除外，见 beforeMutate），
 * 在改动发生前自动备份原始文件内容，使用户可以从 WebUI 一键回滚整轮操作。
 *
 * 协作模型：
 * - plugin-storage-local 在执行 writeFile/delete/rename 之前，通过
 *   `ctx.getService<CheckpointService>('checkpoint')?.beforeMutate(...)` 探测本服务。
 * - 本服务通过 hooks `agent:input:before` / `agent:turn:after` 维护「当前回合」状态。
 * - exec / exec_background / run_* 等命令类工具直接调用系统命令，不在本服务保护范围内
 *   （前端 UI 标注「未保护」）。
 */
export interface CheckpointService {
  /** 探测：是否在某个回合内（storage-local 提早判断以避免无谓 stat） */
  isActive(): boolean;
  /**
   * 在 storage 即将修改 uri 时调用。本调用是 op="write"|"delete"|"rename" 之前的一次性快照机会。
   * 如果同一 uri 在当前回合内已被快照过，则不再备份内容（保留最早的原始内容）；
   * 但 op='rename' 仍会补记一条不带 blob 的条目，否则「先改写再移走」的移动会整条丢失。
   * loadOriginal 是按需读取原始内容的闭包；首次需要快照时才调用。
   * toUri 仅 op='rename' 有意义：改动后的目标 URI，回滚时据它把文件原路移回
   * （缺省则退化为「只把原内容写回源路径」，目标端会留一份重复）。
   */
  beforeMutate(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    loadOriginal: () => Promise<{ data: Buffer; size: number } | null>,
    toUri?: string,
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
  /** rename 的目标 URI（回滚时原路移回；老 manifest 无此字段） */
  toUri?: string;
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
  /** 是否在 turn 内调用过 exec / exec_background / run_* 等命令类工具（前端用于显示「部分未保护」） */
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
  /**
   * 每会话独立的活跃回合（跨会话并发互不串台）。
   * 每项含：清单 + 本回合已快照 uri 集合(去重) + blob 文件计数器。
   */
  private turns = new Map<string, { manifest: TurnManifest; snapshotted: Set<string>; blobIndex: number }>();
  /** 回滚正在处理的 URI：回滚自身的写/删/移经 storage 写前钩子回到 beforeMutate，不得记进任何活跃回合 */
  private readonly rollingBack = new Set<string>();

  constructor(
    private readonly cfg: ServiceConfig,
    private readonly logger: Logger,
    private readonly storage: StorageService,
  ) {}

  // ──────────── 生命周期 ────────────

  beginTurn(sessionId: string): string {
    // 同会话已有未结束回合（异常未 endTurn / abort 重开）→ 先提交它避免遗失（仅影响本会话，不碰其它）
    const prev = this.turns.get(sessionId);
    if (prev) {
      this.turns.delete(sessionId);
      this.commitTurn(prev).catch(err => this.logger.warn(`finalize 旧回合失败: ${(err as Error).message}`));
    }
    const turnId = crypto.randomUUID();
    this.turns.set(sessionId, {
      manifest: { turnId, sessionId, startedAt: Date.now(), files: [] },
      snapshotted: new Set(),
      blobIndex: 0,
    });
    this.logger.debug(`checkpoint 回合开始 ${sessionId} turn=${turnId}`);
    return turnId;
  }

  async endTurn(sessionId: string): Promise<void> {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    await this.commitTurn(turn);
  }

  /** 进程退出前提交所有活跃回合，避免未结束回合丢失。 */
  async flushAll(): Promise<void> {
    const active = [...this.turns.values()];
    this.turns.clear();
    for (const turn of active) {
      await this.commitTurn(turn).catch(err => this.logger.warn(`flush 回合失败: ${(err as Error).message}`));
    }
  }

  /** 提交一个回合：补 endedAt + 抓消息时间戳 + 落盘 manifest + 触发 GC。无改动则跳过。 */
  private async commitTurn(turn: {
    manifest: TurnManifest;
    snapshotted: Set<string>;
    blobIndex: number;
  }): Promise<void> {
    const m = turn.manifest;
    m.endedAt = Date.now();
    // 在持久化前抓取本轮对话的消息时间戳（供 rollbackWithChat 使用）；即使无文件改动，只要有消息就持久化
    if (this._memory && typeof this._memory.getMessagesBySessionRange === 'function') {
      try {
        // 宽松边界 200ms，用于容纳 archiveIncoming/saveMessage 时钟偏差
        const msgs = await this._memory.getMessagesBySessionRange(m.sessionId, m.startedAt - 200, m.endedAt + 200);
        m.messageTimestamps = msgs.map(msg => msg.timestamp).filter((t): t is number => typeof t === 'number');
      } catch (err) {
        this.logger.warn(`抓取本轮消息时间戳失败: ${(err as Error).message}`);
      }
    }
    if (m.files.length === 0 && (!m.messageTimestamps || m.messageTimestamps.length === 0)) {
      this.logger.debug(`checkpoint 回合无改动，跳过 ${m.turnId}`);
      return;
    }
    const turnDir = this.turnDir(m.sessionId, m.turnId);
    await this.storage.writeFile(joinUri(turnDir, 'manifest.json'), JSON.stringify(m, null, 2));
    this.logger.info(`checkpoint 回合提交 turn=${m.turnId} 文件数=${m.files.length}`);
    this.gc().catch(err => this.logger.warn(`checkpoint GC 失败: ${(err as Error).message}`));
  }

  /** 标记某会话当前回合调用过 exec / exec_background / run_* 等命令类工具，UI 端会提示「部分未保护」 */
  markExecUsed(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (turn) (turn.manifest as TurnManifest & { execUsed?: boolean }).execUsed = true;
  }

  // ──────────── beforeMutate ────────────

  isActive(): boolean {
    return this.turns.size > 0;
  }

  async beforeMutate(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    loadOriginal: () => Promise<{ data: Buffer; size: number } | null>,
    toUri?: string,
  ): Promise<void> {
    // 自身根下的写入（blob / manifest）不快照：storage 的写前钩子会把它们递归送回这里，
    // 而 blob 此刻在磁盘上尚不存在 → 会给自己记一条 write-new 假账，且排在真实条目之前，
    // 回滚时先删备份再读同一 blob → ENOENT，覆盖/删除类恢复必败。
    if (this.isOwnUri(uri)) return;
    // data / pluginData / logs 是多会话、多平台共享的写入区：既有别处落盘的附件与插件状态，也有本回合自己
    // 经工具产生的 skill / persona / 图片，storage 写入没有会话归属、无法分辨——记进本回合，回滚就会误删
    // 别人刚落盘的文件、把插件状态写回旧版，故整根不记账（这些改动不可回滚）；tmp 是回合结束前就清掉的
    // 临时目录，记账只会让回滚必报 ENOENT。其余根（workspace 与用户自建的 custom 等）照常记账。
    if (this.isUnprotectedRootUri(uri)) return;
    // 回滚自身的改动不是任何回合的改动：记进其它会话的活跃回合，那边一回滚就把这次回滚再撤掉
    if (this.rollingBack.has(uri)) return;
    // 去重按 uri，但 rename 不能因此被吞掉：同一回合里「先 write/改写 f，再把 f 移走」时，
    // f 已快照过 → 移动整条不入账 → 回滚照 write 条目去写/删源端（ENOENT），文件还留在目标端。
    // 对这些回合补记一条不带 blob 的 rename（内容已由更早的条目备份，不重复备份）：
    // LIFO 回滚先由它把目标移回源端，再由更早的 write/write-new 条目恢复原文或删除。
    const renameOnly = op === 'rename' && toUri ? [...this.turns.values()].filter(t => t.snapshotted.has(uri)) : [];
    for (const t of renameOnly) t.manifest.files.push({ uri, action: 'rename', toUri });
    // 跨会话并发：把快照记进所有「本回合尚未对该 uri 快照过」的活跃回合。单回合=常态、零变化；
    // 并发多回合无法精确判断是哪个 run 改的 → 保守地都备份（宁可冗余、不丢保护）。
    const targets = [...this.turns.values()].filter(t => !t.snapshotted.has(uri));
    if (targets.length === 0) return; // 回合外，或都已补记/快照过
    for (const t of targets) t.snapshotted.add(uri);

    let original: { data: Buffer; size: number } | null = null;
    try {
      original = await loadOriginal();
    } catch (err) {
      this.logger.warn(`checkpoint 加载原文件失败 ${uri}: ${(err as Error).message}`);
    }

    for (const t of targets) {
      // 情况 1：write 且原文件不存在 → 标记为新创建（回滚时需要删除）；
      // 情况 2：delete/rename 拿不到内容（目录，或读取失败）→ 仍要记一条：
      //   否则目录递归删除零记录，UI 却照样渲染「回滚本轮对话（含文件）」并报回滚完成。
      //   rename 有 toUri 时回滚仍能原路移回；delete 则如实标为不可回滚。
      if (!original) {
        if (op === 'write') t.manifest.files.push({ uri, action: 'write-new' });
        else t.manifest.files.push({ uri, action: op, toUri, skipped: '未快照（目录或读取失败）' });
        continue;
      }
      // 情况 3：过大 → 跳过快照但记录为「skipped」
      if (original.size > this.cfg.maxFileSize) {
        t.manifest.files.push({
          uri,
          action: op === 'rename' ? 'rename' : op,
          toUri,
          originalSize: original.size,
          skipped: `文件过大 (${original.size} > ${this.cfg.maxFileSize})`,
        });
        continue;
      }
      // 情况 4：正常快照（每个活跃回合各存一份 blob 到自己的 turn 目录）
      const blobName = `${t.blobIndex++}.bin`;
      const turnDir = this.turnDir(t.manifest.sessionId, t.manifest.turnId);
      await this.storage.writeFile(joinUri(turnDir, `blobs/${blobName}`), original.data);
      t.manifest.files.push({
        uri,
        action: op === 'rename' ? 'rename' : op,
        toUri,
        originalSize: original.size,
        blob: blobName,
      });
    }
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
      const manifest = JSON.parse(String(raw)) as TurnManifest;
      // 存量 manifest 可能带自指条目（历史递归快照）：既不是用户改动、也不该暴露内部路径，
      // 更不能让回滚去删自己的备份 —— 在唯一的读入口就滤掉，下游（listTurns / rollback）不必各自设防。
      // 不记账的根（data / tmp 等，见 beforeMutate）在升级前写下的条目同样滤掉：否则老回合的回滚照样删别处落盘的文件。
      manifest.files = (manifest.files ?? []).filter(f => !this.isOwnUri(f.uri) && !this.isUnprotectedRootUri(f.uri));
      return manifest;
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

    // 逆序撤销（LIFO）：同回合内后发生的改动先回退，否则先前条目的复原会被后来条目再次覆盖。
    // 例：`move a.txt -> b.txt` 后又改写 b.txt，正序回滚先把 b 移回 a，再把 b 的快照写回，
    // b.txt 又冒出来；逆序则先把 b 还原成改写前内容，再整体移回 a，磁盘回到回合开始的样子。
    for (const file of [...manifest.files].reverse()) {
      this.rollingBack.add(file.uri);
      if (file.toUri) this.rollingBack.add(file.toUri);
      try {
        if (file.action === 'write-new') {
          // 新创建的文件 → 删除。已不存在即期望状态已达成（本回合新建后又删掉：delete 条目被按 URI
          // 去重吞掉，只剩这条 write-new），不算失败。
          try {
            await this._backendDelete(file.uri);
            result.deleted.push(file.uri);
          } catch (delErr) {
            if (!isNotFoundError(delErr)) throw delErr;
          }
        } else if (file.action === 'rename' && file.toUri) {
          // 改名/移动 → 优先原路移回：目录与超限大文件也能复原，且不会在目标端留一份重复。
          // 移不动（目标已被占、后端不支持 move）才回落到「写回源端 + 删目标」。
          try {
            if (!this._backendMove) throw new Error('回滚 move 后端未注入');
            await this._backendMove(file.toUri, file.uri);
            result.restored.push(file.uri);
          } catch (moveErr) {
            if (!file.blob) throw moveErr;
            const data = await this.storage.readFile(joinUri(turnDir, `blobs/${file.blob}`));
            await this._backendWrite(file.uri, Buffer.from(data as Uint8Array));
            result.restored.push(file.uri);
            // 源端复原即算成功；删目标是善后动作，单独 try：目标已不在（ENOENT——重复回滚、
            // 别处已清）就是期望状态，才忽略；其它失败（权限被拒等）如实入 errors，也不谎报 deleted。
            try {
              await this._backendDelete(file.toUri);
              result.deleted.push(file.toUri);
            } catch (delErr) {
              const reason = (delErr as Error).message ?? String(delErr);
              if (isNotFoundError(delErr)) {
                this.logger.debug(`回滚善后：目标 ${file.toUri} 已不在，跳过删除: ${reason}`);
              } else {
                result.errors.push({ uri: file.toUri, reason });
              }
            }
          }
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
      } finally {
        this.rollingBack.delete(file.uri);
        if (file.toUri) this.rollingBack.delete(file.toUri);
      }
    }
    if (result.errors.length > 0) result.ok = false;
    return result;
  }

  // ──────────── 回滚后端注入 ────────────
  private _backendWrite?: (uri: string, data: Buffer) => Promise<void>;
  private _backendDelete?: (uri: string) => Promise<void>;
  private _backendMove?: (fromUri: string, toUri: string) => Promise<void>;
  private _memory?: MemoryService;
  private _emitMessagesDeleted?: (sessionId: string, timestamps: number[]) => void;
  private _emitHistoryChanged?: (sessionId: string) => void;

  setBackend(
    write: (uri: string, data: Buffer) => Promise<void>,
    del: (uri: string) => Promise<void>,
    move?: (fromUri: string, toUri: string) => Promise<void>,
  ): void {
    this._backendWrite = write;
    this._backendDelete = del;
    this._backendMove = move;
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

  /** uri 是否落在本插件自己的 checkpoint 根下（blob / manifest） */
  private isOwnUri(uri: string): boolean {
    const root = this.cfg.rootUri;
    return uri === root || uri.startsWith(root.endsWith('/') ? root : `${root}/`);
  }

  /**
   * uri 是否落在不记账的根下（kind 见 UNPROTECTED_ROOT_KINDS）。根未列出、kind 不在集合内（workspace 与
   * 用户自建的 custom / external / shared 等）、以及 listRoots 拿不到时都记账——宁可多记，不丢保护。
   * 每次现算而不缓存：调用频率是「每次文件改动一次」，而 storage 重载可能改变根集合，缓存只会拿到陈旧的根名。
   */
  private isUnprotectedRootUri(uri: string): boolean {
    const idx = uri.indexOf(':/');
    if (idx <= 0) return false;
    const rootName = uri.slice(0, idx);
    try {
      return this.storage.listRoots().some(r => r.name === rootName && UNPROTECTED_ROOT_KINDS.has(r.kind));
    } catch {
      return false;
    }
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

/** 「文件/目录已不存在」判据：优先看 errno code，再退回错误文案（storage 后端不保证带 code）。 */
function isNotFoundError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'ENOENT' || /ENOENT|不存在|not found/i.test(e?.message ?? String(err));
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
  return s ? toStorageUri(s) : 'data:/checkpoints';
}
