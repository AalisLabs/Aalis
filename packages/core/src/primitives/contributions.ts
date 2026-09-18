import type { ContributionPointMap } from '../types/contributions.js';

/**
 * 贡献 spec 的内核契约：只要求一个 id。
 *
 * id 是**局部名**（如 'context'、'group-hint'），注册时由门面自动冠以
 * `${ctx.id}/` 前缀成为全局键（见 {@link ContributionHandle.key}）——
 * **spec.id 侧**的抢注/顶替由此杜绝，无需归属权校验（与 provide 的
 * entryId 前缀约定同源，但由构造保证而非 warn）。
 *
 * 边界如实声明：该保证以 ctx.id 为信任锚。`ctx.useModule(module)` 在 fork 前
 * 已对 childId（`${父id}#${模块名}`）做 `~n` 后缀唯一化；直接 `ctx.fork(id)`
 * 则不保证唯一——重复 ctx.id 会使两方共用同一命名空间、后注册者替换先注册者。
 * 这是 Context 模型的信任边界（provide / middleware 的 contextId 归属同理
 * 暴露），如需硬化应在 fork 层统一处理，而非各原语自设门禁。
 */
export interface ContributionSpec {
  /**
   * 局部幂等键：同一 ctx 内同 id 重复注册 = 替换。
   *
   * 必须**非空且不含 `/`**（`/` 是全局键的分隔符，含它可构造出跨 ctx 的
   * 键碰撞），违者注册期抛 `TypeError`。
   */
  id: string;
}

/** collect 的枚举条目：全局键 + 注册时原样传入的 spec（不拷贝、不改写）。 */
export interface ContributionHandle<S extends ContributionSpec = ContributionSpec> {
  /** 全局键 `${contextId}/${spec.id}`——归属标识与幂等键。 */
  readonly key: string;
  /** 注册方交付的 spec 本体（引用，非副本）。 */
  readonly spec: S;
}

interface ContributionEntry {
  spec: ContributionSpec;
  /** 逻辑身份：全局键 `${contextId}/${spec.id}` 的前半，决定排序与同键替换 */
  contextId: string;
  /** 清理归属（见 ServiceEntry.owner）；无则不被拆卸自动清理 */
  owner?: symbol;
}

/**
 * 贡献点注册表 —— 与 services 成对偶的数据原语。
 *
 * 四原语按「执行/数据」二分：events（执行·无返回·隔离）、hooks（执行·可变·
 * 短路）、services（数据·解析单胜者）、contributions（数据·确定性枚举全量）。
 *
 * 本注册表**永不执行插件代码**：register/collect 是同步的数据插入与快照枚举。
 * 如何调用 spec（并行/隔离/超时）是收集方（贡献点 owner）的策略，不在内核。
 *
 * 确定性：collect 按全局键（`${contextId}/${id}`）码元序排序——同一注册集合
 * 在任意注册顺序、任意机器上枚举结果逐字节相同；顺序是键的纯函数，
 * 重复注册也无法影响排位。
 *
 * 插件面与 events / services / hooks 同一门面纪律（方法窄面，对象不外露）：
 * 注册经 `ctx.contribute(point, spec)`（冠 ctx.id 前缀 + 挂 dispose 链），
 * 枚举经 `ctx.collect(point)`（驱动公开——任何插件都可拥有自己的贡献点）。
 * 完整注册表仅 App（组合根）与 Context 内部持有。
 *
 * 按贡献点键精化 spec 类型（经 types/contributions.ts 的 ContributionPointMap
 * declaration merging）是**注册表自己的契约**，与 events / hooks 同构：谁定义
 * 写入口，谁声明写入口的类型。于是绕开门面、直接持有注册表（包根导出、app.contributions）
 * 的写入也受同一约束；门面为保住推断仍自带同形签名。
 * 运行时仍只认 {@link ContributionSpec}（除 id 合法性外不看 spec 一眼），
 * 精化纯在编译期——注册表"永不执行插件代码"不受影响。
 */
