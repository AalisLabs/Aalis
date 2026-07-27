// ============================================================
// 贡献点扩展点（空接口；由各 plugin-*-api 通过 declaration merging 注入
// 「贡献点名 → spec 类型」，与 HookContextMap 同构）。
//
// 键名按域命名空间化（如 'agent:prompt'）；spec 类型须含 `id: string`
// （内核契约 ContributionSpec），其余字段（槽位/构建函数等）语义全在域层。
// core 里不出现任何领域词汇——出现即越界。
// ============================================================

export interface ContributionPointMap {}
