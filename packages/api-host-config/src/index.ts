/**
 * @aalis/api-host-config — 宿主配置文档契约
 *
 * 配置文档记的是「下次启动用什么」：插件配置、禁用名单、服务偏好与各域业务字段（owners 等）。
 * 运行态（实例配置、禁用态、服务偏好）在 core；文档与落盘在宿主。Node 宿主 @aalis/runtime 把文档
 * 作为 host-config 服务独占登记在根上；别的宿主要给插件读写文档，自己 provide 本描述符。
 * 管理类插件在 uses 里显式声明才拿得到，没有宿主提供时声明 optional 的插件要自行降级。
 */

import { defineService } from '@aalis/core';

/**
 * 宿主配置文档。本包只声明宿主层字段；各域业务字段经 declaration merging 注入：
 *
 * ```ts
 * declare module '@aalis/api-host-config' {
 *   interface AalisConfig {
 *     owners?: Array<{ platform: string; userId: string }>;
 *   }
 * }
 * ```
 *
 * `[key: string]: unknown` 兜底：没做 declaration merging 的插件也能读到自己的顶层字段（类型为 unknown）。
 */
export interface AalisConfig {
  name: string;
  logLevel: string;
  plugins: Record<string, Record<string, unknown>>;
  /** 被禁用的插件实例 id；宿主登记插件时据此以禁用态登记 */
  disabledPlugins?: string[];
  /** 服务偏好：serviceName → preferred contextId；宿主启动时应用到服务容器 */
  servicePreferences?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * 插件可见的配置文档读写面。
 *
 * 写方法只改文档，不改运行态；管理动作（plugins.enable / disable / updateConfig、services.prefer）
 * 也只改运行态，不写文档。要跨重启保留，调用方两边都写：先做管理动作，成功后写文档，再 save()。
 * 按实例 id 取放的方法遇到 `__proto__` / `constructor` / `prototype` 这类 id 抛「插件 id 不合法」。
 */
export interface HostConfig {
  /**
   * 宿主的裁剪政策：为 true 时，宿主同步插件配置会按 configSchema 删掉 schema 外字段；宿主不声明时按 true 处理
   * （与 Node 宿主的缺省一致）。替宿主写插件配置的管理面（如 WebUI）按它决定裁不裁，与宿主同一政策。
   */
  readonly trimUnknownFields?: boolean;
  get<K extends keyof AalisConfig>(key: K): AalisConfig[K];
  getAll(): Readonly<AalisConfig>;
  set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void;
  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(instanceId: string): T;
  setPluginConfig(instanceId: string, config: Record<string, unknown>): void;
  removePluginConfig(instanceId: string): void;
  isPluginDisabled(instanceId: string): boolean;
  setPluginEnabled(instanceId: string, enabled: boolean): void;
  getServicePreferences(): Record<string, string>;
  setServicePreference(name: string, contextId: string): void;
  removeServicePreference(name: string): void;
  /**
   * 持久化当前文档。返回的 Promise 兑现时保存已完成（宿主不持久化时立即兑现、不写盘）；失败以拒绝传出，调用方应 await。
   * 配置源有尚未生效的外部修改而拒写时以 {@link ConfigSaveRefusedError} 拒绝（用 {@link isConfigSaveRefused} 判定），
   * 其它失败（如写入出错）原样传出。
   * 失败时提供方已记一笔日志（拒写记告警，其它记 error）并把拒绝标记为已处理：不 await 的调用不会变成未处理拒绝。
   * 不保证并发保存的先后，也不负责与外部编辑合并。
   */
  save(): Promise<void>;
}

/**
 * 宿主因配置源有尚未生效的外部修改而拒绝保存：可预期的拒绝（盘上内容受保护），不是落盘故障。
 * 宿主抛它；调用方用 {@link isConfigSaveRefused} 与写入失败等其它拒绝区分，不用 instanceof。
 */
export class ConfigSaveRefusedError extends Error {
  override name = 'ConfigSaveRefusedError';
}

/**
 * 判定 `save()` 的拒绝是否为宿主拒写 —— 契约级判据，全体消费者复用，勿各自重抄。
 *
 * 只按 `name` 判定：进程里装有两份本包时，宿主抛出的是它解析到的那份类，换一份做 instanceof 就不成立，
 * 按 name 两份都认得。instanceof 认得出的实例 name 同样相符，所以不另留 instanceof 快路径。
 */
export function isConfigSaveRefused(err: unknown): boolean {
  return (err as { name?: unknown } | null | undefined)?.name === 'ConfigSaveRefusedError';
}

export const hostConfig = defineService<HostConfig>('host-config');
