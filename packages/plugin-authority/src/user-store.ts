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
  /** 在飞的 load（首载或重读，含收尾补落盘）：期间 save 只保留 dirty、不写盘 */
  private loading: Promise<void> | undefined;

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
  /** 上次加载失败、正在拒写：此时的等级改动只在本次运行生效，不会写入 users.json */
  get persistBlocked(): boolean {
    return this.loadFailed;
  }

  save(): void {
    if (!this.dirty) return;
    // load 在飞：文件里的记录还没并进内存，此刻的全量快照是残缺的，写下去会覆盖健康的 users.json
    // （storage 晚于本插件上线时，首载期间的一次等级改动就会触发）。
    // dirty 保持为 true，由 load 收尾按正常路径补落盘。
    if (this.loading) return;
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
   * load 在飞时 save 把写推迟到 load 收尾，所以先等 load 落定（期间又起了新的 load 就接着等）再等链。
   * load 无论成败都先清掉 loading 再落定，这里的递归只会接着等新起的 load；
   * saveChain 已用 `.then(ok, err)` 终结、永不 reject，await 它是安全的。
   */
  flushed(): Promise<void> {
    if (this.loading) {
      const next = (): Promise<void> => this.flushed();
      return this.loading.then(next, next);
    }
    return this.saveChain;
  }

  load(): Promise<void> {
    // 重读即重判：storage 重新上线（follow 重挂）或重启后 load 成功即恢复落盘；
    // 同一进程内不会自动重读——没有新的 load，这一程就一直拒写。
    const settle = (failed: boolean): void => {
      // 判定要等读完、解析完才落到 loadFailed：重读在飞期间 persistBlocked 沿用上一次的判定
      this.loadFailed = failed;
      // 重叠的 load 只由最后发起的那次解除推迟：还有一次在读时，快照照样残缺
      if (this.loading === run) this.loading = undefined;
      // 在飞期间被推迟的写按正常路径补上；仍拒写时 save 自会拦下
      this.save();
    };
    const run: Promise<void> = this.readUsersFile().then(settle, err => {
      // readUsersFile 自己的兜底也抛了（storage 抛出转不成字符串的值、日志订阅者同步抛错等）：
      // 文件状态不明，按读不懂拒写；推迟照常解除，否则 save 与 flushed 会一直等这次 load。错误交还调用方
      settle(true);
      throw err;
    });
    this.loading = run;
    return run;
  }

  /** 读入并解析 users.json（v5 记录并入内存表）；返回 true 表示文件在但读不出或解析不了 */
  private async readUsersFile(): Promise<boolean> {
    let raw: string;
    try {
      raw = (await this.storage.readFile(this.fileUri, 'utf-8')) as string;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isStorageNotFound(err)) {
        // 无文件 = 全新（owners 配置 seed owner）
        this.logger.debug(`users.json 不存在，按全新开始: ${msg}`);
        return false;
      }
      // 文件在但读不出（权限/storage 未就绪等）：标记失败并拒写，否则下一次等级改动即清空原表
      this.logger.error(`读取 users.json 失败，本次运行不再写入该文件: ${msg}`);
      return true;
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
        return false;
      }
      // 版本不是 v5（旧的能力/密码/档位模型或更高版本）或 users 不是对象（截断/被外部工具写坏）：
      // 原表仍可能在文件里，等同解析失败按拒写处理，别让一次全量快照抹掉它。
      this.logger.error(
        `users.json 不是有效的 v5 结构（version: ${data.version ?? '未知'}），本次运行不再写入该文件；请人工修复，或删除/移走该文件后重启按全新开始`,
      );
      return true;
    } catch (err) {
      // 解析失败同理：坏文件不能被一次全量快照覆盖掉
      this.logger.error(`解析 users.json 失败，本次运行不再写入该文件: ${err}`);
      return true;
    }
  }
}
