import type { Logger } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';

// ════════════════════════════════════════════════════════════
// UserStore —— users.json v5 数据层（数字等级单轴存储）
//
// 单 owner 终态：每个外部身份恰好一个**整数等级**（默认 0，封禁=负数；owner 不入表）。
// 无能力 glob、无密码、无绑定、无委托树。净化：非 v5 一律丢弃重来（0.5.0 未发，无迁移）。
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

  // ── 持久化（v4；非 v4 一律丢弃，净化无迁移）──────────────────
  save(): void {
    if (!this.dirty) return;
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

  async load(): Promise<void> {
    try {
      let raw: string;
      try {
        raw = (await this.storage.readFile(this.fileUri, 'utf-8')) as string;
      } catch {
        return; // 无文件 = 全新（owners 配置 seed owner）
      }
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
        // 旧版本（v1-v4 能力/密码/档位模型）净化丢弃：0.5.0 未发，无迁移
        this.logger.info(`users.json 版本 ${data.version ?? '未知'} 非 v5，按净化策略丢弃旧数据，重新开始`);
      }
    } catch (err) {
      this.logger.warn(`加载用户等级数据失败: ${err}`);
    }
  }
}
