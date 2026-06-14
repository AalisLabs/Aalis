import { Buffer } from 'node:buffer';
import type { Logger } from '@aalis/core';
import type { UserIdentity } from '@aalis/plugin-authority-api';
import type { StorageService } from '@aalis/plugin-storage-api';

// ════════════════════════════════════════════════════════════
// UserStore —— users.json v3 数据层（存储 + 绑定 + 密码 + 反向索引）
//
// v3 记录：能力委托（caps.grant/deny）+ 委托父（grantedBy）+ 密码（secret）+
// 跨平台绑定（links）。无数字等级。净化：非 v3 一律丢弃重来（早期均为测试数据）。
// 策略层（authorize/委托子集/临时授予）在 authority-manager.ts。
// ════════════════════════════════════════════════════════════

/** users.json v3 单用户记录 */
export interface UserRecord {
  /** 能力委托：grant=授予的 restricted 能力 glob；deny=禁用能力 glob（最高优先） */
  caps?: { grant?: string[]; deny?: string[] };
  /** 委托父身份键（如 "webui:admin"；owner 直接委托或顶层则空），形成委托树 */
  grantedBy?: string;
  /** 密码凭据 `pbkdf2:<iterations>:<saltHex>:<hashHex>`（存在即为可登录账户） */
  secret?: string;
  /** 本账户绑定的平台身份键（如 "onebot:12345"；仅主账户有） */
  links?: string[];
}

const USERS_VERSION = 3;
const BIND_CODE_TTL_MS = 5 * 60 * 1000;
// 8 位、去易混淆字符（0O1IL）的码空间 ≈ 31^8 ≈ 8.5e11，无需额外限流
const BIND_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// 密码哈希：Web Crypto PBKDF2-SHA256（迭代数随凭据存储，便于将来上调不破坏旧凭据）
const PBKDF2_ITERATIONS = 310_000;

function generateBindCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (const b of bytes) code += BIND_CODE_ALPHABET[b % BIND_CODE_ALPHABET.length];
  return code;
}

async function deriveHash(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(saltHex, 'hex'), iterations },
    key,
    256,
  );
  return Buffer.from(bits).toString('hex');
}

/** 恒定时间字符串比较（长度不同直接 false；不早退） */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface PendingBindCode {
  account: string;
  expiresAt: number;
}

