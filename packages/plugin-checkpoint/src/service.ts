import { AsyncLocalStorage } from 'node:async_hooks';
import type { CheckpointService, RollbackResult, RollbackWithChatResult } from '@aalis/api-checkpoint';
import type { MemoryService } from '@aalis/api-memory';
import { isStorageNotFound, isStorageUri, type StorageService } from '@aalis/api-storage';
import type { Logger, ServiceRef } from '@aalis/core';
import { type CheckpointConfig, configSchema } from './config.js';

/**
 * 不记账的根类型：多会话/多平台共享写入区（data、pluginData、logs）、回合结束前就清掉的临时目录与缓存（tmp、cache），
 * 白纸根（paper：枢纽在任意会话的回合进行中写入远端成品，记进那一轮的话回滚会删掉无关的成品），
 * 公开根（public：发布服务在审核结束、裁决与撤下时写删已发布的作品，同样不属于当时进行中的回合），
 * 以及 self 下的人设卡、技能、编排定义根（self）：现在任何会话都能经工具写技能、人设，写入没有会话归属，
 * 与 data 同理不记账；等访问层限定只有 owner 的干净线程能写 self 之后，再按计划书给它记账。
 */
const UNPROTECTED_ROOT_KINDS: ReadonlySet<string> = new Set([
  'data',
  'tmp',
  'cache',
  'pluginData',
  'logs',
  'paper',
  'public',
  'self',
]);

interface CheckpointFileRecord {
  uri: string;
  /** write=覆盖已有, write-new=新创建, delete=删除, rename=改名或移动 */
  action: 'write' | 'write-new' | 'delete' | 'rename';
  /** rename 的目标 URI（回滚时原路移回；存储实现没给目标时缺省） */
  toUri?: string;
  /** 原始大小（有快照时） */
  originalSize?: number;
  /** 备份文件名（相对于回合目录） */
  blob?: string;
  /** 没有备份的原因（过大、读取失败、目录等），这一条不可回滚 */
  skipped?: string;
}

/** 一轮的清单，提交时落盘为回合目录下的 manifest.json */
export interface TurnManifest {
  /** 回合 id，与 agent 的回合 id 相同 */
  turnId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  files: CheckpointFileRecord[];
  /** 这一轮对话消息的时间戳，rollbackWithChat 据此删除消息与向量条目 */
  messageTimestamps?: number[];
  /** 这一轮调用过 exec / exec_background / run_* 等命令类工具：它们的副作用不经存储，回滚覆盖不到 */
  execUsed?: boolean;
}

/** 回合列表的一行（listTurns） */
interface TurnSummary {
  turnId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  fileCount: number;
  /** 见 {@link TurnManifest.execUsed} */
  execUsed?: boolean;
  /** 前 3 个文件的 URI */
  filesPreview: string[];
}

/** 进行中的回合：清单 + 本回合已快照的 uri（去重）+ 备份文件计数器 */
interface ActiveTurn {
  manifest: TurnManifest;
  snapshotted: Set<string>;
  blobIndex: number;
}

interface ServiceConfig {
  rootUri: string;
  maxFileSize: number;
  keepSessions: number;
  scopes: string[];
}

/**
 * Checkpoint 服务实现
 *
 * 在一轮对话期间记录受控存储中的写入/删除/重命名操作（data / tmp / cache / pluginData /
 * logs / paper / public / self 这几类共享根、临时根、白纸根、公开根与 self 根除外，见 beforeMutate），
 * 在改动发生前自动备份原始文件内容，使用户可以一键回滚整轮操作。
 *
 * 协作模型：
 * - plugin-storage-local 在执行 writeFile/delete/rename 之前先探测 checkpoint 服务，
 *   在场就调它的 `beforeMutate(...)` 留一次快照机会。
 * - 本插件在 `agent:input:before` 里用 agent 给的 turnId 把这一轮包进 `runTurn`：回合的异步上下文里发生的改动
 *   记进这一轮，回合跑完（含被下游拦下、出错）即提交。
 * - exec / exec_background / run_* 等命令类工具直接调用系统命令，不在本服务保护范围内
 *   （前端 UI 标注「未保护」）。
 */
