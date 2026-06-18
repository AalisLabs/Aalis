import type { ConfigManager, Logger } from '@aalis/core';
import type {
  AccessConfirmHandler,
  AccessDecision,
  AccessRequest,
  AuthorityService,
  AuthorityUserEntry,
  AuthorizeRequest,
  CapabilityId,
  TemporaryGrant,
  UserCapabilityOverrides,
  UserIdentity,
} from '@aalis/plugin-authority-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { hasCapability, matchAnyCap, rejectedDelegations } from './capability-model.js';
import { UserStore } from './user-store.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 纯能力委托模型的 AuthorityService 实现（策略层）
//
// owner=`*`；用户有效能力 = (public ∪ 授予的 restricted) − denied；
// 委托子集约束（非 owner 只能授予自己持有的）；restricted 能力的临时委托。
// 数据层（users.json v3 / 绑定 / 密码）委托给 UserStore；纯判定见 capability-model。
// ════════════════════════════════════════════════════════════

/**
 * 内置受限能力：读/写/删 用户表 / 计划任务 / 源码根 —— 默认禁、仅 owner 或被授予者可触达。
 * 读也纳入：users.json 存 PBKDF2 哈希+委托结构、scheduler-jobs 存任务（含 actor 身份），
 * 默认 allowedRoots 即便放宽到 data，也不能让 file_read 等公开工具裸读这些凭据/状态文件。
 * （authority/scheduler 自身经 storage 服务直读直写，不过本守卫，故不受影响。）
 */
const BUILTIN_RESTRICTED: readonly string[] = [
  'storage:path:data:/users.json:read',
  'storage:path:data:/users.json:write',
  'storage:path:data:/users.json:delete',
  'storage:path:data:/scheduler-jobs.json:read',
  'storage:path:data:/scheduler-jobs.json:write',
  'storage:path:data:/scheduler-jobs.json:delete',
  'storage:aalis:read',
  'storage:aalis:write',
  'storage:aalis:delete',
];

/** 某用户的能力解析（被绑零合并后） */
interface Resolution {
  isOwner: boolean;
  /** 授予的 restricted 能力（被绑身份取主账户为单一真源） */
  grants: string[];
  /** 禁用能力（自身 ∪ 主账户并集，防"绑定洗白封禁"） */
  denies: string[];
}

export class AuthorityManager implements AuthorityService {
  private store: UserStore;
  private confirmHandlers = new Map<string, AccessConfirmHandler>();
  private tempGrants = new Map<string, TemporaryGrant>();
  private grantSeq = 0;
  /** 临时放行策略（restrictedPolicy）的开启时间戳（运行时态，不持久化；重启即失效） */
  private policyEnabledAt: number | null = null;

  constructor(
    private readonly config: ConfigManager,
    private readonly logger: Logger,
    storage: StorageService,
  ) {
    this.store = new UserStore(storage, this.logger.child('authority'));
  }

  init(): Promise<void> {
    return this.store.load();
  }

  // ── owner ─────────────────────────────────────────────────
  isOwner(platform: string, userId?: string): boolean {
    if (!userId) return false;
    if ((platform === 'webui' || platform === 'cli') && userId === 'console') return true;
    const owners = this.config.get('owners') ?? [];
    return owners.some((o: UserIdentity) => o.platform === platform && o.userId === userId);
  }

  /** 解析用户能力来源：被绑身份的 grant 以主账户为真源，deny 取自身∪主账户并集 */
  private resolve(platform: string, userId?: string): Resolution {
    const isOwner = this.isOwner(platform, userId);
    const ownKey = userId ? `${platform}:${userId}` : undefined;
    const ownRecord = ownKey ? this.store.get(ownKey) : undefined;
    const accountKey = ownKey ? this.store.accountOf(ownKey) : undefined;
    const accountRecord = accountKey ? this.store.get(accountKey) : undefined;
    const grants = (accountKey ? accountRecord?.caps?.grant : ownRecord?.caps?.grant) ?? [];
    const denies = [...(ownRecord?.caps?.deny ?? []), ...(accountRecord?.caps?.deny ?? [])];
    return { isOwner, grants, denies };
  }