export class ContributionRegistry {
  /** point → 全局键 → 注册项 */
  private points = new Map<string, Map<string, ContributionEntry>>();

  /**
   * 注册一份贡献，返回 dispose 函数。
   *
   * 全局键 = `${contextId}/${spec.id}`；同键重复注册为替换（幂等），
   * 旧注册的 dispose 函数在替换后失效（不会误删新注册）。
   * @param owner 清理归属（Context 门面传入）；省略则不被拆卸自动清理，用返回的 dispose 自管。
   */
  register<K extends string & keyof ContributionPointMap>(
    point: K,
    spec: ContributionPointMap[K] & ContributionSpec,
    contextId: string,
    owner?: symbol,
  ): () => void {
    // 窄化取 id：core 内 ContributionPointMap 是空接口，K 落到 never，`ContributionPointMap[K]`
    // 连同交叉一起塌成 never，索引不出成员；交叉里的 ContributionSpec 仍保证 id 存在。
    const { id } = spec as ContributionSpec;
    // 空 id 会静默同键碰撞；含 '/' 的局部 id 可构造出与他人 `${contextId}/${id}`
    // 相同的全局键（如 ctx 'a' + id 'b/c' 撞 ctx 'a/b' + id 'c'），打破
    // 「spec.id 侧无法顶替他人贡献」的保证——两者都必须在注册期拒绝。
    if (!id || id.includes('/')) {
      throw new TypeError(`贡献点 "${point}" 的 spec.id 必须非空且不含 '/'（得到 "${id}"）`);
    }
    let byKey = this.points.get(point);
    if (!byKey) {
      byKey = new Map();
      this.points.set(point, byKey);
    }
    const key = `${contextId}/${id}`;
    const entry: ContributionEntry = { spec, contextId, owner };
    byKey.set(key, entry);

    return () => {
      // 仅当当前占位仍是本次注册时才删除——同键已被替换时旧 dispose 是 no-op
      const current = this.points.get(point);
      if (current?.get(key) === entry) {
        current.delete(key);
        if (current.size === 0) this.points.delete(point);
      }
    };
  }

  /**
   * 枚举某贡献点的全部条目，按全局键码元序（`Array.prototype.sort` 默认
   * 比较，无 locale 依赖）。返回数组快照；spec 按**引用**给出——不拷贝、
   * 不改写字段，故 class 实例 spec 的原型方法、getter 语义均完好保留
   * （注册表"永不执行插件代码"因此在枚举侧也成立）。
   */
  collect<K extends string & keyof ContributionPointMap>(
    point: K,
  ): ReadonlyArray<ContributionHandle<ContributionPointMap[K] & ContributionSpec>> {
    const byKey = this.points.get(point);
    if (!byKey) return [];
    const handles: ReadonlyArray<ContributionHandle> = [...byKey.keys()]
      .sort()
      .map(key => ({ key, spec: (byKey.get(key) as ContributionEntry).spec }));
    // 内部登记只按不透明的 ContributionSpec 存放；按贡献点键精化到 ContributionPointMap[K]
    // 是本方法的类型契约，运行时不做任何校验（spec 按引用原样交付）。
    return handles as ReadonlyArray<ContributionHandle<ContributionPointMap[K] & ContributionSpec>>;
  }

  /**
   * 按清理归属移除该 Context 本次激活的全部贡献（插件卸载清扫）。同键被同名新 Context
   * 替换后，旧 Context 的迟到清理不会删掉新占位——owner 不同。
   */
  unregisterByOwner(owner: symbol): void {
    for (const [point, byKey] of this.points) {
      for (const [key, entry] of byKey) {
        if (entry.owner === owner) byKey.delete(key);
      }
      if (byKey.size === 0) this.points.delete(point);
    }
  }
}
