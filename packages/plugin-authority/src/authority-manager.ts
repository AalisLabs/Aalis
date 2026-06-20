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
  TierName,
  UserIdentity,
} from '@aalis/plugin-authority-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { matchAnyCap, OWNER_RANK, rankOf, resolveAccess, resolveMinTier, TIERS, tierName } from './tier-model.js';
import { UserStore } from './user-store.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 档位单轴的 AuthorityService 实现（策略层）
//
// owner=∞；每个外部身份一个登记档（缺省 visitor）；操作一个 minTier（risk/visibility/tierOverrides 派生）；
// 裁决 deniedCapabilities(全局硬禁) > owner > rank>=minTier（纯函数在 tier-model）。
// 资源能力(storage:/system:) 走系统层 fail-closed；confirm 轴 + 临时放行正交保留。
// 数据层（users.json v4 档位存储）委托给 UserStore。
// ════════════════════════════════════════════════════════════

/**
 * 内置受限能力：读/写/删 用户表 / 计划任务 / 源码根 —— 默认禁、仅 owner 或被授予者可触达。
 * 读也纳入：users.json 存委托结构、scheduler-jobs 存任务（含 actor 身份），
 * 默认 allowedRoots 即便放宽到 data，也不能让 file_read 等公开工具裸读这些状态文件。
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

  /** 触发者有效档（owner→∞；登记档；无记录→访客）。v1 无访问器（onebot 群角色待 sender.role 透传后接线）。 */
  private rank(platform: string, userId?: string): number {
    if (this.isOwner(platform, userId)) return OWNER_RANK;
    const key = userId ? `${platform}:${userId}` : undefined;
    const tier = (key ? this.store.get(key)?.tier : undefined) ?? 'visitor';
    return rankOf(tier);
  }

  /** 资源能力是否受限（命中内置保护 + config.restrictedCapabilities）→ 受限资源 minTier=信任，否则访客。 */
  private resourceMinTier(cap: CapabilityId): number {
    if (matchAnyCap(BUILTIN_RESTRICTED, cap)) return TIERS.trusted;
    const extra = this.config.get('restrictedCapabilities') ?? [];
    return matchAnyCap(extra, cap) ? TIERS.trusted : TIERS.visitor;
  }

  // ── 统一权限闸（档位静态判定；临时放行/确认在 requestAccess）──────────
  authorize(identity: { platform: string; userId?: string }, request: AuthorizeRequest): string | null {
    const rank = this.rank(identity.platform, identity.userId);
    const isOwner = this.isOwner(identity.platform, identity.userId);
    const denied = (this.config.get('deniedCapabilities') ?? []) as string[];
    const tierOverrides = (this.config.get('tierOverrides') ?? {}) as Record<string, number>;

    // 主能力：minTier 由 tierOverrides > risk > visibility 派生
    const minTier = resolveMinTier(request.capability, {
      tierOverrides,
      risk: request.risk,
      visibility: request.visibility,
    });
    if (!resolveAccess({ rank, minTier, isOwner, denied, capability: request.capability })) {
      if (matchAnyCap(denied, request.capability)) return `已被系统禁用: ${request.capability}`;
      return `权限不足: "${request.capability}" 需「${tierName(minTier)}」档（当前不足）`;
    }
    // 资源能力：系统层 fail-closed（受限资源需信任档/owner）
    for (const cap of request.resourceCapabilities ?? []) {
      const rMin = this.resourceMinTier(cap);
      if (!resolveAccess({ rank, minTier: rMin, isOwner, denied, capability: cap })) {
        if (matchAnyCap(denied, cap)) return `已被系统禁用: ${cap}`;
        return `权限不足: "${cap}" 需「${tierName(rMin)}」档`;
      }
    }
    return null;
  }

  // ── 档位设置（owner 管理；单轴，无 per-user 特批）──────────
  setUserTier(target: UserIdentity, tier: TierName): void {
    const key = `${target.platform}:${target.userId}`;
    const existing = this.store.get(key);
    // visitor 是默认档：无 note 则直接清记录（保持 users.json 精简）
    if (tier === 'visitor' && !existing?.note) {
      this.store.delete(key);
    } else {
      this.store.set(key, { ...existing, tier });
    }
    this.logger.debug(`设置档位: ${key} → ${tier}`);
  }

  removeUser(platform: string, userId: string): void {
    if (this.store.delete(`${platform}:${userId}`)) this.logger.debug(`删除用户记录: ${platform}:${userId}`);
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
        tier: record.tier ?? 'visitor',
        note: record.note,
      });
    }
    return result;
  }

  save(): void {
    this.store.save();
  }
}
