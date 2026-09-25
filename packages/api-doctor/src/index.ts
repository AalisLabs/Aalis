/**
 * @aalis/api-doctor — 诊断子系统的公共类型与消费者帮手
 *
 * 设计动机：
 *   plugin-doctor 是开放注册中心（DoctorService.registerCheck）。其它插件应
 *   贡献自己领域的检查项（例如 storage 检查存储根可写、embedding-ollama 检查
 *   模型可用），而不是把所有逻辑塞回 doctor 内部。
 *
 *   为避免 storage 等下游插件直接 runtime depend 实现包 plugin-doctor
 *   （会形成「实现包 ↔ 业务插件」的双向耦合），仿照 api-storage /
 *   api-commands 的模式抽出本 api 包，仅含类型 + 服务描述符 `doctor`
 *   （检查项的登记随激活撤回、doctor 未上线时排队到它上线）。
 *
 *   AalisEvents 的模块增强统一在本文件做，避免多包
 *   重复声明导致 TS 合并冲突。
 */

import type { ServiceRef } from '@aalis/core';
import { defineService, serviceRef } from '@aalis/core';

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
  /** 执行函数：返回 1~N 条结果（一个 spec 可输出多条相关 check）。要用到的能力由注册方闭包带入 */
  run(): Promise<CheckResult | CheckResult[]> | CheckResult | CheckResult[];
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
  interface AalisEvents {
    /** 一次诊断完成后发射，供 WebUI 等订阅者即时刷新 */
    'doctor:updated': [info: { generatedAt: string; summary: { ok: number; warn: number; error: number } }];
  }
}

// ===== 服务描述符（按激活绑定）=====

/** `doctor` 的绑定接口：调用那一半是 ServiceRef，登记检查项自动归属这次激活 */
export interface BoundDoctor extends ServiceRef<DoctorService> {
  /** 登记一条检查项：同 id 替换，提供者换人自动重挂，随激活撤回 */
  registerCheck(spec: CheckSpec): () => void;
}

export const doctor = defineService<DoctorService, BoundDoctor>('doctor', port => {
  const checks = port.registrar<CheckSpec>({
    key: spec => spec.id,
    register: (service, spec) => service.registerCheck(spec),
  });
  return serviceRef(port, { registerCheck: (spec: CheckSpec) => checks.add({ pluginName: port.id, ...spec }) });
});