  /** 一条能力是否为 restricted（命中内置保护 + config.restrictedCapabilities） */
  private isRestrictedCap(cap: CapabilityId): boolean {
    if (matchAnyCap(BUILTIN_RESTRICTED, cap)) return true;
    const extra = this.config.get('restrictedCapabilities') ?? [];
    return matchAnyCap(extra, cap);
  }

  // ── 能力统一闸（静态判定；临时委托在 requestAccess）──────────
  authorize(identity: { platform: string; userId?: string }, request: AuthorizeRequest): string | null {
    const res = this.resolve(identity.platform, identity.userId);
    const denied = this.config.get('deniedCapabilities') ?? [];

    const check = (cap: CapabilityId, restricted: boolean): string | null => {
      // 全局硬禁用：连 owner 都压过
      if (matchAnyCap(denied, cap)) return `已被系统禁用: ${cap}`;
      // 复用纯模型：deny > owner > (public→放行) > granted
      const ok = hasCapability(
        { isOwner: res.isOwner, publicCaps: restricted ? [] : [cap], grants: res.grants, denies: res.denies },
        cap,
      );
      if (ok) return null;
      return restricted ? `权限不足: "${cap}" 需授予后使用` : `已被禁止: ${cap}`;
    };

    // 主能力：可见性由调用方传入（已应用 visibilityOverrides）
    const primary = check(request.capability, request.visibility === 'restricted');
    if (primary) return primary;
    // 资源能力：受限性由 restrictedCapabilities 判定
    for (const cap of request.resourceCapabilities ?? []) {
      const rejection = check(cap, this.isRestrictedCap(cap));
      if (rejection) return rejection;
    }
    return null;
  }

  // ── 委托（子集约束）────────────────────────────────────────
  setUserCapabilities(granter: UserIdentity | null, target: UserIdentity, caps: UserCapabilityOverrides): void {
    const normalize = (list?: string[]): string[] | undefined => {
      const cleaned = [...new Set((list ?? []).map(p => p.trim()).filter(Boolean))];
      return cleaned.length > 0 ? cleaned : undefined;
    };
    const grant = normalize(caps.grant);
    const deny = normalize(caps.deny);

    // A3: 被绑定身份的能力以主账户为单一真源（resolve 从主账户读 grant）；写入也归一到主账户，
    // 否则写到身份自身记录 → grant 静默不生效。account 命中即重定向到主账户键。
    const rawKey = `${target.platform}:${target.userId}`;
    const key = this.store.accountOf(rawKey) ?? rawKey;
    const colon = key.indexOf(':');
    const effPlatform = key.slice(0, colon);
    const effUserId = key.slice(colon + 1);

    // 委托约束（仅约束非 owner 授予方；owner 跳过）。维护委托树「单调递减、防越权」不变量。
    if (granter && !this.isOwner(granter.platform, granter.userId)) {
      // (1) 不能修改 owner 的能力 —— 防 deny>owner 反向锁死 owner（评审 A1）。
      if (this.isOwner(effPlatform, effUserId)) {
        throw new Error('越权：不能修改 owner 的能力');
      }
      // (3) 只能管理自己委托的下层：target 为新建、或既有记录的 grantedBy === 自己。
      // 既有但 grantedBy 非自己（含 system/owner 建的、grantedBy 未设的）一律拒，防越界改他人记录。
      const granterKey = `${granter.platform}:${granter.userId}`;
      const existingTarget = this.store.get(key);
      if (existingTarget && existingTarget.grantedBy !== granterKey) {
        throw new Error('越权：只能管理你自己委托的下层用户');
      }
      // (2) grant 与 deny 都受子集约束：只能授予/禁用自己当前持有的能力。
      const gRes = this.resolve(granter.platform, granter.userId);
      const model = { isOwner: false, publicCaps: [], grants: gRes.grants, denies: gRes.denies };
      const bad = [...rejectedDelegations(model, grant ?? []), ...rejectedDelegations(model, deny ?? [])];
      if (bad.length > 0) {
        throw new Error(`越权：你不持有这些能力，无法授予/禁用：${[...new Set(bad)].join('、')}`);
      }
    }

    const existing = this.store.get(key);
    const grantedBy = granter ? `${granter.platform}:${granter.userId}` : existing?.grantedBy;
    const next = { ...existing, caps: grant || deny ? { grant, deny } : undefined, grantedBy };
    if (!next.caps && !next.secret && !next.links) {
      this.store.delete(key);
    } else {
      this.store.set(key, next);
    }
    this.logger.debug(
      `设置能力委托: ${key} grant=${grant?.length ?? 0} deny=${deny?.length ?? 0} by=${grantedBy ?? '-'}`,
    );
  }