export class CheckpointServiceImpl implements CheckpointService {
  /**
   * 进行中的回合，按 turnId 记。同一会话可以同时有几轮在跑（agent 按会话加来源分 lane），
   * 改动按写入时所在的异步上下文归属到其中一轮，见 {@link scope}。
   */
  private readonly turns = new Map<string, ActiveTurn>();
  /** 回合的异步上下文：runTurn 里跑的一切（钩子、工具、它们触发的存储写入）都带着这一轮 */
  private readonly scope = new AsyncLocalStorage<ActiveTurn>();
  /** 读失败的告警记录：位置（会话目录或 manifest URI）→ 已告警过的原因 */
  private readonly readFailures = new Map<string, string>();

  constructor(
    private readonly cfg: ServiceConfig,
    private readonly logger: Logger,
    private readonly storage: StorageService,
  ) {}

  // ──────────── 生命周期 ────────────

  /**
   * 在一轮里跑 fn：fn 的异步上下文里发生的存储改动记进这一轮，fn 结束（含抛错）即提交。
   * 开始与结束在同一次调用里配对，同一会话并发的几轮互不结束对方。提交失败只告警：回复已经发出，
   * 这一轮只是不能回滚。
   */
  async runTurn<T>(turnId: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const turn: ActiveTurn = {
      manifest: { turnId, sessionId, startedAt: Date.now(), files: [] },
      snapshotted: new Set(),
      blobIndex: 0,
    };
    this.turns.set(turnId, turn);
    this.logger.debug(`checkpoint 回合开始 ${sessionId} turn=${turnId}`);
    try {
      return await this.scope.run(turn, fn);
    } finally {
      // flushAll 可能已经提交过它（拆卸时回合还在跑）
      if (this.turns.get(turnId) === turn) {
        this.turns.delete(turnId);
        await this.commitTurn(turn).catch(err =>
          this.logger.warn(`checkpoint 提交回合失败: ${(err as Error).message}`),
        );
      }
    }
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
  private async commitTurn(turn: ActiveTurn): Promise<void> {
    const m = turn.manifest;
    m.endedAt = Date.now();
    // 在持久化前抓取本轮对话的消息时间戳（供 rollbackWithChat 使用）；即使无文件改动，只要有消息就持久化
    const memory = this._memory?.current;
    if (memory && typeof memory.getMessagesBySessionRange === 'function') {
      try {
        // 宽松边界 200ms，用于容纳 archiveIncoming/saveMessage 时钟偏差
        const msgs = await memory.getMessagesBySessionRange(m.sessionId, m.startedAt - 200, m.endedAt + 200);
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

  /**
   * 调用所在的那一轮：异步上下文带着的回合还没结束才算。回合里起的异步任务可能在回合提交之后才写入，
   * 它们仍带着这一轮的上下文，但改动已不属于任何一轮。
   */
  private currentTurn(): ActiveTurn | undefined {
    const turn = this.scope.getStore();
    return turn && this.turns.get(turn.manifest.turnId) === turn ? turn : undefined;
  }

  /** 标记调用所在的那一轮调用过 exec / exec_background / run_* 等命令类工具：记进清单的 execUsed */
  markExecUsed(): void {
    const turn = this.currentTurn();
    if (turn) turn.manifest.execUsed = true;
  }

  // ──────────── beforeMutate ────────────

  async beforeMutate(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    loadOriginal: () => Promise<{ data: Buffer; size: number } | null>,
    toUri?: string,
  ): Promise<void> {
    // 只记进写入所在的那一轮。回合外的改动（WebUI 发起的回滚、别的插件在后台的写入）不属于任何一轮，
    // 存储每次写入都会调到这里，回合外的写入先在这一步返回
    const turn = this.currentTurn();
    if (!turn) return;
    // 自身根下的写入（blob / manifest）不快照：storage 的写前钩子会把它们递归送回这里，
    // 而 blob 此刻在磁盘上尚不存在 → 会给自己记一条 write-new 假账，且排在真实条目之前，
    // 回滚时先删备份再读同一 blob → ENOENT，覆盖/删除类恢复必败。
    if (this.isOwnUri(uri)) return;
    // data / pluginData / logs 是多会话、多平台共享的写入区：既有别处落盘的附件与插件状态，也有本回合自己
    // 经工具产生的图片，回滚这些会误删别人刚落盘的文件、把插件状态写回旧版，故整根不记账（这些改动不可回滚）；
    // self 根（skill / persona / 编排定义）现在任何会话都能写，同理不记账；
    // tmp、cache 是回合结束前就清掉的临时目录与缓存，记账只会让回滚必报 ENOENT；paper 是白纸根，枢纽在任意会话的回合进行中写入远端成品，
    // public 是公开根，发布服务在审核结束、裁决与撤下时写删已发布的作品，这些写入都不属于那一轮。
    // 其余根（workspace 与用户自建的 custom 等）照常记账。
    if (this.isUnprotectedRootUri(uri)) return;
    // 去重按 uri，但 rename 不能因此被吞掉：同一回合里「先 write/改写 f，再把 f 移走」时，
    // f 已快照过 → 移动整条不入账 → 回滚照 write 条目去写/删源端（ENOENT），文件还留在目标端。
    // 对这种回合补记一条不带 blob 的 rename（内容已由更早的条目备份，不重复备份）：
    // LIFO 回滚先由它把目标移回源端，再由更早的 write/write-new 条目恢复原文或删除。
    if (turn.snapshotted.has(uri)) {
      if (op === 'rename' && toUri) turn.manifest.files.push({ uri, action: 'rename', toUri });
      return;
    }
    turn.snapshotted.add(uri);

    let original: { data: Buffer; size: number } | null = null;
    // 「读不出来」必须与「本就不存在」区分：前者记成 write-new 的话，回滚会把一个回合
    // 开始前就存在、且没有备份的文件直接删掉（rollback 的 write-new 分支无条件删除）。
    let loadFailed = false;
    try {
      original = await loadOriginal();
    } catch (err) {
      loadFailed = true;
      this.logger.warn(`checkpoint 加载原文件失败 ${uri}: ${(err as Error).message}`);
    }

    // 情况 1：write 且原文件不存在 → 标记为新创建（回滚时需要删除）；
    // 情况 2：delete/rename 拿不到内容（目录，或读取失败）→ 仍要记一条：
    //   否则目录递归删除零记录，UI 却照样渲染「回滚本轮对话（含文件）」并报回滚完成。
    //   rename 有 toUri 时回滚仍能原路移回；delete 则如实标为不可回滚。
    if (!original) {
      if (op === 'write' && !loadFailed) {
        turn.manifest.files.push({ uri, action: 'write-new' });
      } else {
        // 读取失败的 write 记成 'write' + skipped：回滚时落到 skipped 分支如实报
        // 「不可回滚」并计入 errors，而不是当作本回合新建删掉。
        turn.manifest.files.push({
          uri,
          action: op,
          toUri,
          skipped: loadFailed ? '未快照（原文件读取失败，不可回滚）' : '未快照（目录或读取失败）',
        });
      }
      return;
    }
    // 情况 3：过大 → 跳过快照但记录为「skipped」
    if (original.size > this.cfg.maxFileSize) {
      turn.manifest.files.push({
        uri,
        action: op,
        toUri,
        originalSize: original.size,
        skipped: `文件过大 (${original.size} > ${this.cfg.maxFileSize})`,
      });
      return;
    }
    // 情况 4：正常快照
    const blobName = `${turn.blobIndex++}.bin`;
    const turnDir = this.turnDir(turn.manifest.sessionId, turn.manifest.turnId);
    await this.storage.writeFile(joinUri(turnDir, `blobs/${blobName}`), original.data);
    turn.manifest.files.push({
      uri,
      action: op,
      toUri,
      originalSize: original.size,
      blob: blobName,
    });
  }

  // ──────────── 查询 ────────────

  async listTurns(sessionId: string): Promise<TurnSummary[]> {
    const summaries: TurnSummary[] = (await this.manifests(sessionId)).map(manifest => ({
      turnId: manifest.turnId,
      sessionId: manifest.sessionId,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
      fileCount: manifest.files.length,
      execUsed: manifest.execUsed,
      filesPreview: manifest.files.slice(0, 3).map(f => f.uri),
    }));
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries;
  }

  /** 某会话已提交回合的清单，读不出来的回合跳过（并留痕） */
  private async manifests(sessionId: string): Promise<TurnManifest[]> {
    const sessionDir = joinUri(this.cfg.rootUri, encodeSegment(sessionId));
    let entries: string[];
    try {
      const listed = await this.storage.list(sessionDir);
      entries = listed.entries.filter(e => e.isDirectory).map(e => e.name);
    } catch (err) {
      // 目录不存在即该会话还没有检查点；其它失败（storage 不在线、权限被拒）要留痕，不能静默成空列表
      this.readFailed(sessionDir, '列出回合失败', err);
      return [];
    }
    this.readFailures.delete(sessionDir);
    const manifests: TurnManifest[] = [];
    for (const turnId of entries) {
      const manifest = await this.getManifest(sessionId, turnId);
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  }

  async getManifest(sessionId: string, turnId: string): Promise<TurnManifest | null> {
    const uri = joinUri(this.turnDir(sessionId, turnId), 'manifest.json');
    try {
      const raw = await this.storage.readFile(uri, 'utf-8');
      const manifest = JSON.parse(String(raw)) as TurnManifest;
      this.readFailures.delete(uri);
      return manifest;
    } catch (err) {
      // 不向上抛：回滚算 alsoChangedBy 时 manifests() 逐个读全会话的清单，一个坏 manifest 不能拖垮回滚。读失败与损坏要留痕
      this.readFailed(uri, '读取 manifest 失败', err);
      return null;
    }
  }

  /**
   * 读失败留痕：「不存在」不算失败；其它原因告警，但同一位置同一原因只记一次——每次回滚都要读这个会话的全部清单，
   * storage 不在线或 manifest 损坏时不能每次都记一条。读通（或确认不存在）即清掉记录，之后再失败会再记。
   */
  private readFailed(location: string, what: string, err: unknown): void {
    if (isStorageNotFound(err)) {
      this.readFailures.delete(location);
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    if (this.readFailures.get(location) === reason) return;
    this.readFailures.set(location, reason);
    this.logger.warn(`checkpoint ${what} ${location}: ${reason}`);
  }

  // ──────────── 回滚 ────────────

  async rollback(sessionId: string, turnId: string): Promise<RollbackResult> {
    const manifest = await this.getManifest(sessionId, turnId);
    if (!manifest) {
      return {
        ok: false,
        restored: [],
        deleted: [],
        errors: [{ uri: '', reason: 'checkpoint 不存在' }],
        alsoChangedBy: [],
      };
    }
    const result: RollbackResult = {
      ok: true,
      restored: [],
      deleted: [],
      errors: [],
      alsoChangedBy: await this.alsoChangedBy(manifest),
    };
    const turnDir = this.turnDir(sessionId, turnId);

    // 逆序撤销（LIFO）：同回合内后发生的改动先回退，否则先前条目的复原会被后来条目再次覆盖。
    // 例：`move a.txt -> b.txt` 后又改写 b.txt，正序回滚先把 b 移回 a，再把 b 的快照写回，
    // b.txt 又冒出来；逆序则先把 b 还原成改写前内容，再整体移回 a，磁盘回到回合开始的样子。
    for (const file of [...manifest.files].reverse()) {
      try {
        if (file.action === 'write-new') {
          // 新创建的文件 → 删除。已不存在即期望状态已达成（本回合新建后又删掉：delete 条目被按 URI
          // 去重吞掉，只剩这条 write-new），不算失败。
          try {
            await this.storage.delete(file.uri);
            result.deleted.push(file.uri);
          } catch (delErr) {
            if (!isStorageNotFound(delErr)) throw delErr;
          }
        } else if (file.action === 'rename' && file.toUri) {
          // 改名/移动 → 优先原路移回：目录与超限大文件也能复原，且不会在目标端留一份重复。
          // 移不动（目标已被占、后端 move 失败等）才回落到「写回源端 + 删目标」。
          try {
            await this.storage.move(file.toUri, file.uri);
            result.restored.push(file.uri);
          } catch (moveErr) {
            if (!file.blob) throw moveErr;
            const data = await this.storage.readFile(joinUri(turnDir, `blobs/${file.blob}`));
            await this.storage.writeFile(file.uri, Buffer.from(data as Uint8Array));
            result.restored.push(file.uri);
            // 源端复原即算成功；删目标是善后动作，单独 try：目标已不在（ENOENT——重复回滚、
            // 别处已清）就是期望状态，才忽略；其它失败（权限被拒等）如实入 errors，也不谎报 deleted。
            try {
              await this.storage.delete(file.toUri);
              result.deleted.push(file.toUri);
            } catch (delErr) {
              const reason = (delErr as Error).message ?? String(delErr);
              if (isStorageNotFound(delErr)) {
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
          await this.storage.writeFile(file.uri, Buffer.from(data as Uint8Array));
          result.restored.push(file.uri);
        }
      } catch (err) {
        result.errors.push({ uri: file.uri, reason: (err as Error).message });
      }
    }
    if (result.errors.length > 0) result.ok = false;
    return result;
  }

  /**
   * 这一轮改过、同一会话里另有回合也改过的文件（含移动的目标端），见 RollbackResult.alsoChangedBy。
   * 在这一轮开始前就已结束的回合不算；已提交的与还在跑的回合都算。时间戳只到毫秒，结束与开始落在同一毫秒的
   * 分不出先后，按算处理：多列一轮只是多一句如实的提示，漏列会让回滚悄悄撤掉别人的改动。
   */
  private async alsoChangedBy(target: TurnManifest): Promise<RollbackResult['alsoChangedBy']> {
    const touched = (m: TurnManifest) => new Set(m.files.flatMap(f => (f.toUri ? [f.uri, f.toUri] : [f.uri])));
    const running = [...this.turns.values()].map(t => t.manifest).filter(m => m.sessionId === target.sessionId);
    const others = [...(await this.manifests(target.sessionId)), ...running]
      .filter(m => m.turnId !== target.turnId && !(m.endedAt !== undefined && m.endedAt < target.startedAt))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(m => ({ turnId: m.turnId, uris: touched(m) }));
    return [...touched(target)]
      .map(uri => ({ uri, turnIds: others.filter(o => o.uris.has(uri)).map(o => o.turnId) }))
      .filter(entry => entry.turnIds.length > 0);
  }

  // ──────────── 聊天回滚依赖注入 ────────────
  private _memory?: ServiceRef<MemoryService>;
  private _emitMessagesDeleted?: (sessionId: string, timestamps: number[]) => void;
  private _emitHistoryChanged?: (sessionId: string) => void;

  /** 注入聊天回滚所需的依赖：memory 引用（每次用时解析当前提供者）+ 事件发出器 */
  setChatRollbackDeps(deps: {
    memory: ServiceRef<MemoryService>;
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
        alsoChangedBy: [],
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

    const memory = this._memory?.current;
    if (!memory || typeof memory.deleteMessagesByTimestamps !== 'function') {
      result.errors.push({ uri: '', reason: '当前 memory 后端不支持 deleteMessagesByTimestamps' });
      result.ok = false;
      return result;
    }

    try {
      result.deletedMessages = await memory.deleteMessagesByTimestamps(sessionId, timestamps);
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

function joinUri(base: string, rel: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${rel.replace(/^\/+/, '')}`;
}

/** 文件系统路径段：把 ":" "/" "\" 等特殊字符 URL 编码 */
function encodeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, c => `_${c.charCodeAt(0).toString(16)}`);
}

export function normalizeConfig(cfg: CheckpointConfig): ServiceConfig {
  return {
    rootUri: resolveRootUri(cfg.rootDir),
    maxFileSize: Math.max(1024, cfg.maxFileSize),
    keepSessions: Math.max(0, Math.floor(cfg.keepSessions)),
    scopes: cfg.scopes.filter(s => s.trim() !== ''),
  };
}

/** rootDir 只接受 storage URI；留空使用默认值，非 URI 在副作用前拒绝。 */
function resolveRootUri(input: string): string {
  const s = input.trim();
  if (!s) return configSchema.rootDir.default;
  if (!isStorageUri(s)) {
    throw new Error('plugin-checkpoint 配置错误: rootDir 不是 storage URI，请写成 <根名>:/<路径>');
  }
  return s;
}
