import type { AuthorityService, AuthorityUserEntry, AuthorizeRequest, UserIdentity } from '@aalis/api-authority';
import type { HostConfig } from '@aalis/api-host-config';
import type { StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';
import { DEFAULT_AUTHORITY, matchAnyCap, OWNER_RANK, resolveAccess, resolveMinLevel } from './authority-model.js';
import { UserStore } from './user-store.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 数字等级单轴的 AuthorityService 实现（策略层）
//
// owner=∞；每个外部身份一个登记等级（缺省 0，封禁=负数）；操作一个 minLevel（risk/visibility/authorityOverrides 派生）；
// 裁决 deniedCapabilities(全局硬禁) > owner > level>=minLevel（纯函数在 authority-model）。
// confirm 轴另在执行守卫里（plugin-authority 的 index.ts），这里只答 restrictedPolicy 白名单免不免确认。
// 数据层（users.json v5 等级存储）委托给 UserStore。
// ════════════════════════════════════════════════════════════

export class AuthorityManager implements AuthorityService {
  private store: UserStore;
  /** 免确认白名单（restrictedPolicy）的开启时间戳（运行时态，不持久化；重启即失效） */
  private policyEnabledAt: number | null = null;

  constructor(
    private readonly config: HostConfig,
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

  // ── 统一权限闸（等级静态判定；确认在执行守卫）──────────
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
      // 文案点名能力，因此会向无权用户暴露该能力的**存在性**。这是评估后刻意保留的：
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
    // 默认等级(0)且无备注 → 直接清记录（保持 users.json 精简）。首次读取落定之前、读取失败拒写期间内存里看不到
    // 文件里的备注，删除会记成墓碑、之后读取成功时连同备注删掉整条记录；这时改为保留记录，读取按字段合并带上文件里的备注
    if (level === DEFAULT_AUTHORITY && !existing?.note && !this.store.awaitingFirstLoad && !this.store.persistBlocked) {
      this.store.delete(key);
    } else {
      this.store.set(key, { ...existing, level });
    }
    this.logger.debug(`设置等级: ${key} → ${level}`);
  }

  removeUser(platform: string, userId: string): void {
    const key = `${platform}:${userId}`;
    if (this.store.delete(key)) this.logger.debug(`删除用户记录: ${key}`);
  }

  /**
   * restrictedPolicy 白名单是否免掉这个能力的确认（只对 confirm 为 session 的确认有意义，always 由守卫照常确认）。
   * 硬禁的能力不在这里放行：授权轴已先拒。`duration > 0` 时从 owner 在权限页保存策略起算，过了即失效。
   */
  waivesConfirm(capability: string): boolean {
    const policy = this.config.get('restrictedPolicy');
    if (!policy?.allow || policy.allow.length === 0) return false;
    const live =
      !policy.duration ||
      policy.duration <= 0 ||
      (this.policyEnabledAt !== null && (Date.now() - this.policyEnabledAt) / 1000 <= policy.duration);
    return live && matchAnyCap(policy.allow, capability);
  }

  markPolicyEnabled(): void {
    this.policyEnabledAt = Date.now();
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

  /** 等在飞的等级表读取落定（管理入口改等级前等它：首次读取完成前内存表是空的） */
  whenLoaded(): Promise<void> {
    return this.store.whenLoaded();
  }

  /** 等待落盘完成（拆卸路径与管理入口用；save() 本身只是把写挂上链） */
  flushed(): Promise<void> {
    return this.store.flushed();
  }

  save(): void {
    this.store.save();
  }

  /** users.json 加载失败而拒写（实现层状态，不在契约里）：管理动作据此在回执里注明改动未落盘 */
  get persistBlocked(): boolean {
    return this.store.persistBlocked;
  }

  /** 最近一次写 users.json 失败（实现层状态，不在契约里）：管理动作据此在回执里注明改动未落盘 */
  get lastSaveFailed(): boolean {
    return this.store.lastSaveFailed;
  }

  /** 首次读取 users.json 尚未落定、改动还没写盘（实现层状态，不在契约里）：管理动作据此在回执里注明 */
  get awaitingFirstLoad(): boolean {
    return this.store.awaitingFirstLoad;
  }
}
