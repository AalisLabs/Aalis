// ===== Cron 引擎服务契约 =====
//
// scheduler / workflow 等插件共享的 cron 解析与订阅协议。
// 实现见 @aalis/plugin-cron-engine。

import type { Context } from '@aalis/core';
import type { ValidateResult } from '@aalis/util-cron';

// ─── 类型转出 ───
//
// cron 表达式的解析/匹配是与 Aalis 无关的通用算法，实现在 @aalis/util-cron；
// 本契约包只管订阅协议。这里转出两个类型是因为下方 `CronEngine.validate` 的
// 签名要用到——契约应自描述，消费者不必为读懂返回值去依赖 util 包。
// 函数不转发：仓内两个消费者直连 util 包，转发层只会是没人走的死面。
export type { CronExprKind, ValidateResult } from '@aalis/util-cron';

// ─── 服务接口 ───

/** 订阅 / nextFireTime 的可选参数。 */
export interface CronSubscribeOptions {
  /**
   * IANA 时区名（如 `Asia/Shanghai`、`Europe/London`）。
   * 空串或未传时使用进程本地时区，与历史行为兼容。
   * 只对 5 字段 cron 生效；`@every` interval 与时区无关。
   */
  timeZone?: string;
}

export interface CronEngine {
  /**
   * 订阅一个 cron / @every 表达式。返回 dispose 函数。
   * 失败时抛 Error（建议先用 validateCronExpr 校验）。
   *
   * - 5 字段 cron 或别名：挂接到引擎共享的整分钟 tick
   * - `@every Ns/Nm/Nh`：单独 setInterval
   * - `options.timeZone` 用于在指定时区评估 cron（默认进程本地）
   */
  subscribe(expr: string, handler: () => void | Promise<void>, options?: CronSubscribeOptions): () => void;

  /** 表达式校验。 */
  validate(expr: string): ValidateResult;

  /**
   * 从给定时间起向前找下一次触发时间戳（ms）。
   * - cron：在 `lookaheadMinutes`（默认 366*24*60）内未命中返回 null
   * - interval：返回 `from + intervalSeconds*1000`
   * - `options.timeZone` 与 subscribe 语义相同
   */
  nextFireTime(expr: string, from?: Date, lookaheadMinutes?: number, options?: CronSubscribeOptions): number | null;
}

// ----- 服务类型注册 -----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'cron-engine': CronEngine;
  }
}

export function useCronEngine(ctx: Context): CronEngine {
  const svc = ctx.getService<CronEngine>('cron-engine');
  if (!svc) throw new Error('cron-engine 服务未就绪，请在 inject.required 中声明 "cron-engine"');
  return svc;
}
