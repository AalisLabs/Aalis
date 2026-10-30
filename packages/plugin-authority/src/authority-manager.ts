import type { OriginKind } from '@aalis/api-approval';
import type {
  AuthorityService,
  AuthorityUserEntry,
  AuthorizeRequest,
  OriginTurn,
  UserIdentity,
} from '@aalis/api-authority';
import type { HostConfig } from '@aalis/api-host-config';
import type { StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';
import { TextError, type TextRef } from '@aalis/schema-i18n';
import {
  DEFAULT_AUTHORITY,
  matchAnyCap,
  OWNER_RANK,
  originKind,
  principalKind,
  resolveAccess,
  resolveMinLevel,
} from './authority-model.js';
import { t } from './texts.js';
import { type UserRecord, UserStore } from './user-store.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 等级加权限组的 AuthorityService 实现（策略层）
//
// owner=∞；每个外部身份一个登记等级（缺省 0，封禁=负数），可属于任意几个权限组；操作一个 minLevel
// （risk/visibility/authorityOverrides 派生）；裁决 deniedCapabilities(全局硬禁) > owner > 封禁 > level>=minLevel >
// 所属组覆盖（纯函数在 authority-model）。组定义在宿主配置 authorityGroups，成员关系记在用户记录里，读写只在本类上。
// confirm 轴另在执行守卫里（plugin-authority 的 index.ts），这里只答 restrictedPolicy 白名单免不免确认。
// 数据层（users.json v5 的等级与组成员存储）委托给 UserStore。
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

  ownerOn(platform: string): UserIdentity | undefined {
    return (this.config.get('owners') ?? []).find((o: UserIdentity) => o.platform === platform);
  }

  originOf(turn: OriginTurn): OriginKind {
    return originKind(turn);
  }

  principalOf(turn: OriginTurn): 'owner' | 'other' {
    return principalKind(turn, (platform, userId) => this.isOwner(platform, userId));
  }

  /** 触发者有效等级（owner→∞；登记等级；无记录→默认 0）。平台身份（如 onebot 群角色）不参与。 */
  private level(platform: string, userId?: string): number {
    if (this.isOwner(platform, userId)) return OWNER_RANK;
    const key = userId ? `${platform}:${userId}` : undefined;
    return (key ? this.store.get(key)?.level : undefined) ?? DEFAULT_AUTHORITY;
  }

  /** 已定义的权限组（宿主配置 authorityGroups）：组名 → 放行条目；手改坏了的组（条目不是数组）不算定义 */
  definedGroups(): Map<string, readonly string[]> {
    const defs = Object.entries(this.config.get('authorityGroups') ?? {});
    return new Map(defs.filter(([, entries]) => Array.isArray(entries)));
  }

  /**
   * 这个身份所属各组的放行条目合集：成员关系的唯一入口。
   * 用户记录里的组名按配置里定义了的取，没定义的组不放行任何东西
   */
  private grantsOf(identity: { platform: string; userId?: string }): string[] {
    const groups = identity.userId ? this.store.get(`${identity.platform}:${identity.userId}`)?.groups : undefined;
    if (!groups?.length) return [];
    const defs = this.definedGroups();
    return groups.flatMap(name => defs.get(name) ?? []);
  }

  // ── 统一权限闸（等级与权限组静态判定；确认在执行守卫）──────────
  authorize(identity: { platform: string; userId?: string }, request: AuthorizeRequest): TextRef | null {
    const level = this.level(identity.platform, identity.userId);
    const isOwner = this.isOwner(identity.platform, identity.userId);
    const denied = (this.config.get('deniedCapabilities') ?? []) as string[];
    const authorityOverrides = (this.config.get('authorityOverrides') ?? {}) as Record<string, number>;

    // 主能力：minLevel 由 authorityOverrides > 请求声明的门槛 > risk > visibility 派生
    const minLevel = resolveMinLevel(request.capability, {
      authorityOverrides,
      minLevel: request.minLevel,
      risk: request.risk,
      visibility: request.visibility,
    });
    if (
      !resolveAccess({
        level,
        minLevel,
        isOwner,
        denied,
        capability: request.capability,
        granted: this.grantsOf(identity),
        toolGroups: request.toolGroups,
      })
    ) {
      if (matchAnyCap(denied, request.capability)) return t('capabilityDenied', { capability: request.capability });
      // 文案点名能力，因此会向无权用户暴露该能力的**存在性**。这是评估后刻意保留的：
      // 改成「未知指令」式的模糊回应会牵动所有能力的拒绝语义（本函数同时服务 tools 与
      // commands 两个注入点），而开源项目里能力存在性本就公开——防泄漏不是这里的目标，
      // 说清「差多少等级」对用户更有用。指令的帮助（/help、-h、裸敲分组）另按本函数过滤，
      // 用不了的在那里当作不存在；直接执行时仍是这条点名的拒绝。
      if (minLevel === OWNER_RANK) return t('ownerOnlyCapability', { capability: request.capability });
      return t('levelTooLow', { capability: request.capability, required: minLevel, level });
    }
    return null;
  }

  meetsLevel(identity: { platform: string; userId?: string }, minLevel: number): boolean {
    const level = this.level(identity.platform, identity.userId);
    return level === OWNER_RANK || (level >= 0 && level >= minLevel);
  }

  // ── 等级与组成员设置（owner 管理）──────────
  setUserLevel(target: UserIdentity, level: number): void {
    const key = `${target.platform}:${target.userId}`;
    this.put(key, { ...this.store.get(key), level });
    this.logger.debug(`设置等级: ${key} → ${level}`);
  }

  /**
   * 覆盖式设 target 所属的权限组（去重，空即清空）。这次新加的组须都已定义，否则抛错并列出已有的组，记录不动；原有的组
   * 即使已被删掉也照收（删组不级联，原样保存不受它影响）。
   * 清空而记录留着时（还有等级或备注，或首次读取尚未落定）记成 `groups: []`：读取按字段合并时由它盖掉文件里的组
   */
  setUserGroups(target: UserIdentity, groups: readonly string[]): void {
    const key = `${target.platform}:${target.userId}`;
    const record = this.store.get(key);
    const names = [...new Set(groups)];
    const defs = this.definedGroups();
    const unknown = names.filter(name => !defs.has(name) && !record?.groups?.includes(name));
    if (unknown.length > 0) {
      const known = [...defs.keys()];
      throw new TextError(
        known.length > 0 ? t('unknownGroups', { groups: unknown, known }) : t('noGroupsDefined', { groups: unknown }),
      );
    }
    this.put(key, { ...record, groups: names });
    this.logger.debug(`设置权限组: ${key} → [${names.join(', ')}]`);
  }

  /**
   * 写回一条记录：默认等级(0)、无备注、没有组时直接清记录（保持 users.json 精简）。首次读取落定之前、读取失败拒写期间
   * 内存里看不到文件里的字段，删除会记成墓碑、之后读取成功时连同文件里的备注与组删掉整条记录；这时改为保留记录，
   * 读取按字段合并带上文件里的
   */
  private put(key: string, record: UserRecord): void {
    const empty = (record.level ?? DEFAULT_AUTHORITY) === DEFAULT_AUTHORITY && !record.note && !record.groups?.length;
    if (empty && !this.store.awaitingFirstLoad && !this.store.persistBlocked) this.store.delete(key);
    else this.store.set(key, record);
  }

  removeUser(platform: string, userId: string): void {
    const key = `${platform}:${userId}`;
    if (this.store.delete(key)) this.logger.debug(`删除用户记录: ${key}`);
  }

  /**
   * restrictedPolicy 白名单是否免掉这个能力的确认（只对 confirm 为 session 的确认有意义，always 由守卫照常确认）。
   * 只看能力与时长，授权身份是不是 owner 由守卫判。硬禁的能力不在这里放行：授权轴已先拒。
   * `duration > 0` 时从 owner 在权限页保存策略起算，过了即失效。
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
  /** 带所属组的用户记录：权限页与 /authority 用，契约的 AuthorityUserEntry 不带组 */
  listUsers(): Array<AuthorityUserEntry & { groups: string[] }> {
    return [...this.store.entries()].map(([key, record]) => {
      const idx = key.indexOf(':');
      const platform = key.slice(0, idx);
      const userId = key.slice(idx + 1);
      return {
        platform,
        userId,
        isOwner: this.isOwner(platform, userId),
        level: record.level ?? DEFAULT_AUTHORITY,
        note: record.note,
        groups: record.groups ?? [],
      };
    });
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

  /** users.json 上次加载失败的原因（实现层状态，不在契约里）：读不出来的提示据此写明原因 */
  get lastLoadError(): string | TextRef | undefined {
    return this.store.lastLoadError;
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