  removeUser(platform: string, userId: string): void {
    if (this.store.delete(`${platform}:${userId}`)) this.logger.debug(`删除用户记录: ${platform}:${userId}`);
  }

  listDelegatees(granter: UserIdentity | null): AuthorityUserEntry[] {
    const granterKey = granter ? `${granter.platform}:${granter.userId}` : null;
    return this.listUsers().filter(u => {
      const entry = this.store.get(`${u.platform}:${u.userId}`);
      // owner（null）列顶层：无 grantedBy 且非 owner 自身的用户
      if (granterKey === null) return !entry?.grantedBy && !u.isOwner;
      return entry?.grantedBy === granterKey;
    });
  }

  // ── 临时能力委托（restricted 能力的时限/限次放行）──────────────
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): void {
    this.confirmHandlers.set(platform, handler);
  }

  /**
   * 该请求是否已被（白名单/会话内临时委托）放行（内部用，requestAccess 调用）。
   * restrictedPolicy 白名单是管理员全局策略；会话临时授予按 capability + sessionId 匹配
   * （一次会话的临时批准不跨会话泄漏到其他会话）。
   */
  private isTemporarilyAllowed(request: AccessRequest): boolean {
    const policy = this.config.get('restrictedPolicy');
    if (policy?.allow && policy.allow.length > 0) {
      if (
        !policy.duration ||
        policy.duration <= 0 ||
        (this.policyEnabledAt && (Date.now() - this.policyEnabledAt) / 1000 <= policy.duration)
      ) {
        if (matchAnyCap(policy.allow, request.capability)) return true;
      }
    }
    this.pruneTempGrants();
    for (const g of this.tempGrants.values()) {
      if (g.sessionId !== request.sessionId) continue;
      if (g.capability === request.capability || matchAnyCap([g.capability], request.capability)) return true;
    }
    return false;
  }

  async requestAccess(request: AccessRequest): Promise<boolean> {
    // confirm='always'：每次都问，不接受白名单/会话记忆（最高危）
    const always = request.confirm === 'always';
    if (!always && this.isTemporarilyAllowed(request)) {
      this.consumeTempGrant(request);
      return true;
    }
    // 精确平台 handler 优先（如 WebUI 的 WS 确认）；否则落到 '*' 通配 fallback
    // （plugin-session-confirm 注册，经 gateway 总线覆盖 onebot/cli/任何会话型平台）。
    const handler = this.confirmHandlers.get(request.platform) ?? this.confirmHandlers.get('*');
    if (!handler) return false;
    try {
      const decision = this.normalizeDecision(await handler(request));
      if (!always && decision.allowed && decision.grant?.scope === 'session') this.createTempGrant(request, decision);
      return decision.allowed;
    } catch (err) {
      this.logger.warn(`临时委托确认回调异常: ${err}`);
      return false;
    }
  }

  listTemporaryGrants(): TemporaryGrant[] {
    this.pruneTempGrants();
    return [...this.tempGrants.values()].map(g => ({ ...g }));
  }

  revokeTemporaryGrant(id: string): boolean {
    const ok = this.tempGrants.delete(id);
    if (ok) this.logger.info(`已撤销临时能力委托: ${id}`);
    return ok;
  }

  markPolicyEnabled(): void {
    this.policyEnabledAt = Date.now();
  }

  private normalizeDecision(result: boolean | AccessDecision): AccessDecision {
    return typeof result === 'boolean' ? { allowed: result } : result;
  }

  private consumeTempGrant(request: AccessRequest): void {
    for (const g of this.tempGrants.values()) {
      if (g.capability !== request.capability) continue;
      if (g.sessionId !== request.sessionId) continue;
      g.used++;
      if (g.maxUses && g.used >= g.maxUses) this.tempGrants.delete(g.id);
      return;
    }
  }

  private createTempGrant(request: AccessRequest, decision: AccessDecision): void {
    const spec = decision.grant;
    if (!spec || spec.scope !== 'session') return;
    this.pruneTempGrants();
    const durationSeconds = Math.max(1, Math.min(spec.durationSeconds ?? 600, 3600));
    const grant: TemporaryGrant = {
      id: `grant_${this.grantSeq++}_${Date.now()}`,
      capability: request.capability,
      name: request.name,
      type: request.type,
      sessionId: request.sessionId,
      platform: request.platform,
      userId: request.userId,
      expiresAt: Date.now() + durationSeconds * 1000,
      maxUses: spec.maxUses,
      used: 0,
      createdAt: Date.now(),
    };
    this.tempGrants.set(grant.id, grant);
    this.logger.info(
      `创建临时能力委托: ${grant.capability} session=${grant.sessionId} ${durationSeconds}s grant=${grant.id}`,
    );
  }

  private pruneTempGrants(): void {
    const now = Date.now();
    for (const [id, g] of this.tempGrants) {
      if (g.expiresAt <= now || (g.maxUses && g.used >= g.maxUses)) this.tempGrants.delete(id);
    }
  }

  // ── 列表 ──────────────────────────────────────────────────
  listUsers(): AuthorityUserEntry[] {
    const result: AuthorityUserEntry[] = [];
    for (const [key, record] of this.store.entries()) {
      const idx = key.indexOf(':');
      const platform = key.slice(0, idx);
      const userId = key.slice(idx + 1);
      result.push({
        platform,
        userId,
        isOwner: this.isOwner(platform, userId),
        grant: record.caps?.grant,
        deny: record.caps?.deny,
        grantedBy: record.grantedBy,
        hasPassword: record.secret ? true : undefined,
        links: record.links,
        linkedTo: this.store.accountOf(key),
      });
    }
    // 无自身记录的被绑身份也可见
    for (const [identityKey, accountKey] of this.store.links()) {
      if (this.store.get(identityKey)) continue;
      const idx = identityKey.indexOf(':');
      const platform = identityKey.slice(0, idx);
      const userId = identityKey.slice(idx + 1);
      result.push({ platform, userId, isOwner: this.isOwner(platform, userId), linkedTo: accountKey });
    }
    return result;
  }

  // ── 密码 / 绑定（委托给 UserStore）──────────────────────────
  setPassword(platform: string, userId: string, password: string): Promise<void> {
    return this.store.setPassword(platform, userId, password);
  }
  verifyPassword(platform: string, userId: string, password: string): Promise<boolean> {
    return this.store.verifyPassword(platform, userId, password);
  }
  hasPassword(platform: string, userId: string): boolean {
    return this.store.hasPassword(platform, userId);
  }
  createBindCode(platform: string, userId: string): { code: string; expiresAt: number } {
    return this.store.createBindCode(platform, userId);
  }
  consumeBindCode(code: string, identity: UserIdentity): UserIdentity {
    return this.store.consumeBindCode(code, identity);
  }
  unlinkIdentity(platform: string, userId: string): boolean {
    return this.store.unlinkIdentity(platform, userId);
  }
  save(): void {
    this.store.save();
  }
}
