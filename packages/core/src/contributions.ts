/**
 * 贡献 spec 的内核契约：只要求一个 id。
 *
 * id 是**局部名**（如 'context'、'group-hint'），注册时由门面自动冠以
 * `${ctx.id}/` 前缀成为全局键（见 {@link ContributionHandle.key}）——
 * **spec.id 侧**的抢注/顶替由此杜绝，无需归属权校验（与 provide 的
 * entryId 前缀约定同源，但由构造保证而非 warn）。
 *
 * 边界如实声明：该保证以 ctx.id 为信任锚。`ctx.fork(id)` 与
 * `ctx.useModule(module)`（childId = `${父id}#${模块名}`）都不保证 ctx.id
 * 唯一，重复 ctx.id 会使两方共用同一命名空间、后注册者替换先注册者。
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

interface Registration {
  spec: ContributionSpec;
  contextId: string;
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
 * 注册表本身只认 {@link ContributionSpec}（不透明数据面）；按贡献点键精化
 * spec 类型是 Context 门面的职责（经 types/contributions.ts 的
 * ContributionPointMap declaration merging）。
 */
export class ContributionRegistry {
  /** point → 全局键 → 注册项 */
  private points = new Map<string, Map<string, Registration>>();

  /**
   * 注册一份贡献，返回 dispose 函数。
   *
   * 全局键 = `${contextId}/${spec.id}`；同键重复注册为替换（幂等），
   * 旧注册的 dispose 函数在替换后失效（不会误删新注册）。
   */
  register(point: string, spec: ContributionSpec, contextId: string): () => void {
    // 空 id 会静默同键碰撞；含 '/' 的局部 id 可构造出与他人 `${contextId}/${id}`
    // 相同的全局键（如 ctx 'a' + id 'b/c' 撞 ctx 'a/b' + id 'c'），打破
    // 「spec.id 侧无法顶替他人贡献」的保证——两者都必须在注册期拒绝。
    if (!spec.id || spec.id.includes('/')) {
      throw new TypeError(`贡献点 "${point}" 的 spec.id 必须非空且不含 '/'（得到 "${spec.id}"）`);
    }
    let byKey = this.points.get(point);
    if (!byKey) {
      byKey = new Map();
      this.points.set(point, byKey);
    }
    const key = `${contextId}/${spec.id}`;
    const entry: Registration = { spec, contextId };
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
  collect(point: string): ReadonlyArray<ContributionHandle> {
    const byKey = this.points.get(point);
    if (!byKey) return [];
    return [...byKey.keys()].sort().map(key => ({ key, spec: (byKey.get(key) as Registration).spec }));
  }

  /**
   * 按 contextId 移除该上下文的全部贡献（插件卸载清扫）。
   */
  unregisterByContext(contextId: string): void {
    for (const [point, byKey] of this.points) {
      for (const [key, entry] of byKey) {
        if (entry.contextId === contextId) byKey.delete(key);
      }
      if (byKey.size === 0) this.points.delete(point);
    }
  }
}
