import type { Logger } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';

// ════════════════════════════════════════════════════════════
// UserStore —— users.json v3 数据层（能力委托存储）
//
// v3 记录：能力委托（caps.grant/deny）+ 委托父（grantedBy）。无数字等级。
// 单 owner 终态：不再有账户密码 / 跨平台绑定（已随多账户剥离移除）。
// 净化：非 v3 一律丢弃重来；加载时只取已知字段，顺带剔除旧版残留的 secret/links。
// 策略层（authorize/委托子集/临时授予）在 authority-manager.ts。
// ════════════════════════════════════════════════════════════

/** users.json v3 单用户记录 */
export interface UserRecord {
  /** 能力委托：grant=授予的 restricted 能力 glob；deny=禁用能力 glob（最高优先） */
  caps?: { grant?: string[]; deny?: string[] };
  /** 委托父身份键（如 "webui:admin"；owner 直接委托或顶层则空），形成委托树 */
  grantedBy?: string;
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
          // 只取已知字段：顺带剔除旧版可能残留的 secret(密码) / links(绑定)（多账户剥离前的数据）
          const r = record as UserRecord;
          const clean: UserRecord = {};
          if (r.caps) clean.caps = r.caps;
          if (r.grantedBy) clean.grantedBy = r.grantedBy;
          if (clean.caps || clean.grantedBy) this.users.set(key, clean);
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
