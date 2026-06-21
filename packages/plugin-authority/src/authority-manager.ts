import type { ConfigManager, Logger } from '@aalis/core';
import type {
  AccessConfirmHandler,
  AccessDecision,
  AccessRequest,
  AuthorityService,
  AuthorityUserEntry,
  AuthorizeRequest,
  TemporaryGrant,
  UserIdentity,
} from '@aalis/plugin-authority-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { DEFAULT_AUTHORITY, matchAnyCap, OWNER_RANK, resolveAccess, resolveMinLevel } from './authority-model.js';
import { UserStore } from './user-store.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 数字等级单轴的 AuthorityService 实现（策略层）
//
// owner=∞；每个外部身份一个登记等级（缺省 0，封禁=负数）；操作一个 minLevel（risk/visibility/authorityOverrides 派生）；
// 裁决 deniedCapabilities(全局硬禁) > owner > level>=minLevel（纯函数在 authority-model）。
// confirm 轴 + 临时放行正交保留。
// 数据层（users.json v5 等级存储）委托给 UserStore。
// ════════════════════════════════════════════════════════════

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

  /** 触发者有效等级（owner→∞；登记等级；无记录→默认 0）。v1 无访问器（onebot 群角色待 sender.role 透传后接线）。 */
  private level(platform: string, userId?: string): number {
    if (this.isOwner(platform, userId)) return OWNER_RANK;
    const key = userId ? `${platform}:${userId}` : undefined;
    return (key ? this.store.get(key)?.level : undefined) ?? DEFAULT_AUTHORITY;
  }

  // ── 统一权限闸（等级静态判定；临时放行/确认在 requestAccess）──────────
  authorize(identity: { platform: string; userId?: string }, request: AuthorizeRequest): string | null {
    const level = this.level(identity.platform, identity.userId);
    const isOwner = this.isOwner(identity.platform, identity.userId);
    const denied = (this.config.get('deniedCapabilities') ?? []) as string[];
    const authorityOverrides = (this.config.get('authorityOverrides') ?? {}) as Record<string, number>;

    // 主能力：minLevel 由 authorityOverrides > risk > visibility 派生
    const minLevel = resolveMinLevel(request.capability, {
      authorityOverrides,
      risk: request.risk,
      visibility: request.visibility,
    });
    if (!resolveAccess({ level, minLevel, isOwner, denied, capability: request.capability })) {
      if (matchAnyCap(denied, request.capability)) return `已被系统禁用: ${request.capability}`;
      return `权限不足: "${request.capability}" 需等级 ${minLevel}（当前 ${level}）`;
    }
    return null;
  }

  // ── 等级设置（owner 管理；单轴，无 per-user 特批）──────────
  setUserLevel(target: UserIdentity, level: number): void {
    const key = `${target.platform}:${target.userId}`;
    const existing = this.store.get(key);
    // 默认等级(0)且无备注 → 直接清记录（保持 users.json 精简）
    if (level === DEFAULT_AUTHORITY && !existing?.note) {
      this.store.delete(key);
    } else {
      this.store.set(key, { ...existing, level });
    }
    this.logger.debug(`设置等级: ${key} → ${level}`);
  }

  removeUser(platform: string, userId: string): void {
    if (this.store.delete(`${platform}:${userId}`)) this.logger.debug(`删除用户记录: ${platform}:${userId}`);
  }

  // ── 临时能力委托（restricted 能力的时限/限次放行）──────────────
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): void {
    this.confirmHandlers.set(platform, handler);
  }

  /**
   * 该请求是否被 owner **预先**放行（白名单 / 该用户在本会话已有的临时授予）——**绝不**含"问发起者本人"。
   * 先过绝对闸（任何放行都不得绕过）：硬禁 deniedCapabilities。
   * 再看：restrictedPolicy 全局白名单（自动化免确认）或 会话临时授予。
   * 临时授予按 **userId + sessionId + capability** 匹配 —— 群内 sessionId 全群共享时，不跨用户泄漏。
   */
  private isTemporarilyAllowed(request: AccessRequest): boolean {
    const denied = (this.config.get('deniedCapabilities') ?? []) as string[];
    // 硬禁绝对：主能力命中 deniedCapabilities 时，任何放行路径都不得绕过
    if (matchAnyCap(denied, request.capability)) return false;
    // owner 全局白名单（自动化免确认）
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
    // 会话临时授予：同一用户 + 同会话 + 同能力（userId 必须匹配，防群内跨用户白嫖）
    this.pruneTempGrants();
    for (const g of this.tempGrants.values()) {
      if (g.sessionId !== request.sessionId) continue;
      if (g.userId !== request.userId) continue;
      if (g.capability === request.capability || matchAnyCap([g.capability], request.capability)) return true;
    }
    return false;
  }

  /**
   * 守卫「未授权」分支专用闸：请求是否被 owner 预先放行（白名单 / 该用户已有授予），
   * 且不触犯硬禁 / 资源保护。**绝不询问发起者本人** —— 杜绝低档用户对超档操作自我确认提权。
   * 守卫拒绝后改调本方法（而非 requestAccess），requestAccess 仅用于「已授权但需意图确认」。
   */
  isPreApproved(request: AccessRequest): boolean {
    return this.isTemporarilyAllowed(request);
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
      if (g.userId !== request.userId) continue;
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
        level: record.level ?? DEFAULT_AUTHORITY,
        note: record.note,
      });
    }
    return result;
  }

  save(): void {
    this.store.save();
  }
}
