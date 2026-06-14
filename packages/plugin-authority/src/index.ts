import { Buffer } from 'node:buffer';
import type { AppService, ConfigManager, Context, Logger, PluginModule } from '@aalis/core';
import type { ExecutionGuardContext, SafetyLevel, UserIdentity } from '@aalis/plugin-authority-api';
import type { CommandService } from '@aalis/plugin-commands-api';
import { useCommandService } from '@aalis/plugin-commands-api';
import { getPlatformNames } from '@aalis/plugin-platform-api';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';
import type {
  AuthorityService,
  AuthorityUserEntry,
  AuthorizeRequest,
  DangerousConfirmHandler,
  DangerousConfirmRequest,
  DangerousConfirmResult,
  DangerousGrant,
  UserCapabilityOverrides,
} from './types.js';

export type {
  AuthorityService,
  DangerousConfirmHandler,
  DangerousConfirmRequest,
  DangerousConfirmResult,
  DangerousGrant,
  DangerousGrantRequest,
} from './types.js';

// ===== AuthorityManager 实现 =====

/**
 * users.json 中的单用户记录（v2 格式）。
 *
 * - level：角色链等级（缺省回退 defaultAuthority）
 * - grants/denies：capability 个别授予/拒绝（glob），裁决优先级 deny > grant > 角色链
 * - secret：密码凭据 `pbkdf2:<iterations>:<saltHex>:<hashHex>`（存在即为可登录账户）
 * - links：本账户绑定的平台身份键（如 "onebot:12345"；仅主账户有，被绑身份
 *   的原记录原样留底、运行时被解析遮蔽，解绑即还原）
 */
interface UserRecord {
  level?: number;
  grants?: string[];
  denies?: string[];
  secret?: string;
  links?: string[];
}

/** 待消费的绑定码（内存态，进程重启即失效） */
interface PendingBindCode {
  /** 发起账户键（webui:<username>） */
  account: string;
  expiresAt: number;
}

const BIND_CODE_TTL_MS = 5 * 60 * 1000;
// 8 位、去易混淆字符（0O1IL）的码空间 ≈ 31^8 ≈ 8.5e11，无需额外限流
const BIND_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateBindCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (const b of bytes) code += BIND_CODE_ALPHABET[b % BIND_CODE_ALPHABET.length];
  return code;
}

// 密码哈希：Web Crypto PBKDF2-SHA256（迭代数随凭据存储，便于将来上调不破坏旧凭据）
const PBKDF2_ITERATIONS = 310_000;

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

export class AuthorityManager implements AuthorityService {
  private users = new Map<string, UserRecord>();
  /** 反向绑定索引：被绑平台身份键 → 主账户键（从 users[].links 重建） */
  private linkIndex = new Map<string, string>();
  /** 待消费绑定码（内存态） */
  private bindCodes = new Map<string, PendingBindCode>();
  private config: ConfigManager;
  private logger: Logger;
  private storage: StorageService;
  private fileUri: string;
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();
  private confirmHandlers = new Map<string, DangerousConfirmHandler>();
  private dangerousGrants = new Map<string, DangerousGrant>();
  private grantSeq = 0;
  /**
   * dangerous 策略的开启时间（运行时状态，不序列化到 config）。
   * 进程重启后重置为 null，对限时策略而言等同于「重启即失效」。
   */
  private dangerousEnabledAt: number | null = null;

  constructor(config: ConfigManager, logger: Logger, storage: StorageService) {
    this.config = config;
    this.logger = logger.child('authority');
    this.storage = storage;
    this.fileUri = 'data:/users.json';
  }

  getAuthority(platform: string, userId?: string): number {
    if (!userId) return this.config.get('defaultAuthority') ?? 1;
    if ((platform === 'webui' || platform === 'cli') && userId === 'console') {
      return this.config.get('ownerAuthority') ?? 5;
    }
    const owners = this.config.get('owners') ?? [];
    if (owners.some((o: UserIdentity) => o.platform === platform && o.userId === userId)) {
      return this.config.get('ownerAuthority') ?? 5;
    }
    // 被绑身份解析到主账户（零合并单一真源）。递归至多一层：linkIndex 的
    // 键只会是外部平台身份（consumeBindCode 拒绝 webui/cli），值是 webui 账户。
    const linked = this.linkIndex.get(`${platform}:${userId}`);
    if (linked) {
      const idx = linked.indexOf(':');
      return this.getAuthority(linked.slice(0, idx), linked.slice(idx + 1));
    }
    return this.users.get(`${platform}:${userId}`)?.level ?? this.config.get('defaultAuthority') ?? 1;
  }

  setAuthority(platform: string, userId: string, level: number): void {
    const key = `${platform}:${userId}`;
    this.users.set(key, { ...this.users.get(key), level });
    this.dirty = true;
    this.logger.debug(`设置用户权限: ${key} → ${level}`);
  }

  removeUser(platform: string, userId: string): void {
    if (this.users.delete(`${platform}:${userId}`)) {
      this.dirty = true;
      this.rebuildLinkIndex();
      this.logger.debug(`删除用户权限记录: ${platform}:${userId}`);
    }
  }

  // ── 跨平台身份绑定 ──────────────────────────────────────

  /** 从 users[].links 重建反向索引（表很小，全量重建即可） */
  private rebuildLinkIndex(): void {
    this.linkIndex.clear();
    for (const [key, record] of this.users) {
      for (const linked of record.links ?? []) this.linkIndex.set(linked, key);
    }
  }

