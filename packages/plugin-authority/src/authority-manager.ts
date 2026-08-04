import type {
  AccessConfirmHandler,
  AccessDecision,
  AccessRequest,
  AuthorityService,
  AuthorityUserEntry,
  AuthorizeRequest,
  TemporaryGrant,
  UserIdentity,
} from '@aalis/api-authority';
import type { StorageService } from '@aalis/api-storage';
import type { ConfigManager, Logger } from '@aalis/core';
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
    // 本机控制台恒为 owner（CLI 的 TUI、WebUI 的已认证会话）。**这是设计不是后门**：
    // `platform` 由适配器自己填（onebot 适配器填 'onebot'），远端用户无从选择它，所以
    // 「伪造成 cli:console」这条路对外不存在。能填 'cli' 的只有本进程内的代码，而那已经
    // 拥有完全能力（服务容器里想调什么调什么），冒充 owner 对它毫无增益。
    // 反过来说：**任何新增的平台适配器都不得把自己的 platform 起名为 'cli' 或 'webui'**。
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
      // 文案点名能力，因此会向无权用户暴露该能力的**存在性**。已评估并决定保留（2026-08）：
      // 改成「未知指令」式的模糊回应会牵动所有能力的拒绝语义（本函数同时服务 tools 与
      // commands 两个注入点），而开源项目里能力存在性本就公开——防泄漏不是这里的目标，
      // 说清「差多少等级」对用户更有用。与 CommandRegistry.execute 里那条守卫前泄漏是
      // 同一个决定的两半，要改一起改。
      return `权限不足: "${request.capability}" 需等级 ${minLevel}（当前 ${level}）`;
    }
    return null;
  }

  // ── 等级设置（owner 管理；单轴，无 per-user 特批）──────────
  setUserLevel(target: UserIdentity, level: number): void {
    const key = `${target.platform}:${target.userId}`;
    const existing = this.store.get(key);
    const prev = existing?.level ?? DEFAULT_AUTHORITY;
    // 默认等级(0)且无备注 → 直接清记录（保持 users.json 精简）
    if (level === DEFAULT_AUTHORITY && !existing?.note) {
      this.store.delete(key);
    } else {
      this.store.set(key, { ...existing, level });
    }
    // 降权即撤销该用户尚未过期的会话授予。
    // 不这么做的话，`isPreApproved`（守卫「未授权」分支的救援口）会靠旧授予继续放行——
    // authorize 明确返回「权限不足」而守卫仍放过，即「封了但没封住」，窗口最长 1 小时。
    // 撤销放在这里而不是放在救援口上复查：救援口恰恰是在 authorize 拒绝之后才被调用的，
    // 在那里复查等于把整条会话授予路径变成死代码。撤销本就是管理动作的一部分。
    if (level < prev) this.revokeGrantsOf(target.platform, target.userId);
    this.logger.debug(`设置等级: ${key} → ${level}`);
  }

  removeUser(platform: string, userId: string): void {
    const key = `${platform}:${userId}`;
    // 删记录 = 等级回落 DEFAULT_AUTHORITY，所以**只在这构成降权时**撤销授予，判据与
    // setUserLevel 同源。原等级为负（被封禁）时删记录其实是升权，撤销纯属多余；
    // 记录本就不存在时更是什么都没变，无条件撤销会让人白白重新确认一次。
    const prev = this.store.get(key)?.level ?? DEFAULT_AUTHORITY;
    if (this.store.delete(key)) this.logger.debug(`删除用户记录: ${key}`);
    if (DEFAULT_AUTHORITY < prev) this.revokeGrantsOf(platform, userId);
  }

  /** 撤销某身份名下所有未过期的会话授予（降权 / 删除用户记录时调用）。 */
  private revokeGrantsOf(platform: string, userId: string): void {
    let n = 0;
    for (const [id, g] of this.tempGrants) {
      if (g.platform === platform && g.userId === userId) {
        this.tempGrants.delete(id);
        n++;
      }
    }
    if (n > 0) this.logger.info(`已撤销 ${platform}:${userId} 的 ${n} 条会话授予（等级下调）`);
  }

  // ── 临时能力委托（restricted 能力的时限/限次放行）──────────────
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): void {
    this.confirmHandlers.set(platform, handler);
  }

  /**
   * 该请求是否被 owner **预先**放行（白名单 / 该用户在本会话已有的临时授予）——**绝不**含"问发起者本人"。
   * 先过绝对闸（任何放行都不得绕过）：硬禁 deniedCapabilities。
   * 再看：restrictedPolicy 全局白名单（自动化免确认）或 会话临时授予。
   * 临时授予按 **platform + userId + sessionId + capability** 匹配 —— 群内 sessionId 全群共享时
   * 不跨用户泄漏，同名 id 跨平台时不跨平台泄漏。消费端 consumeTempGrant 用同一组判据。
   */
  private isTemporarilyAllowed(request: AccessRequest, ownerOnly: boolean): boolean {
    const denied = (this.config.get('deniedCapabilities') ?? []) as string[];
    // 硬禁绝对：主能力命中 deniedCapabilities 时，任何放行路径都不得绕过
    if (matchAnyCap(denied, request.capability)) return false;
    // restrictedPolicy 全局白名单。
    //
    // `ownerOnly` 由调用方决定，两条路径的语义**不同**，别再合并成一条：
    // - `requestAccess`（确认轴）传 false：白名单在这里的意思是「免确认」——请求**已经过了
    //   授权**，只是还要不要弹确认。对已授权用户放宽确认，正是它被设计出来的用途。
    // - `isPreApproved`（守卫的未授权分支）传 true：那里是**救援闸**，一条不带身份判据的
    //   白名单等于把「免确认」偷偷变成「免授权」：owner 配 `allow: ['tool:*']`
    //   （本意只是让自己的自动化不必每次确认）之后，**任何用户都能过**，包括被显式封禁到
    //   -5 的那个。同一函数下半截的会话授予本就带 `userId` 匹配（注释写着「防群内跨用户
    //   白嫖」），这里缺的正是同一道判据。
    const policy =
      ownerOnly && !this.isOwner(request.platform, request.userId) ? undefined : this.config.get('restrictedPolicy');
    if (policy?.allow && policy.allow.length > 0) {
      if (
        !policy.duration ||
        policy.duration <= 0 ||
        (this.policyEnabledAt && (Date.now() - this.policyEnabledAt) / 1000 <= policy.duration)
      ) {
        if (matchAnyCap(policy.allow, request.capability)) return true;
      }
    }
    // 会话临时授予：同一平台 + 同一用户 + 同会话 + 同能力。
    //
    // platform 必须一起匹配 —— grant 记录里本就存着它，漏掉则 onebot 的 '123' 会命中
    // telegram 的 '123' 的授予（userId 在跨平台间不唯一）。
    //
    // 这里**不**复查「当前是否仍被授权」：`isPreApproved` 恰恰是在 authorize 已经拒绝
    // 之后才被调用的救援口，加这道复查会把整条会话授予路径变成死代码。
    // 「封禁后旧授予仍生效」那条改在 setUserLevel 侧解决——撤销是管理动作的一部分。
    this.pruneTempGrants();
    for (const g of this.tempGrants.values()) {
      if (g.platform !== request.platform) continue;
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
    // ownerOnly=true：这条是**未授权救援闸**，白名单只认 owner 自己（见上方注释）。
    return this.isTemporarilyAllowed(request, true);
  }

  async requestAccess(request: AccessRequest): Promise<boolean> {
    // confirm='always'：每次都问，不接受白名单/会话记忆（最高危）
    const always = request.confirm === 'always';
    // ownerOnly=false：这条是**确认轴**，请求已过授权，白名单在此的语义就是「免确认」。
    if (!always && this.isTemporarilyAllowed(request, false)) {
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
      // platform 与 isTemporarilyAllowed 的匹配判据保持一致 —— 两个谓词必须成对：
      // 只在匹配端加而消费端不加，会出现「命中的是 A 平台的授予、扣次数的是 B 平台的」。
      if (g.platform !== request.platform) continue;
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
