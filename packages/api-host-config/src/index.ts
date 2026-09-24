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
   * 持久化当前文档。返回的 Promise 兑现时保存已完成；失败以拒绝传出，调用方应 await。
   * 失败时提供方已记一笔 error 并把拒绝标记为已处理：不 await 的调用不会变成未处理拒绝。
   * 不保证并发保存的先后，也不负责与外部编辑合并。
   */
  save(): Promise<void>;
}

export const hostConfig = defineService<HostConfig>('host-config');
