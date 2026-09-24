// ============================================================
// @aalis/api-contributions — 贡献点契约
//
// 与 services 成对偶的数据原语：确定性枚举全量。登记表永不执行插件代码；
// 如何调用 spec（并行 / 隔离 / 超时）是收集方（贡献点 owner）的策略。
// 默认提供者：@aalis/plugin-contributions。
//
// 贡献点键由各 -api 包经 declaration merging 注入 ContributionPointMap：
//   declare module '@aalis/api-contributions' {
//     interface ContributionPointMap { 'agent:prompt': PromptContribution }
//   }
// ============================================================

import { defineService } from '@aalis/core';

/** 贡献点扩展点（空接口；由各 -api 包经 declaration merging 注入「贡献点名 → spec 类型」） */
export interface ContributionPointMap {}

/**
 * 贡献 spec 的契约：只要求一个 id。id 是**局部名**，登记时由绑定层冠以本激活 id 前缀成为全局键
 * `${激活 id}/${id}`，经门面登记无法顶替他人的贡献。
 */
export interface ContributionSpec {
  /** 局部幂等键：同一激活内同 id 重复登记 = 替换。必须非空且不含 `/`，违者登记期抛 `TypeError`。 */
  id: string;
}

/** collect 的枚举条目：全局键 + 登记时原样传入的 spec（不拷贝、不改写）。 */
export interface ContributionHandle<S extends ContributionSpec = ContributionSpec> {
  /** 全局键 `${激活 id}/${spec.id}`——归属标识与幂等键。 */
  readonly key: string;
  /** 注册方交付的 spec 本体（引用，非副本）。 */
  readonly spec: S;
}

/**
 * 提供者契约（登记表本体）。插件不直接调用：登记经 {@link contributions} 的绑定门面，
 * 它盖上本激活 id、随激活撤回。
 */
export interface ContributionRegistry {
  /** 按全局键 `${contextId}/${spec.id}` 登记；同键为替换。返回退订：同键已被替换时无动作。 */
  register(point: string, spec: ContributionSpec, contextId: string): () => void;
  /** 按全局键码元序枚举（快照；spec 按引用给出）。 */
  collect(point: string): ReadonlyArray<ContributionHandle>;
}

/** 空 id 会静默同键碰撞；含 '/' 的局部 id 可构造出与他人相同的全局键。门面与提供者共用这一道校验。 */
export function assertContributionId(point: string, id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id || id.includes('/')) {
    throw new TypeError(`贡献点 "${point}" 的 spec.id 必须非空且不含 '/'（得到 "${String(id)}"）`);
  }
}

/** `contributions` 的绑定接口 */
export interface Contributions {
  /** 向贡献点交付一份 spec（局部 id 自动冠本激活的前缀，同 id 重复交付为替换）；返回退订 */
  contribute<K extends string & keyof ContributionPointMap>(
    point: K,
    spec: ContributionPointMap[K] & ContributionSpec,
  ): () => void;
  /** 收集某贡献点的全部交付（快照，顺序是全局键的纯函数） */
  collect<K extends string & keyof ContributionPointMap>(
    point: K,
  ): ReadonlyArray<ContributionHandle<ContributionPointMap[K] & ContributionSpec>>;
}

export const contributions = defineService<ContributionRegistry, Contributions>('contributions', port => {
  // 账本键 = 贡献点 + 局部 id；id 不含 '/'，`${point}/${id}` 可唯一还原二者。
  const ledger = port.registrar<{ point: string; spec: ContributionSpec }>({
    key: ({ point, spec }) => `${point}/${spec.id}`,
    register: (registry, { point, spec }) => registry.register(point, spec, port.id),
  });
  return {
    contribute: (point, spec) => {
      // 窄化取 id：ContributionPointMap 为空时 K 落到 never，交叉塌成 never
      const { id } = spec as ContributionSpec;
      assertContributionId(point, id);
      return ledger.add({ point, spec });
    },
    collect: point =>
      port.require().collect(point) as ReadonlyArray<
        ContributionHandle<ContributionPointMap[typeof point] & ContributionSpec>
      >,
  };
});
