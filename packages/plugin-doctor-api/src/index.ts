/**
 * @aalis/plugin-doctor-api — 诊断子系统的公共类型与消费者帮手
 *
 * 设计动机：
 *   plugin-doctor 是开放注册中心（DoctorService.registerCheck）。其它插件应
 *   贡献自己领域的检查项（例如 storage 检查存储根可写、commands 检查指令
 *   覆盖配置是否孤立），而不是把所有逻辑塞回 doctor 内部。
 *
 *   为避免 storage/commands 等下游插件直接 runtime depend 实现包 plugin-doctor
 *   （会形成「实现包 ↔ 业务插件」的双向耦合），仿照 plugin-storage-api /
 *   plugin-commands-api 的模式抽出本 api 包，仅含类型 + 一个 useDoctorService
 *   helper（懒注册、doctor 未上线时延后到 whenService 触发）。
 *
 *   ServiceCapabilityMap / AalisEvents 的模块增强统一在本文件做，避免多包
 *   重复声明导致 TS 合并冲突。
 */

import type { Context } from '@aalis/core';

// ===== 公共类型 =====

export type CheckLevel = 'ok' | 'warn' | 'error';
export type CheckCategory = 'env' | 'filesystem' | 'plugins' | 'config' | 'service' | 'other';

export interface CheckResult {
  id: string;
  category: CheckCategory;
  level: CheckLevel;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  generatedAt: string;
  summary: { ok: number; warn: number; error: number };
  checks: CheckResult[];
}

/** 检查项定义：插件通过 `registerCheck` 注册到 DoctorService */
export interface CheckSpec {
  /** 唯一 id，如 'memory.connectivity'；重复注册以最后一次为准 */
  id: string;
  /** 检查分类，影响表格分组与默认排序 */
  category: CheckCategory;
  /** 可选标签：仅用于日志/调试显示 */
  label?: string;
  /** 来源插件名，自动由 DoctorService 注入；外部传入也可 */
  pluginName?: string;
  /** 执行函数：返回 1~N 条结果（一个 spec 可输出多条相关 check） */
  run(ctx: Context): Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[];
}

export interface DoctorService {
  /** 同步运行所有检查，返回报告 */
  runChecks(): Promise<DoctorReport>;
  /** 取上一次报告（未运行过返回 undefined） */
  getLastReport(): DoctorReport | undefined;
  /**
   * 注册检查项。返回 dispose 函数；同 id 重复注册以最后一次为准。
   * 其他插件应在 apply() 中调用以贡献自我诊断。
   */
  registerCheck(spec: CheckSpec): () => void;
  /** 列出当前所有已注册的检查项（id + category + pluginName） */
  listChecks(): Array<{ id: string; category: CheckCategory; pluginName?: string }>;
}

// ===== 模块增强 =====

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    doctor: 'diagnose';
  }
  interface AalisEvents {
    /** 一次诊断完成后发射，供 WebUI 等订阅者即时刷新 */
    'doctor:updated': [info: { generatedAt: string; summary: { ok: number; warn: number; error: number } }];
  }
}

// ===== Helper：useDoctorService =====

/**
 * 在 ctx scope 内注册一个诊断检查项；doctor 服务未就绪时延迟到 whenService 触发。
 * 返回的 dispose 既能在 doctor 已就绪时立即解注册，也能在 doctor 还未来时取消挂起的
 * whenService 订阅。
 *
 * 用法：
 *   useDoctorService(ctx).registerCheck({
 *     id: 'storage.roots',
 *     category: 'filesystem',
 *     async run() { ... }
 *   });
 *
 * 调用方应在 inject.optional 中声明 'doctor'，否则 doctor 重启时不会带动本插件。
 */
export interface ScopedDoctorService {
  /** 立即或延迟注册一条 check；返回 dispose */
  registerCheck(spec: CheckSpec): () => void;
}

export function useDoctorService(ctx: Context): ScopedDoctorService {
  return {
    registerCheck(spec: CheckSpec): () => void {
      const filledSpec: CheckSpec = { pluginName: ctx.id ?? spec.pluginName, ...spec };
      // 持续订阅 'doctor'：服务每次上线都重新挂 check；下线/dispose 时 whenService
      // 自动调用上次 cb 返回的解注册函数。
      return ctx.whenService<DoctorService>('doctor', svc => svc.registerCheck(filledSpec));
    },
  };
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    doctor: DoctorService;
  }
}
