// ============================================================
// failure.ts — core 自己的失败的 code 与构造（基础词汇，各层都可引用）
// ============================================================

/**
 * core 自己抛出的失败带的 `code`：普通 Error 挂上 `code` 与数据属性（Node 惯例），message 是给日志的中文诊断句；
 * 展示方按 code 给说明（core 不碰字典）。
 * - `required-retry-exhausted`：初始化期间 required 依赖反复缺失、自动重试用尽（插件的 failure）；`service` 是最后一次缺的服务
 * - `provides-not-registered`：激活完成时 provides 声明的服务没有登记；`services` 是缺的那些
 * - `exclusive-conflict`：服务为独占登记期间又登记同名提供者；`service`
 * - `service-unavailable`：业务句柄选不到提供者（name 为 `ServiceUnavailableError`）；`service`，指名或钉住的那一家另给 `provider`
 */
export type CoreFailureCode =
  | 'required-retry-exhausted'
  | 'provides-not-registered'
  | 'exclusive-conflict'
  | 'service-unavailable';

/** core 自己的失败：普通 Error 挂上 code 与数据属性；有导致它的错误时挂成 cause */
export function coreFailure(
  message: string,
  code: CoreFailureCode,
  data: Record<string, unknown>,
  cause?: unknown,
): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code }, data);
}