  createBindCode(platform: string, userId: string): { code: string; expiresAt: number } {
    if (platform !== 'webui') throw new Error('绑定码只能由 WebUI 主账户发起');
    const account = `${platform}:${userId}`;
    // 同账户重新生成作废旧码；顺手清理过期码
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
    // 绑时一次性合并（运行时零合并的前提）：等级取 max、grants/denies 并集
    // 写入账户；平台身份原记录原样留底，解绑即还原。
    const identityRecord = this.users.get(identityKey);
    if (identityRecord) {
      if (identityRecord.level !== undefined && identityRecord.level > (accountRecord.level ?? 0)) {
        accountRecord.level = identityRecord.level;
      }
      const union = (a?: string[], b?: string[]): string[] | undefined => {
        const merged = [...new Set([...(a ?? []), ...(b ?? [])])];
        return merged.length > 0 ? merged : undefined;
      };
      accountRecord.grants = union(accountRecord.grants, identityRecord.grants);
      accountRecord.denies = union(accountRecord.denies, identityRecord.denies);
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

  setUserCapabilities(platform: string, userId: string, overrides: UserCapabilityOverrides): void {
    const key = `${platform}:${userId}`;
    const normalize = (list?: string[]): string[] | undefined => {
      const cleaned = [...new Set((list ?? []).map(p => p.trim()).filter(Boolean))];
      return cleaned.length > 0 ? cleaned : undefined;
    };
    const next: UserRecord = {
      ...this.users.get(key),
      grants: normalize(overrides.grants),
      denies: normalize(overrides.denies),
    };
    if (next.level === undefined && !next.grants && !next.denies && !next.secret && !next.links) {
      this.users.delete(key);
    } else {
      this.users.set(key, next);
    }
    this.dirty = true;
    this.logger.debug(
      `设置用户 capability 覆盖: ${key} grants=${next.grants?.length ?? 0} denies=${next.denies?.length ?? 0}`,
    );
  }

  /**
   * capability 中心统一闸。裁决优先级（per-capability）：
   * 全局 permissionPolicy > 用户 deny > 用户 grant > 角色链等级门槛。
   *
   * 等级门槛 = max(declaredAuthority, requiredAuthorityFor([cap]))——
   * 即"操作声明的基础等级"与"capability 归属角色包"取较高者，只升不降。
   */
  authorize(identity: { platform: string; userId?: string }, request: AuthorizeRequest): string | null {
    const level = this.getAuthority(identity.platform, identity.userId);
    const declared = request.declaredAuthority ?? 0;
    if (request.capabilities.length === 0) {
      if (level < declared) return `权限不足: 需要权限等级 ${declared}，当前用户等级 ${level}`;
      return null;
    }
    const policyDenied = this.checkPermissionPolicy(request.capabilities);
    if (policyDenied) return policyDenied;
    // 被绑身份零合并解析：grants 以主账户为唯一真源；denies 取自身∪账户并集
    // （自身记录的 deny 在绑定后仍生效——防"绑定洗白封禁"）。
    const ownKey = identity.userId ? `${identity.platform}:${identity.userId}` : undefined;
    const ownRecord = ownKey ? this.users.get(ownKey) : undefined;
    const accountKey = ownKey ? this.linkIndex.get(ownKey) : undefined;
    const accountRecord = accountKey ? this.users.get(accountKey) : undefined;
    const grants = accountKey ? accountRecord?.grants : ownRecord?.grants;
    const denies = [...(ownRecord?.denies ?? []), ...(accountRecord?.denies ?? [])];
    for (const cap of request.capabilities) {
      if (denies.length > 0 && this.matchAny(denies, [cap])) {
        return `已被禁止: ${cap}`;
      }
      if (grants && this.matchAny(grants, [cap])) continue;
      const required = Math.max(declared, this.requiredAuthorityFor([cap]));
      if (level < required) {
        return `权限不足: "${cap}" 需要权限等级 ${required}，当前用户等级 ${level}`;
      }
    }
    return null;
  }

  isDangerousAllowed(name: string, permissions: string[] = []): boolean {
    const policy = this.config.get('dangerousPolicy');
    if (!policy?.allow || policy.allow.length === 0) return false;
    // 有限时策略时检查过期；未记录 enabledAt 视为未启用（重启后自动失效）
    if (policy.duration && policy.duration > 0) {
      if (!this.dangerousEnabledAt) return false;
      const elapsed = (Date.now() - this.dangerousEnabledAt) / 1000;
      if (elapsed > policy.duration) {
        this.logger.info('dangerous 白名单已过期');
        return false;
      }
    }
    return this.matchAny(policy.allow, [name, ...permissions]);
  }

  /** 刷新 dangerous 策略启动时间戳（运行时状态） */
  markDangerousEnabled(): void {
    this.dangerousEnabledAt = Date.now();
  }

  /** 清除 dangerous 策略启动时间戳 */
  clearDangerousEnabled(): void {
    this.dangerousEnabledAt = null;
  }

  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void {
    this.confirmHandlers.set(platform, handler);
  }

  async confirmDangerous(request: DangerousConfirmRequest): Promise<boolean> {
    if (this.isDangerousAllowed(request.name, request.permissions)) return true;
    const grant = this.consumeDangerousGrant(request);
    if (grant) {
      this.logger.info(
        `命中高危会话授权: ${request.type}:${request.name} session=${request.sessionId} grant=${grant.id} used=${grant.used}${grant.maxUses ? `/${grant.maxUses}` : ''}`,
      );
      return true;
    }
    const handler = this.confirmHandlers.get(request.platform);
    if (handler) {
      try {
        const result = await handler(request);
        const normalized = this.normalizeConfirmResult(result);
        if (normalized.allowed && normalized.grant?.scope === 'session') {
          this.createDangerousGrant(request, normalized);
        }
        return normalized.allowed;
      } catch (err) {
        this.logger.warn(`高危确认回调异常: ${err}`);
        return false;
      }
    }
    return false;
  }

  /**
   * 计算一组细粒度权限所要求的最低权限等级（参数级动态提权）。
   *
   * 例如 file_write 写普通文件只需声明的 authority:3，但写 data:/users.json
   * （用户权限表）或 data:/scheduler-jobs.json（计划任务，可注入 owner 身份的
   * actor）这类敏感文件、或写 aalis:/ 源码根（重启后即任意代码执行）时要求
   * owner 等级，防止低权限用户借文件写入自我提权。
   *
   * 默认保护清单可被 config.permissionAuthority 覆盖/扩展（同模式取配置值，
   * 新模式叠加；命中多个模式时取最大要求）。只提高门槛，不降低声明值。
   */
  /** 参数级提权完整清单（内置保护 + config.permissionAuthority 合并后；展示与裁决共用同一真源） */
  getEscalationMap(): Record<string, number> {
    const ownerLevel = this.config.get('ownerAuthority') ?? 5;
    return {
      'storage:path:data:/users.json:write': ownerLevel,
      'storage:path:data:/users.json:delete': ownerLevel,
      'storage:path:data:/scheduler-jobs.json:write': ownerLevel,
      'storage:path:data:/scheduler-jobs.json:delete': ownerLevel,
      'storage:aalis:write': ownerLevel,
      'storage:aalis:delete': ownerLevel,
      ...(this.config.get('permissionAuthority') ?? {}),
    };
  }

  requiredAuthorityFor(permissions: string[]): number {
    if (permissions.length === 0) return 0;
    let required = 0;
    for (const [pattern, level] of Object.entries(this.getEscalationMap())) {
      if (level > required && this.matchAny([pattern], permissions)) required = level;
    }
    return required;
  }

  checkPermissionPolicy(permissions: string[]): string | null {
    const policy = this.config.get('permissionPolicy') as { allow?: string[]; deny?: string[] } | undefined;
    if (!policy) return null;
    const deny = policy.deny ?? [];
    if (deny.length > 0 && this.matchAny(deny, permissions)) {
      return `权限策略拒绝: ${permissions.join(', ')}`;
    }
    const allow = policy.allow ?? [];
    if (allow.length > 0 && !this.matchAny(allow, permissions)) {
      return `权限策略未允许: ${permissions.join(', ')}`;
    }
    return null;
  }

  private matchAny(patterns: string[], values: string[]): boolean {
    return patterns.some(pattern => values.some(value => this.matchPattern(pattern, value)));
  }

  private matchPattern(pattern: string, value: string): boolean {
    if (pattern === '*' || pattern === value) return true;
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(value);
  }

  listDangerousGrants(): DangerousGrant[] {
    this.pruneDangerousGrants();
    return [...this.dangerousGrants.values()].map(grant => ({ ...grant }));
  }

  revokeDangerousGrant(id: string): boolean {
    const ok = this.dangerousGrants.delete(id);
    if (ok) this.logger.info(`已撤销高危会话授权: ${id}`);
    return ok;
  }

  private normalizeConfirmResult(result: boolean | DangerousConfirmResult): DangerousConfirmResult {
    return typeof result === 'boolean' ? { allowed: result } : result;
  }

  private consumeDangerousGrant(request: DangerousConfirmRequest): DangerousGrant | undefined {
    this.pruneDangerousGrants();
    for (const grant of this.dangerousGrants.values()) {
      if (grant.type !== request.type) continue;
      if (grant.name !== request.name) continue;
      if (grant.sessionId !== request.sessionId) continue;
      if (grant.platform !== request.platform) continue;
      if (grant.userId && request.userId && grant.userId !== request.userId) continue;
      if (!this.samePermissions(grant.permissions, request.permissions)) continue;
      grant.used++;
      if (grant.maxUses && grant.used >= grant.maxUses) {
        this.dangerousGrants.delete(grant.id);
      }
      return grant;
    }
    return undefined;
  }

  private createDangerousGrant(request: DangerousConfirmRequest, result: DangerousConfirmResult): void {
    const grantRequest = result.grant;
    if (!grantRequest || grantRequest.scope !== 'session') return;
    // 创建新授权时顺带清扫过期/用尽的（对称 bindCodes 的发码即清扫——审计 MEDIUM #11）
    this.pruneDangerousGrants();
    const durationSeconds = Math.max(1, Math.min(grantRequest.durationSeconds ?? 600, 3600));
    const grant: DangerousGrant = {
      id: `grant_${Date.now()}_${++this.grantSeq}`,
      name: request.name,
      type: request.type,
      permissions: request.permissions,
      sessionId: request.sessionId,
      platform: request.platform,
      userId: request.userId,
      expiresAt: Date.now() + durationSeconds * 1000,
      maxUses: grantRequest.maxUses,
      used: 0,
      createdAt: Date.now(),
    };
    this.dangerousGrants.set(grant.id, grant);
    this.logger.info(
      `创建高危会话授权: ${request.type}:${request.name} session=${request.sessionId} duration=${durationSeconds}s maxUses=${grant.maxUses ?? 'unlimited'} grant=${grant.id}`,
    );
  }

  private pruneDangerousGrants(): void {
    const now = Date.now();
    for (const [id, grant] of this.dangerousGrants) {
      if (grant.expiresAt <= now || (grant.maxUses && grant.used >= grant.maxUses)) {
        this.dangerousGrants.delete(id);
        this.logger.debug(`高危会话授权已过期: ${id}`);
      }
    }
  }

  private samePermissions(a: string[] | undefined, b: string[] | undefined): boolean {
    const left = [...new Set(a ?? [])].sort();
    const right = [...new Set(b ?? [])].sort();
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  isOwner(platform: string, userId?: string): boolean {
    if (!userId) return false;
    if ((platform === 'webui' || platform === 'cli') && userId === 'console') return true;
    const owners = this.config.get('owners') ?? [];
    return owners.some((o: UserIdentity) => o.platform === platform && o.userId === userId);
  }

  listUsers(): AuthorityUserEntry[] {
    const result: AuthorityUserEntry[] = [];
    const defaultLevel = this.config.get('defaultAuthority') ?? 1;
    for (const [key, record] of this.users) {
      const idx = key.indexOf(':');
      const platform = key.slice(0, idx);
      const userId = key.slice(idx + 1);
      const linkedTo = this.linkIndex.get(key);
      result.push({
        platform,
        userId,
        // 被绑身份显示运行时有效等级（解析到主账户）；自身记录被遮蔽留底
        authority: linkedTo ? this.getAuthority(platform, userId) : (record.level ?? defaultLevel),
        grants: record.grants,
        denies: record.denies,
        hasPassword: record.secret ? true : undefined,
        links: record.links,
        linkedTo,
      });
    }
    // 无自身记录的被绑身份也要可见（绑定关系本身就是一条用户事实）
    for (const [identityKey, accountKey] of this.linkIndex) {
      if (this.users.has(identityKey)) continue;
      const idx = identityKey.indexOf(':');
      const platform = identityKey.slice(0, idx);
      const userId = identityKey.slice(idx + 1);
      result.push({ platform, userId, authority: this.getAuthority(platform, userId), linkedTo: accountKey });
    }
    return result;
  }

  save(): void {
    if (!this.dirty) return;
    const users: Record<string, UserRecord> = {};
    for (const [key, record] of this.users) users[key] = record;
    const payload = JSON.stringify({ version: 2, users }, null, 2);
    this.dirty = false;
    this.saveChain = this.saveChain
      .then(() => this.storage.writeFile(this.fileUri, payload))
      .then(
        () => {
          this.logger.debug('用户权限数据已保存');
        },
        err => {
          this.logger.warn(`保存用户权限数据失败: ${err}`);
          this.dirty = true;
        },
      );
  }

  async init(): Promise<void> {
    try {
      let raw: string;
      try {
        raw = (await this.storage.readFile(this.fileUri, 'utf-8')) as string;
      } catch {
        return;
      }
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data.version === 2 && typeof data.users === 'object' && data.users !== null) {
        for (const [key, record] of Object.entries(data.users as Record<string, UserRecord>)) {
          if (record && typeof record === 'object') this.users.set(key, record);
        }
      } else {
        // v1 平面格式（{"platform:userId": level}）：就地迁移，下次 save 写 v2
        for (const [key, level] of Object.entries(data)) {
          if (typeof level === 'number') this.users.set(key, { level });
        }
        if (this.users.size > 0) {
          this.dirty = true;
          this.logger.info(`users.json v1 → v2 迁移：${this.users.size} 条记录`);
        }
      }
      this.rebuildLinkIndex();
      this.logger.debug(`加载了 ${this.users.size} 条用户权限记录（绑定 ${this.linkIndex.size} 条）`);
    } catch (err) {
      this.logger.warn(`加载用户权限数据失败: ${err}`);
    }
  }
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-authority';
export const displayName = '权限管理';
export const subsystem = 'authority';
export const provides = ['authority'];
export const inject = {
  optional: ['commands', 'tools'],
};

const webuiPages: WebuiPage[] = [
  { key: 'authority', label: '权限管理', icon: 'authority', order: 50, renderer: 'authority' },
  {
    key: 'authority-graph',
    label: '权限图',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><circle cx="12" cy="10" r="1.6"/><circle cx="8.5" cy="14.5" r="1.3"/><circle cx="15.5" cy="14.5" r="1.3"/><line x1="12" y1="11.5" x2="8.5" y2="13.3"/><line x1="12" y1="11.5" x2="15.5" y2="13.3"/></svg>',
    order: 51,
    content: [
      {
        type: 'graph',
        label: '权限依赖图：用户 → 角色链 ← capability / 指令 / 工具（点击节点查看详情）',
        source: 'getPermissionGraph',
        detailSource: 'getPermissionNode',
        defaultMaxDepth: 2,
        defaultMaxBreadth: 30,
        refresh: 0,
        // 权限图自有图例（声明后组件不再用人物关系图的 person/event/entity 语义）
        nodeKinds: [
          { kind: 'user', label: '用户', shape: 'circle', color: '#60a5fa' },
          { kind: 'role', label: '角色（等级）', shape: 'round-rect', color: '#f59e0b' },
          { kind: 'capability', label: 'capability', shape: 'diamond', color: '#34d399' },
          { kind: 'command', label: '指令', shape: 'round-rect', color: '#a855f7' },
          { kind: 'tool', label: '工具', shape: 'round-rect', color: '#06b6d4' },
        ],
        edgeKinds: [
          { kind: 'inherit', label: '继承', color: '#f59e0b' },
          { kind: 'level', label: '等级归属', color: '#60a5fa' },
          { kind: 'bind', label: '绑定', color: '#f472b6', dashed: true },
          { kind: 'grant', label: '授予', color: '#34d399', dashed: true },
          { kind: 'deny', label: '拒绝', color: '#ef4444' },
          { kind: 'escalation', label: '提权要求', color: '#ef4444', dashed: true },
          { kind: 'belongs', label: '归入角色包', color: '#6b7280' },
        ],
      },
    ],
  },
];

// ===== 插件入口 =====

export async function apply(ctx: Context, _config: Record<string, unknown>): Promise<void> {
  // 注册 WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  const cmds = useCommandService(ctx);
  const storage = createStorageGateway(ctx);
  const authority = new AuthorityManager(ctx.config, ctx.logger, storage);
  await authority.init();
  ctx.provide('authority', authority);

  // ===== 向 tools/commands 注入执行守卫 =====

  const guard = async (guardCtx: ExecutionGuardContext): Promise<string | null> => {
    // ExecutionGuard 是 tool/command surface 的适配器：等级门槛、参数级提权、
    // 全局策略与用户 grant/deny 全部收进 authorize 统一闸；dangerous 确认是
    // 交互流程（弹窗/会话授权），保留在适配器层。
    const capabilities = guardCtx.permissions?.length ? guardCtx.permissions : [`${guardCtx.type}:${guardCtx.name}`];
    const denied = authority.authorize(
      { platform: guardCtx.platform, userId: guardCtx.userId },
      { capabilities, declaredAuthority: guardCtx.authority },
    );
    if (denied) return denied;
    if (guardCtx.safety === 'dangerous' && !guardCtx.skipSafetyCheck) {
      const confirmed = await authority.confirmDangerous({
        name: guardCtx.name,
        type: guardCtx.type,
        args: guardCtx.args,
        permissions: guardCtx.permissions,
        sessionId: guardCtx.sessionId,
        platform: guardCtx.platform,
        userId: guardCtx.userId,
      });
      if (!confirmed) {
        return `已取消执行${guardCtx.type === 'command' ? '指令' : '工具'} ${guardCtx.name}。`;
      }
    }
    return null;
  };

  // 注入到 commands / tools 服务。whenService 会在 provider 上线（含 bounce 后
  // 重新 provide）时各调一次，自动覆盖"authority 早于 provider"和"provider 重启"两种场景。
  ctx.whenService<CommandService>('commands', svc => {
    if (svc.setExecutionGuard) {
      svc.setExecutionGuard(guard);
      ctx.logger.debug('权限守卫已注入: commands');
    }
  });
  ctx.whenService<ToolService>('tools', svc => {
    if (svc.setExecutionGuard) {
      svc.setExecutionGuard(guard);
      ctx.logger.debug('权限守卫已注入: tools');
    }
    const toolOvr = ctx.config.get('toolOverrides');
    if (toolOvr && svc.loadOverrides) {
      svc.loadOverrides(toolOvr as Record<string, { authority?: number; safety?: SafetyLevel }>);
    }
  });

  // ===== 应用停止时保存 =====
  ctx.on('app:stopping', () => {
    authority.save();
  });

  // ===== 权限指令 =====

  // /grant — 设置用户权限等级
  cmds
    .command('grant <target:string> <level:number>', '设置用户权限等级', { authority: 2 })
    .example('/grant onebot:12345 2')
    .action(async (argv, target, level) => {
      const t = target as string;
      const lvl = level as number;
      if (Number.isNaN(lvl) || lvl < 0) return '权限等级必须是非负整数。';
      const callerAuth = authority.getAuthority(argv.session.platform, argv.session.userId);
      if (lvl >= callerAuth) return `不能将权限设置为 >= 您自身的等级 (${callerAuth})。`;
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>，例如 onebot:12345';
      const platform = t.slice(0, sep);
      const userId = t.slice(sep + 1);
      authority.setAuthority(platform, userId, lvl);
      authority.save();
      return `已将 ${t} 的权限等级设置为 ${lvl}。`;
    });

  // /authority — 查看权限等级 + 个别授予/拒绝 + 绑定关系
  const describeIdentity = (platform: string, userId: string | undefined, self: boolean): string => {
    const level = authority.getAuthority(platform, userId);
    const isOwner = authority.isOwner(platform, userId);
    const lines = [`${self ? '您' : `${platform}:${userId}`}的权限等级: ${level}${isOwner ? ' (owner)' : ''}`];
    const entry = userId ? authority.listUsers().find(u => u.platform === platform && u.userId === userId) : undefined;
    if (entry?.linkedTo) lines.push(`已绑定到主账户 ${entry.linkedTo}（权限以账户为准）`);
    if (entry?.links?.length) lines.push(`已绑定身份: ${entry.links.join(', ')}`);
    if (entry?.grants?.length) lines.push(`个别授予: ${entry.grants.join(', ')}`);
    if (entry?.denies?.length) lines.push(`个别拒绝: ${entry.denies.join(', ')}`);
    return lines.join('\n');
  };
  cmds.command('authority [target:string]', '查看自己或指定用户的权限等级与授予').action(async (argv, target) => {
    const t = target as string | undefined;
    if (t) {
      const sep = t.indexOf(':');
      if (sep < 1) return '目标格式: <platform:userId>';
      return describeIdentity(t.slice(0, sep), t.slice(sep + 1), false);
    }
    return describeIdentity(argv.session.platform, argv.session.userId, true);
  });

  // /bind — 把当前平台账号绑定到 WebUI 主账户（码在 WebUI 权限页生成）。
  // 仅限私聊：群聊发码会把绑定码暴露给旁观者；公开信道（群聊）安全性弱，
  // 故直接限定私聊信道完成绑定握手。
  cmds
    .command('bind <code:string>', '将当前平台账号绑定到 WebUI 账户', { authority: 1 })
    .example('/bind AB12CD34')
    .action(async (argv, code) => {
      const { platform, userId, sessionType } = argv.session;
      if (!userId) return '无法识别您的身份，无法绑定。';
      if (platform === 'webui' || platform === 'cli') {
        return '请在外部平台（如 QQ）私聊中向机器人发送本指令。';
      }
      if (sessionType !== 'private') {
        return '为防止绑定码泄露，请在私聊中使用本指令。';
      }
      try {
        const account = authority.consumeBindCode(String(code).trim().toUpperCase(), { platform, userId });
        authority.save();
        return `绑定成功：${platform}:${userId} ↔ ${account.platform}:${account.userId}。您现在以该账户的权限行事，可在 WebUI 权限页解绑。`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    });
}

// ===== WebUI 操作处理器 =====

export const actions: PluginModule['actions'] = {
  /** 获取权限概览 */
  async getOverview(ctx) {
    const auth = ctx.getService<AuthorityService>('authority');
    const users = auth?.listUsers() ?? [];
    const owners: Array<{ platform: string; userId: string }> = ctx.config.get('owners') ?? [];
    const overrides = ctx.getService<CommandService>('commands')?.getOverrides() ?? {};
    // 扁平化所有指令节点，按 dot 名顺序排列，便于 UI 表格渲染
    const cmdNodes = ctx.getService<CommandService>('commands')?.getAll() ?? [];
    const commandPrefix = ctx.getService<CommandService>('commands')?.prefix ?? '/';
    const cmdNames = new Set(cmdNodes.map(n => n.name));
    const tools = ctx.getService<ToolService>('tools')?.getAll() ?? [];
    // 平台候选（WebUI 下拉用）：身份系统的平台名 = 消息上的 platform 字段。
    // 取 adapter.platform（getPlatformNames）而非服务提供者 contextId——后者是
    // 插件实例名（如 @aalis/plugin-adapter-onebot），按它设的权限永远不会命中
    // 任何真实调用者。webui/cli 是内置 surface，无 adapter，显式列入。
    const platforms = Array.from(
      new Set([
        ...getPlatformNames(ctx),
        'webui',
        'cli',
        ...users.map(u => u.platform),
        ...owners.map(o => o.platform),
      ]),
    ).filter(Boolean);
    return {
      users,
      owners,
      platforms,
      defaultAuthority: ctx.config.get('defaultAuthority') ?? 1,
      ownerAuthority: ctx.config.get('ownerAuthority') ?? 5,
      dangerousPolicy: ctx.config.get('dangerousPolicy') ?? {},
      permissionPolicy: ctx.config.get('permissionPolicy') ?? {},
      // 参数级动态提权清单（glob→等级；内置保护清单见 requiredAuthorityFor 文档）
      permissionAuthority: ctx.config.get('permissionAuthority') ?? {},
      dangerousGrants: auth?.listDangerousGrants() ?? [],
      commandPrefix,
      commands: cmdNodes.map(n => {
        const path = n.name.split('.');
        const depth = path.length - 1;
        const hasSubcommands = cmdNodes.some(other => other.name.startsWith(`${n.name}.`));
        return {
          // key 同时是 override 的查找键与 setCommandOverride 的入参；如 'profile.clear.nuke'
          key: n.name,
          // 兼容旧前端：以 name 作 React key
          name: n.name,
          // 用于显示，如 '/profile clear nuke'
          displayName: `${commandPrefix}${path.join(' ')}`,
          // 叶子段名（'nuke'）用于子行紧凑显示
          leafName: path[path.length - 1],
          path,
          depth,
          isRoot: depth === 0,
          hasSubcommands,
          hasAction: !!n.handler,
          description: n.description,
          authority: n.authority,
          safety: n.safety,
          permissions: n.permissions,
          baseAuthority: n.baseAuthority,
          baseSafety: n.baseSafety,
          basePermissions: n.basePermissions,
          overridden: n.overridden,
          pluginName: n.pluginName,
        };
      }),
      commandOverrides: overrides,
      orphanCommandOverrides: Object.keys(overrides).filter(k => !cmdNames.has(k)),
      tools,
      toolOverrides: ctx.getService<ToolService>('tools')?.getOverrides?.() ?? {},
    };
  },

  /** 设置用户权限等级 */
  async setUser(ctx, args, caller) {
    const { platform, userId, authority } = args;
    if (!platform || !userId || typeof authority !== 'number') {
      throw new Error('platform, userId, authority(number) 必填');
    }
    if (authority < 0) throw new Error('权限等级必须 >= 0');
    const auth = ctx.getService<AuthorityService>('authority');
    // 与 /grant 指令同语义的防越权检查：不能把任何人设到 >= 自身等级
    // （caller 为登录账户的真实身份；单 token 模式为 webui:console=owner）。
    if (caller && auth) {
      const callerLevel = auth.getAuthority(caller.platform, caller.userId);
      if (authority >= callerLevel) {
        throw new Error(`不能将权限设置为 >= 您自身的等级 (${callerLevel})`);
      }
    }
    auth?.setAuthority(platform as string, userId as string, authority);
    auth?.save();
    return { message: `${platform}:${userId} 权限已设为 ${authority}` };
  },

  /** 设置用户的 capability 个别授予/拒绝（deny > grant > 角色链） */
  async setUserCapabilities(ctx, args, caller) {
    const { platform, userId, grants, denies } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    const asList = (v: unknown, label: string): string[] | undefined => {
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${label} 必须是字符串数组`);
      return v as string[];
    };
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    // 防越权：不能改动等级 >= 自身的用户（与 setUser 同思路；改授予=改实际权力）
    if (caller) {
      const callerLevel = auth.getAuthority(caller.platform, caller.userId);
      const targetLevel = auth.getAuthority(platform as string, userId as string);
      const isSelf = caller.platform === platform && caller.userId === userId;
      if (!isSelf && targetLevel >= callerLevel) {
        throw new Error(`不能修改等级 >= 您自身 (${callerLevel}) 的用户的 capability 授予`);
      }
    }
    auth.setUserCapabilities(platform as string, userId as string, {
      grants: asList(grants, 'grants'),
      denies: asList(denies, 'denies'),
    });
    auth.save();
    return { message: `${platform}:${userId} 的 capability 授予已更新` };
  },

  /** 设置/重置账户密码（webui 登录凭据；仅本人或更高等级者可操作） */
  async setPassword(ctx, args, caller) {
    const { platform, userId, password } = args;
    if (!platform || !userId || typeof password !== 'string') throw new Error('platform, userId, password 必填');
    if (password.length < 6) throw new Error('密码长度至少 6 位');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    if (caller) {
      const callerLevel = auth.getAuthority(caller.platform, caller.userId);
      const targetLevel = auth.getAuthority(platform as string, userId as string);
      const isSelf = caller.platform === platform && caller.userId === userId;
      if (!isSelf && targetLevel >= callerLevel) {
        throw new Error(`不能为等级 >= 您自身 (${callerLevel}) 的用户设置密码`);
      }
    }
    await auth.setPassword(platform as string, userId as string, password);
    auth.save();
    return { message: `${platform}:${userId} 密码已更新` };
  },

  /** 权限依赖图（graph 组件数据源）：用户 → 角色链 ← capability / 指令 / 工具 */
  async getPermissionGraph(ctx) {
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    const ownerLevel: number = ctx.config.get('ownerAuthority') ?? 5;
    const clamp = (n: number): number => Math.max(0, Math.min(ownerLevel, Math.round(n)));
    const nodes: Array<{ data: Record<string, unknown> }> = [];
    const edges: Array<{ data: Record<string, unknown> }> = [];

    // 角色链（kind=role：圆角矩形；尺寸随等级增大）
    for (let n = 0; n <= ownerLevel; n++) {
      nodes.push({
        data: {
          id: `role:${n}`,
          label: n === ownerLevel ? `owner (${n})` : `等级 ${n}`,
          kind: 'role',
          pageRankScale: 0.35 + (0.65 * n) / ownerLevel,
        },
      });
      if (n > 0) {
        edges.push({
          data: {
            id: `inherit:${n}`,
            source: `role:${n}`,
            target: `role:${n - 1}`,
            label: '继承',
            kind: 'inherit',
            directed: true,
          },
        });
      }
    }

    // capability 节点（kind=capability：菱形），按模式去重
    const capIds = new Set<string>();
    const capNode = (pattern: string): string => {
      if (!capIds.has(pattern)) {
        capIds.add(pattern);
        nodes.push({ data: { id: `cap:${pattern}`, label: pattern, kind: 'capability', pageRankScale: 0.3 } });
      }
      return `cap:${pattern}`;
    };

    // 用户（users.json + owners 配置 + 单 token 模式的 console）
    const users = auth.listUsers();
    const owners: UserIdentity[] = ctx.config.get('owners') ?? [];
    const userIds = new Set<string>();
    const userNode = (platform: string, userId: string): string => {
      const key = `${platform}:${userId}`;
      if (!userIds.has(key)) {
        userIds.add(key);
        nodes.push({ data: { id: `user:${key}`, label: key, kind: 'user', pageRankScale: 0.55 } });
      }
      return `user:${key}`;
    };
    for (const u of users) {
      const id = userNode(u.platform, u.userId);
      if (u.linkedTo) {
        // 被绑身份：权限随主账户走，只画绑定边（等级边由账户承担）
        const idx = u.linkedTo.indexOf(':');
        edges.push({
          data: {
            id: `bind:${u.platform}:${u.userId}`,
            source: id,
            target: userNode(u.linkedTo.slice(0, idx), u.linkedTo.slice(idx + 1)),
            label: '绑定',
            kind: 'bind',
            directed: true,
          },
        });
      } else {
        edges.push({
          data: {
            id: `lvl:${u.platform}:${u.userId}`,
            source: id,
            target: `role:${clamp(u.authority)}`,
            label: '等级',
            kind: 'level',
            directed: true,
          },
        });
      }
      for (const g of u.grants ?? []) {
        edges.push({
          data: {
            id: `grant:${u.platform}:${u.userId}:${g}`,
            source: id,
            target: capNode(g),
            label: '授予',
            kind: 'grant',
            directed: true,
          },
        });
      }
      for (const d of u.denies ?? []) {
        edges.push({
          data: {
            id: `deny:${u.platform}:${u.userId}:${d}`,
            source: id,
            target: capNode(d),
            label: '拒绝',
            kind: 'deny',
            directed: true,
          },
        });
      }
    }
    for (const o of owners) {
      edges.push({
        data: {
          id: `owner:${o.platform}:${o.userId}`,
          source: userNode(o.platform, o.userId),
          target: `role:${ownerLevel}`,
          label: 'owner',
          kind: 'level',
          directed: true,
        },
      });
    }
    edges.push({
      data: {
        id: 'console-owner',
        source: userNode('webui', 'console'),
        target: `role:${ownerLevel}`,
        label: '单 token/本地',
        kind: 'level',
        directed: true,
      },
    });

    // 参数级提权清单（内置保护 + 配置，与裁决同源）
    for (const [pattern, level] of Object.entries(auth.getEscalationMap())) {
      edges.push({
        data: {
          id: `esc:${pattern}`,
          source: capNode(pattern),
          target: `role:${clamp(level)}`,
          label: '需等级',
          kind: 'escalation',
          directed: true,
        },
      });
    }

    // 指令与工具（仅根指令控制规模）
    const cmds = (ctx.getService<CommandService>('commands')?.getAll() ?? []).filter(c => !c.name.includes('.'));
    for (const c of cmds) {
      nodes.push({
        data: {
          id: `cmd:${c.name}`,
          label: `/${c.name}${c.safety === 'dangerous' ? ' ⚠' : ''}`,
          kind: 'command',
          pageRankScale: 0.12,
        },
      });
      edges.push({
        data: {
          id: `cmd-lvl:${c.name}`,
          source: `cmd:${c.name}`,
          target: `role:${clamp(c.authority ?? 1)}`,
          label: '归入',
          kind: 'belongs',
          directed: true,
        },
      });
    }
    const toolDefs = ctx.getService<ToolService>('tools')?.getAll() ?? [];
    for (const t of toolDefs) {
      nodes.push({
        data: {
          id: `tool:${t.name}`,
          label: `${t.name}${t.safety === 'dangerous' ? ' ⚠' : ''}`,
          kind: 'tool',
          pageRankScale: 0.12,
        },
      });
      edges.push({
        data: {
          id: `tool-lvl:${t.name}`,
          source: `tool:${t.name}`,
          target: `role:${clamp(t.authority ?? 1)}`,
          label: '归入',
          kind: 'belongs',
          directed: true,
        },
      });
    }

    return {
      nodes,
      edges,
      stats: {
        用户: userIds.size,
        角色: ownerLevel + 1,
        指令根: cmds.length,
        工具: toolDefs.length,
        capability: capIds.size,
      },
    };
  },

  /** 权限图节点详情（graph 组件 detailSource） */
  async getPermissionNode(ctx, args) {
    const nodeId = String(args.nodeId ?? '');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    const ownerLevel: number = ctx.config.get('ownerAuthority') ?? 5;
    if (nodeId.startsWith('user:')) {
      const key = nodeId.slice(5);
      const idx = key.indexOf(':');
      const platform = key.slice(0, idx);
      const userId = key.slice(idx + 1);
      const entry = auth.listUsers().find(u => u.platform === platform && u.userId === userId);
      return {
        身份: key,
        有效等级: auth.getAuthority(platform, userId),
        owner: auth.isOwner(platform, userId) || undefined,
        可登录账户: entry?.hasPassword || undefined,
        绑定到: entry?.linkedTo,
        已绑身份: entry?.links?.join(', '),
        个别授予: entry?.grants?.join(', '),
        个别拒绝: entry?.denies?.join(', '),
      };
    }
    if (nodeId.startsWith('role:')) {
      const n = Number(nodeId.slice(5));
      const holders = auth.listUsers().filter(u => !u.linkedTo && u.authority === n).length;
      return {
        角色: n === ownerLevel ? `owner（等级 ${n}）` : `等级 ${n}`,
        语义: '内置角色链：高等级继承低等级的全部授予；capability 图为唯一裁决',
        显式持有用户数: holders,
      };
    }
    if (nodeId.startsWith('cap:')) {
      const pattern = nodeId.slice(4);
      const escalation = auth.getEscalationMap()[pattern];
      return {
        capability: pattern,
        提权要求: escalation !== undefined ? `等级 ${escalation}` : undefined,
        说明: 'glob 模式，按 PermissionId 匹配；裁决优先级 deny > grant > 角色链',
      };
    }
    if (nodeId.startsWith('cmd:')) {
      const cmdName = nodeId.slice(4);
      const c = ctx
        .getService<CommandService>('commands')
        ?.getAll()
        .find(x => x.name === cmdName);
      if (!c) return { error: `指令 ${cmdName} 不存在` };
      return {
        指令: `/${cmdName}`,
        描述: c.description,
        所需等级: c.authority,
        安全等级: c.safety,
        capability: c.permissions?.join(', '),
        来源插件: c.pluginName,
      };
    }
    if (nodeId.startsWith('tool:')) {
      const toolName = nodeId.slice(5);
      const t = ctx
        .getService<ToolService>('tools')
        ?.getAll()
        .find(x => x.name === toolName);
      if (!t) return { error: `工具 ${toolName} 不存在` };
      return {
        工具: toolName,
        描述: t.description,
        所需等级: t.authority ?? 1,
        安全等级: t.safety ?? 'safe',
        capability: t.permissions?.join(', '),
        来源插件: t.pluginName,
      };
    }
    return { error: `未知节点: ${nodeId}` };
  },

  /** 生成跨平台绑定码（绑定到调用者自己的账户；5 分钟内在外部平台私聊发 /bind <码>） */
  async createBindCode(ctx, _args, caller) {
    if (!caller) throw new Error('无法识别调用者身份');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    const { code, expiresAt } = auth.createBindCode(caller.platform, caller.userId);
    const prefix = ctx.getService<CommandService>('commands')?.prefix ?? '/';
    return {
      code,
      expiresAt,
      hint: `请在 5 分钟内，用要绑定的平台账号（如 QQ）私聊向机器人发送：${prefix}bind ${code}`,
    };
  },

  /** 解绑平台身份（owner 或该绑定所属账户本人） */
  async unlinkIdentity(ctx, args, caller) {
    const { platform, userId } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    if (caller) {
      const identityKey = `${platform}:${userId}`;
      const ownerLevel: number = ctx.config.get('ownerAuthority') ?? 5;
      const callerLevel = auth.getAuthority(caller.platform, caller.userId);
      const owningAccount = auth.listUsers().find(u => u.links?.includes(identityKey));
      const isSelf =
        owningAccount && owningAccount.platform === caller.platform && owningAccount.userId === caller.userId;
      if (!isSelf && callerLevel < ownerLevel) {
        throw new Error('只有绑定所属账户本人或 owner 可以解绑');
      }
    }
    const ok = auth.unlinkIdentity(platform as string, userId as string);
    auth.save();
    return { ok, message: ok ? `${platform}:${userId} 已解绑` : '该身份没有绑定记录' };
  },

  /** 删除用户权限记录（等级回退默认，grants/denies/密码一并清除） */
  async deleteUser(ctx, args) {
    const { platform, userId } = args;
    if (!platform || !userId) throw new Error('platform, userId 必填');
    const auth = ctx.getService<AuthorityService>('authority');
    auth?.removeUser(platform as string, userId as string);
    auth?.save();
    return { message: `${platform}:${userId} 权限已重置` };
  },

  /** 更新 owner 列表 */
  async setOwners(ctx, args) {
    const owners = args.owners;
    if (!Array.isArray(owners)) throw new Error('owners 必须是数组');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    ctx.config.set('owners', owners);
    app.saveConfig();
    return { message: 'Owner 列表已更新' };
  },

  /** 更新 dangerousPolicy */
  async setDangerousPolicy(ctx, args) {
    const policy = args.policy as Record<string, unknown>;
    if (!policy || typeof policy !== 'object') throw new Error('policy 必须是对象');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    ctx.config.set('dangerousPolicy', policy);
    app.saveConfig();
    // 启用限时策略时，标记运行时启动时间戳（不写入 config）
    if (Array.isArray(policy.allow) && policy.allow.length > 0) {
      const auth = ctx.getService<AuthorityService>('authority');
      (auth as unknown as { markDangerousEnabled?: () => void } | undefined)?.markDangerousEnabled?.();
    }
    return { message: '高危策略已更新' };
  },

  /** 撤销一个高危会话授权 */
  async revokeDangerousGrant(ctx, args) {
    const id = args.id as string;
    if (!id) throw new Error('id 必须是字符串');
    const auth = ctx.getService<AuthorityService>('authority');
    if (!auth) throw new Error('Authority 服务不可用');
    const ok = auth.revokeDangerousGrant(id);
    return { ok, message: ok ? '授权已撤销' : '授权不存在或已过期' };
  },

  /** 更新全局权限配置（defaultAuthority, ownerAuthority） */
  async setConfig(ctx, args) {
    const { defaultAuthority, ownerAuthority } = args;
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    if (typeof defaultAuthority === 'number') ctx.config.set('defaultAuthority', defaultAuthority);
    if (typeof ownerAuthority === 'number') ctx.config.set('ownerAuthority', ownerAuthority);
    app.saveConfig();
    return { message: '权限配置已更新' };
  },

  /** 更新单条指令的权限覆盖 */
  async setCommandOverride(ctx, args) {
    const { name, authority, safety } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    const override: { authority?: number; safety?: SafetyLevel } = {};
    if (typeof authority === 'number') override.authority = authority;
    if (typeof safety === 'string' && (safety === 'safe' || safety === 'dangerous')) override.safety = safety;
    if (Object.keys(override).length === 0) {
      ctx.getService<CommandService>('commands')?.removeOverride(name);
    } else {
      ctx.getService<CommandService>('commands')?.setOverride(name, override);
    }
    ctx.config.set('commandOverrides', ctx.getService<CommandService>('commands')?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `指令 ${name} 权限已更新` };
  },

  /** 重置指令覆盖 */
  async resetCommandOverride(ctx, args) {
    const { name } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<AppService>('app');
    if (!app) throw new Error('App 不可用');
    ctx.getService<CommandService>('commands')?.removeOverride(name);
    ctx.config.set('commandOverrides', ctx.getService<CommandService>('commands')?.getOverrides() ?? {});
    app.saveConfig();
    return { message: `指令 ${name} 覆盖已重置` };
  },

  /** 更新单个工具的权限覆盖 */
  async setToolOverride(ctx, args) {
    const { name, authority, safety } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<AppService>('app');
    const tools = ctx.getService<ToolService>('tools');
    if (!app) throw new Error('App 不可用');
    if (!tools?.setOverride) throw new Error('ToolService 未支持 override');
    const override: { authority?: number; safety?: SafetyLevel } = {};
    if (typeof authority === 'number') override.authority = authority;
    if (typeof safety === 'string' && (safety === 'safe' || safety === 'dangerous')) override.safety = safety;
    if (Object.keys(override).length === 0) {
      tools.removeOverride?.(name);
    } else {
      tools.setOverride(name, override);
    }
    ctx.config.set('toolOverrides', tools.getOverrides?.() ?? {});
    app.saveConfig();
    return { message: `工具 ${name} 权限已更新` };
  },

  /** 重置工具覆盖 */
  async resetToolOverride(ctx, args) {
    const { name } = args;
    if (!name || typeof name !== 'string') throw new Error('name 必填');
    const app = ctx.getService<AppService>('app');
    const tools = ctx.getService<ToolService>('tools');
    if (!app) throw new Error('App 不可用');
    tools?.removeOverride?.(name);
    ctx.config.set('toolOverrides', tools?.getOverrides?.() ?? {});
    app.saveConfig();
    return { message: `工具 ${name} 覆盖已重置` };
  },
};

// actions 权限标注：createBindCode / unlinkIdentity 对任何登录账户开放
// （绑码只能绑到调用者自己；解绑有 handler 内的本人/owner 业务检查）；
// 权限图为管理读档（含用户表信息，与 REST 管理读同档=4）。
// 其余 action 不声明 → 默认要求 owner（默认拒绝）。
export const actionsMeta: PluginModule['actionsMeta'] = {
  createBindCode: { authority: 1 },
  unlinkIdentity: { authority: 1 },
  getPermissionGraph: { authority: 4 },
  getPermissionNode: { authority: 4 },
};