export class UserStore {
  private users = new Map<string, UserRecord>();
  /** 反向绑定索引：被绑平台身份键 → 主账户键（从 users[].links 重建） */
  private linkIndex = new Map<string, string>();
  private bindCodes = new Map<string, PendingBindCode>();
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
    if (ok) {
      this.dirty = true;
      this.rebuildLinkIndex();
    }
    return ok;
  }
  entries(): IterableIterator<[string, UserRecord]> {
    return this.users.entries();
  }
  markDirty(): void {
    this.dirty = true;
  }

  /** 被绑平台身份 → 主账户键（无绑定返回 undefined） */
  accountOf(key: string): string | undefined {
    return this.linkIndex.get(key);
  }
  /** 所有绑定关系（被绑身份键 → 主账户键） */
  links(): IterableIterator<[string, string]> {
    return this.linkIndex.entries();
  }

  // ── 跨平台身份绑定 ────────────────────────────────────────
  private rebuildLinkIndex(): void {
    this.linkIndex.clear();
    for (const [key, record] of this.users) {
      for (const linked of record.links ?? []) this.linkIndex.set(linked, key);
    }
  }

  createBindCode(platform: string, userId: string): { code: string; expiresAt: number } {
    if (platform !== 'webui') throw new Error('绑定码只能由 WebUI 主账户发起');
    const account = `${platform}:${userId}`;
    const now = Date.now();
    for (const [code, pending] of this.bindCodes) {
      if (pending.account === account || pending.expiresAt <= now) this.bindCodes.delete(code);
    }
    const code = generateBindCode();
    const expiresAt = now + BIND_CODE_TTL_MS;
    this.bindCodes.set(code, { account, expiresAt });
    this.logger.info(`生成绑定码: 账户 ${account}（5 分钟有效）`);
    return { code, expiresAt };
  }

  consumeBindCode(code: string, identity: UserIdentity): UserIdentity {
    if (identity.platform === 'webui' || identity.platform === 'cli') {
      throw new Error('请在外部平台（如 QQ）私聊中向机器人发送绑定码');
    }
    const pending = this.bindCodes.get(code);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.bindCodes.delete(code);
      throw new Error('绑定码无效或已过期，请在 WebUI 重新生成');
    }
    const identityKey = `${identity.platform}:${identity.userId}`;
    const existing = this.linkIndex.get(identityKey);
    if (existing) throw new Error(`该平台身份已绑定到 ${existing}，请先解绑`);
    this.bindCodes.delete(code); // 一次性

    const accountRecord: UserRecord = { ...this.users.get(pending.account) };
    // 绑时一次性合并（运行时零合并的前提）：能力 grant/deny 并集写入账户；
    // 平台身份原记录原样留底，解绑即还原。无数字等级故无 max-level 步骤。
    const identityRecord = this.users.get(identityKey);
    if (identityRecord?.caps) {
      const union = (a?: string[], b?: string[]): string[] | undefined => {
        const merged = [...new Set([...(a ?? []), ...(b ?? [])])];
        return merged.length > 0 ? merged : undefined;
      };
      accountRecord.caps = {
        grant: union(accountRecord.caps?.grant, identityRecord.caps.grant),
        deny: union(accountRecord.caps?.deny, identityRecord.caps.deny),
      };
    }
    accountRecord.links = [...new Set([...(accountRecord.links ?? []), identityKey])];
    this.users.set(pending.account, accountRecord);
    this.dirty = true;
    this.rebuildLinkIndex();
    const idx = pending.account.indexOf(':');
    this.logger.info(`身份绑定成功: ${identityKey} → ${pending.account}`);
    return { platform: pending.account.slice(0, idx), userId: pending.account.slice(idx + 1) };
  }

  unlinkIdentity(platform: string, userId: string): boolean {
    const identityKey = `${platform}:${userId}`;
    const accountKey = this.linkIndex.get(identityKey);
    if (!accountKey) return false;
    const record = this.users.get(accountKey);
    if (record?.links) {
      const links = record.links.filter(k => k !== identityKey);
      this.users.set(accountKey, { ...record, links: links.length > 0 ? links : undefined });
    }
    this.dirty = true;
    this.rebuildLinkIndex();
    this.logger.info(`身份解绑: ${identityKey} ↮ ${accountKey}`);
    return true;
  }

  // ── 密码 ──────────────────────────────────────────────────
  async setPassword(platform: string, userId: string, password: string): Promise<void> {
    if (!password) throw new Error('密码不能为空');
    const key = `${platform}:${userId}`;
    const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
    const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
    this.users.set(key, { ...this.users.get(key), secret: `pbkdf2:${PBKDF2_ITERATIONS}:${salt}:${hash}` });
    this.dirty = true;
    this.logger.info(`账户密码已更新: ${key}`);
  }

  async verifyPassword(platform: string, userId: string, password: string): Promise<boolean> {
    const secret = this.users.get(`${platform}:${userId}`)?.secret;
    if (!secret || !password) return false;
    const [scheme, iterStr, salt, hash] = secret.split(':');
    const iterations = Number(iterStr);
    if (scheme !== 'pbkdf2' || !Number.isFinite(iterations) || iterations < 1 || !salt || !hash) return false;
    const actual = await deriveHash(password, salt, iterations);
    return timingSafeEqualStr(actual, hash);
  }

  hasPassword(platform: string, userId: string): boolean {
    return !!this.users.get(`${platform}:${userId}`)?.secret;
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
          if (record && typeof record === 'object') this.users.set(key, record);
        }
        this.rebuildLinkIndex();
        this.logger.debug(`加载 ${this.users.size} 条用户记录（绑定 ${this.linkIndex.size} 条）`);
      } else {
        // 旧版本（v1/v2）净化丢弃：能力委托模型不做数字等级迁移
        this.logger.info(`users.json 版本 ${data.version ?? '未知'} 非 v3，按净化策略丢弃旧数据，重新开始`);
      }
    } catch (err) {
      this.logger.warn(`加载用户权限数据失败: ${err}`);
    }
  }
}
