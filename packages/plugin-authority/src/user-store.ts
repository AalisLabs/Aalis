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
  /**
   * 自上次成功落盘以来 set / delete 过的键 → 改动序号。重读时这些键以内存为准（删除也算，内存记录里没有的备注沿用文件）：
   * 读取在飞或 storage 离线期间的改动还没进文件，按文件值覆盖就会静默撤回封禁或降权。
   * 写盘成功后清掉该次快照已含的改动；写链在飞期间又改过的键序号更大，留到下一次。
   */
  private dirtyKeys = new Map<string, number>();
  private rev = 0;
  /** 最近一次写盘失败（成功即清除） */
  private saveFailed = false;
  private saveChain: Promise<void> = Promise.resolve();
  /** load 时「文件在但读不出/解析不了」——此后一律拒写，别让全量快照覆盖掉封禁/等级记录 */
  private loadFailed = false;
  /** 在飞的 load（首载或重读，含收尾补落盘）：期间 save 只保留 dirty、不写盘 */
  private loading: Promise<void> | undefined;
  /** 首次读取已落定（读成功、文件不存在或判为读不懂）：此前 save 与 load 在飞时一样只保留 dirty、不写盘 */
  private firstLoadSettled = false;

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
    this.touch(key);
  }
  delete(key: string): boolean {
    const ok = this.users.delete(key);
    // 扑空也记脏键，作为删除墓碑：首次读取完成前（storage 未上线、读取尚未开始）内存表不含文件里的记录，
    // 不记的话读取按文件重建时被删的记录（如封禁）又回来
    this.touch(key);
    return ok;
  }
  entries(): IterableIterator<[string, UserRecord]> {
    return this.users.entries();
  }
  private touch(key: string): void {
    this.dirtyKeys.set(key, ++this.rev);
    this.dirty = true;
  }

  // ── 持久化（版本见 USERS_VERSION；非当前版本按加载失败拒写，无迁移）──
  /** 上次加载失败、正在拒写：此时的等级改动只在本次运行生效，不会写入 users.json */
  get persistBlocked(): boolean {
    return this.loadFailed;
  }

  /** 最近一次写盘失败（storage 不在线、权限、磁盘满）：改动仍只在内存，下次 save 重写整份快照 */
  get lastSaveFailed(): boolean {
    return this.saveFailed;
  }

  /** 首次读取尚未落定（storage 未上线，或已上线但读取尚未发起、尚未读完）：此时的改动只在内存，读取落定后写盘 */
  get awaitingFirstLoad(): boolean {
    return !this.firstLoadSettled;
  }

  save(): void {
    if (!this.dirty) return;
    // 首次读取落定之前、load 在飞时：文件里的记录还没并进内存，此刻的全量快照是残缺的，写下去会覆盖健康的
    // users.json（storage 晚于本插件上线时，首载期间或 storage 刚上线、读取尚未发起时的一次等级改动就会触发）。
    // dirty 保持为 true，由 load 收尾按正常路径补落盘；首次读取发起之前停机或卸载，这些改动不写盘
    // （已发起的读取由 flushed 等它落定再写）。
    if (!this.firstLoadSettled || this.loading) return;
    if (this.loadFailed) {
      // 写的是**全量快照**：坏文件没载进内存时一次 save 就把原有记录清空。
      // 宁可这一程的改动不落盘（内存里仍生效），也不能静默销毁封禁/等级数据。
      this.logger.error('users.json 上次加载失败，拒绝写入以免覆盖原数据；请人工修复或移走该文件后重启');
      return;
    }
    const users: Record<string, UserRecord> = {};
    for (const [key, record] of this.users) users[key] = record;
    const payload = JSON.stringify({ version: USERS_VERSION, users }, null, 2);
    const upTo = this.rev;
    this.dirty = false;
    this.saveChain = this.saveChain
      .then(() => this.storage.writeFile(this.fileUri, payload))
      .then(
        () => {
          for (const [key, rev] of this.dirtyKeys) if (rev <= upTo) this.dirtyKeys.delete(key);
          this.saveFailed = false;
          this.logger.debug('用户等级数据已保存');
        },
        err => {
          this.dirty = true;
          this.saveFailed = true;
          // err 作参数交给 logger 渲染：模板字符串遇到转不成字符串的值（null 原型对象等）会抛
          this.logger.error('保存用户等级数据失败，改动仍只在内存生效，下次保存时重试:', err);
        },
      )
      // 上报器自身失败（宿主经 AppOptions 注入的 logger 或时钟抛错）不再外抛：链停在拒绝时 flushed() 与拆卸都会抛，
      // 此后的写也不再发出；load 收尾那次保存无人等待，还会成为未处理的拒绝、被宿主当致命错误退出进程
      .catch(() => {});
  }

  /**
   * 等在飞的 load 落定（期间又起了新的 load 就接着等）；load 成败都算落定，本身不抛。
   * load 无论成败都先清掉 loading 再落定，这里的递归只会接着等新起的 load。
   */
  whenLoaded(): Promise<void> {
    if (!this.loading) return Promise.resolve();
    const next = (): Promise<void> => this.whenLoaded();
    return this.loading.then(next, next);
  }

  /**
   * 等待此前挂上去的落盘真正完成。
   *
   * `save()` 是同步返回的（写挂在 saveChain 上），所以拆卸路径必须显式等这个，
   * 否则进程退出时在飞的写会被丢掉——封禁/等级是安全语义，丢了就是「封了但没封住」。
   * load 在飞时 save 把写推迟到 load 收尾，所以先等 load 落定再等链。
   * saveChain 每一环以 `.then(ok, err)` 收尾并接住上报器自身的失败、永不 reject，await 它是安全的。
   */
  flushed(): Promise<void> {
    return this.whenLoaded().then(() => this.saveChain);
  }

  load(): Promise<void> {
    // 重读即重判：storage 重新上线（follow 重挂）或重启后 load 成功即恢复落盘；
    // 同一进程内不会自动重读——没有新的 load，这一程就一直拒写。
    const settle = (failed: boolean): void => {
      // 判定要等读完、解析完才落到 loadFailed：重读在飞期间 persistBlocked 沿用上一次的判定
      this.loadFailed = failed;
      this.firstLoadSettled = true;
      // 重叠的 load 只由最后发起的那次解除推迟：还有一次在读时，快照照样残缺
      if (this.loading === run) this.loading = undefined;
      // 在飞期间被推迟的写按正常路径补上；仍拒写时 save 自会拦下
      this.save();
    };
    const run: Promise<void> = this.readUsersFile().then(settle, err => {
      // readUsersFile 自己的兜底也抛了（storage 抛出转不成字符串的值、宿主注入的 logger 抛错等）：
      // 文件状态不明，按读不懂拒写；推迟照常解除，否则 save 与 flushed 会一直等这次 load。错误交还调用方
      settle(true);
      throw err;
    });
    this.loading = run;
    return run;
  }

  /** 读入并解析 users.json（以文件重建内存表，再叠加尚未落盘的改动）；返回 true 表示文件在但读不出或解析不了 */
  private async readUsersFile(): Promise<boolean> {
    // 开读时已标脏的键：读取期间在飞的写成功会清掉它们，读到的却可能是写入前的内容，
    // 只看读完时的脏键就会按旧文件重建、撤回刚写进去的改动
    const dirtyAtStart = [...this.dirtyKeys.keys()];
    let raw: string;
    try {
      raw = (await this.storage.readFile(this.fileUri, 'utf-8')) as string;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isStorageNotFound(err)) {
        // 无文件 = 全新（owners 配置 seed owner）。内存表不动：首载时本就是空表，
        // 重读时按空表重建会把内存里的封禁一并清掉
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
        // 重建而非并入：运行中从文件里删掉的记录随重读生效
        const next = new Map<string, UserRecord>();
        for (const [key, record] of Object.entries(data.users)) {
          if (!record || typeof record !== 'object') continue;
          const r = record as UserRecord;
          const clean: UserRecord = {};
          if (typeof r.level === 'number' && Number.isFinite(r.level)) clean.level = r.level;
          if (r.note) clean.note = r.note;
          if (clean.level !== undefined || clean.note) next.set(key, clean);
        }
        for (const key of new Set([...dirtyAtStart, ...this.dirtyKeys.keys()])) {
          const record = this.users.get(key);
          // 内存里的字段盖过文件的：首次读取前改等级时内存里没有文件里的备注，按整条覆盖会丢掉它
          if (record) next.set(key, { ...next.get(key), ...record });
          else next.delete(key);
        }
        this.users = next;
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
