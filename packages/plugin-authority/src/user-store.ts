import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';

// ════════════════════════════════════════════════════════════
// UserStore —— users.json v5 数据层（数字等级单轴存储）
//
// 单 owner 终态：每个外部身份恰好一个**整数等级**（默认 0，封禁=负数；owner 不入表）。
// 无能力 glob、无密码、无绑定、无委托树。非 v5 文件按加载失败处理（记 error、拒写），不做迁移。
// 裁决在 authority-manager.ts；等级数字引擎在 authority-model.ts。
// ════════════════════════════════════════════════════════════

/** users.json v5 单用户记录 */
export interface UserRecord {
  /** 登记等级（整数，越大越高；缺省 0，封禁=负数）；owner 不入表 */
  level?: number;
  /** 可选备注（这人是谁） */
  note?: string;
}

const USERS_VERSION = 5;

export class UserStore {
  private users = new Map<string, UserRecord>();
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();
  /** load 时「文件在但读不出/解析不了」——此后一律拒写，别让全量快照覆盖掉封禁/等级记录 */
  private loadFailed = false;

  constructor(
    private readonly storage: StorageService,
    private readonly logger: Logger,
    private readonly fileUri = 'data:/users.json',
  ) {}

  // ── 记录读写 ──────────────────────────────────────────────
  get(key: string): UserRecord | undefined {
    return this.users.get(key);
  }
  set(key: string, record: UserRecord): void {
    this.users.set(key, record);
    this.dirty = true;
  }
  delete(key: string): boolean {
    const ok = this.users.delete(key);
    if (ok) this.dirty = true;
    return ok;
  }
  entries(): IterableIterator<[string, UserRecord]> {
    return this.users.entries();
  }

  // ── 持久化（版本见 USERS_VERSION；非当前版本按加载失败拒写，无迁移）──
  save(): void {
    if (!this.dirty) return;
    if (this.loadFailed) {
      // 写的是**全量快照**：坏文件没载进内存时一次 save 就把原有记录清空。
      // 宁可这一程的改动不落盘（内存里仍生效），也不能静默销毁封禁/等级数据。
      this.logger.error('users.json 上次加载失败，拒绝写入以免覆盖原数据；请人工修复或移走该文件后重启');
      return;
    }
    const users: Record<string, UserRecord> = {};
    for (const [key, record] of this.users) users[key] = record;
    const payload = JSON.stringify({ version: USERS_VERSION, users }, null, 2);
    this.dirty = false;
    this.saveChain = this.saveChain
      .then(() => this.storage.writeFile(this.fileUri, payload))
      .then(
        () => this.logger.debug('用户等级数据已保存'),
        err => {
          this.logger.warn(`保存用户等级数据失败: ${err}`);
          this.dirty = true;
        },
      );
  }

  /**
   * 等待此前挂上去的落盘真正完成。
   *
   * `save()` 是同步返回的（写挂在 saveChain 上），所以拆卸路径必须显式等这个，
   * 否则进程退出时在飞的写会被丢掉——封禁/等级是安全语义，丢了就是「封了但没封住」。
   * saveChain 已用 `.then(ok, err)` 终结、永不 reject，await 它是安全的。
   */
  flushed(): Promise<void> {
    return this.saveChain;
  }

  async load(): Promise<void> {
    // 重读即重判：storage 重新上线（follow 重挂）或重启后 load 成功即恢复落盘；
    // 同一进程内不会自动重读——没有新的 load，这一程就一直拒写。
    this.loadFailed = false;
    let raw: string;
    try {
      raw = (await this.storage.readFile(this.fileUri, 'utf-8')) as string;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isStorageNotFound(err)) {
        // 无文件 = 全新（owners 配置 seed owner）
        this.logger.debug(`users.json 不存在，按全新开始: ${msg}`);
      } else {
        // 文件在但读不出（权限/storage 未就绪等）：标记失败并拒写，否则下一次等级改动即清空原表
        this.loadFailed = true;
        this.logger.error(`读取 users.json 失败，本次运行不再写入该文件: ${msg}`);
      }
      return;
    }
    try {
      const data = JSON.parse(raw) as { version?: number; users?: Record<string, UserRecord> };
      if (data.version === USERS_VERSION && data.users && typeof data.users === 'object') {
        for (const [key, record] of Object.entries(data.users)) {
          if (!record || typeof record !== 'object') continue;
          const r = record as UserRecord;
          const clean: UserRecord = {};
          if (typeof r.level === 'number' && Number.isFinite(r.level)) clean.level = r.level;
          if (r.note) clean.note = r.note;
          if (clean.level !== undefined || clean.note) this.users.set(key, clean);
        }
        this.logger.debug(`加载 ${this.users.size} 条用户等级记录`);
      } else {
        // 版本不是 v5（旧的能力/密码/档位模型或更高版本）或 users 不是对象（截断/被外部工具写坏）：
        // 原表仍可能在文件里，等同解析失败按拒写处理，别让一次全量快照抹掉它。
        this.loadFailed = true;
        this.logger.error(
          `users.json 不是有效的 v5 结构（version: ${data.version ?? '未知'}），本次运行不再写入该文件；请人工修复，或删除/移走该文件后重启按全新开始`,
        );
      }
    } catch (err) {
      // 解析失败同理：坏文件不能被一次全量快照覆盖掉
      this.loadFailed = true;
      this.logger.error(`解析 users.json 失败，本次运行不再写入该文件: ${err}`);
    }
  }
}
