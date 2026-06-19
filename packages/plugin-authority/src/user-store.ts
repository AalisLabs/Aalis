import type { Logger } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';

// ════════════════════════════════════════════════════════════
// UserStore —— users.json v3 数据层（能力委托存储）
//
// v3 记录：能力授予（caps.grant/deny）。无数字等级、无委托树。
// 单 owner 终态：权限只由 owner 管理；不再有账户密码 / 跨平台绑定 / 委托父（grantedBy）。
// 净化：非 v3 一律丢弃重来；加载时只取 caps，顺带剔除旧版残留（secret/links/grantedBy）。
// 策略层（authorize/owner 授予/临时放行）在 authority-manager.ts。
// ════════════════════════════════════════════════════════════

/** users.json v3 单用户记录 */
export interface UserRecord {
  /** 能力授予：grant=授予的 restricted 能力 glob；deny=禁用能力 glob（最高优先） */
  caps?: { grant?: string[]; deny?: string[] };
}

const USERS_VERSION = 3;

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
  markDirty(): void {
    this.dirty = true;
  }

  // ── 持久化（v3；非 v3 一律丢弃，净化无迁移）──────────────────
  save(): void {
    if (!this.dirty) return;
    const users: Record<string, UserRecord> = {};
    for (const [key, record] of this.users) users[key] = record;
    const payload = JSON.stringify({ version: USERS_VERSION, users }, null, 2);
    this.dirty = false;
    this.saveChain = this.saveChain
      .then(() => this.storage.writeFile(this.fileUri, payload))
      .then(
        () => this.logger.debug('用户权限数据已保存'),
        err => {
          this.logger.warn(`保存用户权限数据失败: ${err}`);
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
          // 只取 caps：顺带剔除旧版残留（secret 密码 / links 绑定 / grantedBy 委托父）
          const r = record as UserRecord;
          if (r.caps) this.users.set(key, { caps: r.caps });
        }
        this.logger.debug(`加载 ${this.users.size} 条用户记录`);
      } else {
        // 旧版本（v1/v2）净化丢弃：能力委托模型不做数字等级迁移
        this.logger.info(`users.json 版本 ${data.version ?? '未知'} 非 v3，按净化策略丢弃旧数据，重新开始`);
      }
    } catch (err) {
      this.logger.warn(`加载用户权限数据失败: ${err}`);
    }
  }
}
