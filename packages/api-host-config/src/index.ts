/**
 * @aalis/api-host-config — 宿主配置文档契约
 *
 * 配置文档记的是「下次启动用什么」：插件配置、禁用名单、服务偏好与各域业务字段（owners 等）。
 * 运行态（实例配置、禁用态、服务偏好）在 core；文档与落盘在宿主。Node 宿主 @aalis/runtime 把文档
 * 作为 host-config 服务独占登记在根上；别的宿主要给插件读写文档，自己 provide 本描述符。
 * 管理类插件在 uses 里声明它；没有宿主提供时，声明 optional 的插件要自行降级。
 */

import { defineService, type PreferenceScope } from '@aalis/core';
import { type TextRef, textOf } from '@aalis/schema-i18n';
import { t } from './texts.js';

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
  /** 服务偏好：serviceName → preferred contextId；宿主启动时与配置热重载时应用到服务容器 */
  servicePreferences?: Record<string, string>;
  /** 本插件偏好：插件实例 id → (serviceName → preferred contextId)，只对那个插件生效；应用时机同 servicePreferences */
  pluginServicePreferences?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

/**
 * 插件可见的配置文档读写面。
 *
 * 文档与运行态是两种形态：schema 里 `secret: true` 的字段在文档里是引用 `{ $secret: '<键>' }`，值在宿主的
 * 密钥存储里，宿主交给插件（运行态、`caps.config`）之前解析成原值。本接口读写的都是文档形态。
 *
 * 改插件配置用 {@link HostConfig.applyPluginConfig}：它一步完成运行态、文档、密钥与落盘。
 * 其余写方法只改文档，不改运行态；管理动作（plugins.enable / disable、services.prefer）也只改运行态，
 * 不写文档。要跨重启保留启停与偏好，调用方两边都写：先做管理动作，成功后写文档，再 save()。
 * 按实例 id 取放的方法遇到 `__proto__` / `constructor` / `prototype` 这类 id 抛「插件 id 不合法」。
 * 按会话读带标记字段（configSchema 顶层写了 `session` 的字段）的插件声明 {@link ownHostConfig}，不声明本描述符。
 */
export interface HostConfig {
  /**
   * 宿主的裁剪政策：为 true 时，宿主同步插件配置会按 configSchema 删掉 schema 外字段；宿主不声明时按 true 处理
   * （与 Node 宿主的缺省一致）。替宿主写插件配置的管理面（如 WebUI）按它决定裁不裁，与宿主同一政策。
   */
  readonly trimUnknownFields?: boolean;
  /** 一个顶层字段（复制品：改它不影响文档，要改经 set 写回） */
  get<K extends keyof AalisConfig>(key: K): AalisConfig[K];
  /** 整份文档（复制品：改它不影响文档，要改经各写方法写回） */
  getAll(): Readonly<AalisConfig>;
  /**
   * 写一个顶层字段，只改文档。`plugins` 不经这里整块替换（会绕过 setPluginConfig 的形态检查），宿主抛错；
   * 改插件配置用 {@link HostConfig.applyPluginConfig} 或 setPluginConfig。存的是 value 的复制品，写完再改它不影响文档。
   * 与原值相同时不发 `host-config:changed`
   */
  set<K extends keyof AalisConfig>(key: K, value: AalisConfig[K]): void;
  /**
   * 实例在文档里的配置：密钥字段上是引用，不是原值（要原值读 `caps.config`）。返回复制品：改它不影响文档，
   * 要改经 {@link HostConfig.applyPluginConfig} 或 setPluginConfig 写回
   */
  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(instanceId: string): T;
  /**
   * 只写文档、不改运行态。只收文档形态：config 须为纯对象（null、数组、标量抛错）；宿主查得到实例的 schema 时，密钥字段上的非空明文（例如把 `caps.config`
   * 原样写回）抛错，不让原值进文档。存的是 config 的复制品。改配置要连运行态一起生效用 {@link HostConfig.applyPluginConfig}
   */
  setPluginConfig(instanceId: string, config: Record<string, unknown>): void;
  /**
   * 改一个实例的配置并让它生效：拆出密钥、更新运行态（未登记的后缀实例按同模块的定义登记）、写文档、落盘。
   *
   * `submitted` 是文档形态，密钥字段上另可写新值：
   * - 引用 `{ $secret: '<键>' }`：保持（或改指向那个键）；
   * - 非空明文：顶层与分组里的字段写进该实例当前文档在同一位置引用的键（键被别处共用时一并改到它们），
   *   没有引用时新建键；数组元素里的字段一律新建键；
   * - `''`、空 map、空 list：不是密钥值，原样写进文档。
   *
   * 运行态不受理（停机中、正在卸载、登记被拒）时返回 `refused`，文档与密钥都不改。
   * 受理后返回 `applied`：`reloaded` 为 false 表示解析出的配置与运行态相同、实例不在 error 态，没有重启（带标记的字段不进
   * 运行态，只改它们时不重启）；
   * `saveError` 是落盘失败（拒写用 {@link isConfigSaveRefused} 判定），此时改动已在运行态与文档里生效，只是没写进文件。
   * 参数不合法时抛错：id 不合法，submitted 不是纯对象（null、数组、标量），或实例没登记、也没有可用来新建它的同模块定义（模块须已登记且声明 reusable）。
   */
  applyPluginConfig(instanceId: string, submitted: Record<string, unknown>): Promise<ApplyPluginConfigResult>;
  /** 删掉实例的配置段，只改文档；落盘之后，不再被任何配置引用的密钥由宿主从密钥存储里一并删掉 */
  removePluginConfig(instanceId: string): void;
  isPluginDisabled(instanceId: string): boolean;
  setPluginEnabled(instanceId: string, enabled: boolean): void;
  /** 服务偏好（服务名 → 偏好的 contextId，复制品）。给 `scope.for`（插件实例 id）是那个插件的本插件偏好，不给是全局偏好 */
  getServicePreferences(scope?: PreferenceScope): Record<string, string>;
  setServicePreference(name: string, contextId: string, scope?: PreferenceScope): void;
  removeServicePreference(name: string, scope?: PreferenceScope): void;
  /**
   * 持久化当前文档（连同宿主的密钥存储，先写密钥）。返回的 Promise 兑现时保存已完成（宿主不持久化时立即兑现、不写盘）；失败以拒绝传出，调用方应 await。
   * 配置源有尚未生效的外部修改而拒写时以 {@link ConfigSaveRefusedError} 拒绝（用 {@link isConfigSaveRefused} 判定），
   * 其它失败（如写入出错）原样传出。
   * 失败时提供方已记一笔日志（拒写记告警，其它记 error）并把拒绝标记为已处理：不 await 的调用不会变成未处理拒绝。
   * 不保证并发保存的先后，也不负责与外部编辑合并。
   */
  save(): Promise<void>;
}

/** {@link HostConfig.applyPluginConfig} 的结果 */
export type ApplyPluginConfigResult =
  | { status: 'refused' }
  | { status: 'applied'; reloaded: boolean; saveError?: unknown };

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

/**
 * 只读窄面：本实例在配置文档里的那一段。与 {@link hostConfig} 同一个服务名、描述符对象不同，只供消费（写在插件的 uses 里），
 * 不能拿去 provide：那会在同一个服务名下造出第二家提供者，也会触发同名服务来自两个描述符的告警。
 */
export interface OwnHostConfig {
  /** 本实例在配置文档里的那一段（复制品，文档形态）；没有这一段时为空对象 */
  get(): Record<string, unknown>;
}

/** 见 {@link OwnHostConfig}。返回新对象，不经原型链挂到完整的提供者上；复制品由 getPluginConfig 交出 */
export const ownHostConfig = defineService<HostConfig, OwnHostConfig>('host-config', port => ({
  get: () => port.provider.getPluginConfig(port.id),
}));

/** 宿主配置文档在内存里改了哪里：只改了一个实例的配置段时带它的 id，其余（顶层字段、服务偏好、热重载换下整份文档）带 document */
export type HostConfigChange = { readonly instanceId: string } | { readonly document: true };

declare module '@aalis/core' {
  interface AalisEvents {
    /**
     * 宿主配置文档在内存里确实被改了，由宿主发，别的插件不发：host-config 的写方法改完、且改前改后确实不同时（写入相同的值
     * 不发；读法交出的是复制品，就地改了再写回照常发；setPluginEnabled 不发，启停由插件管理面的 watch 通知），applyPluginConfig
     * 受理且文档变了时（落盘失败也发，refused 不发），加载插件时补写了它的配置段之后（默认值、裁剪），配置热重载换下文档之后
     * （解析失败、文档没换不发）。不表示已落盘，也不保证恰好一次：一次写入可能连带几次。订阅方按 change 决定要不要重读
     */
    'host-config:changed': [change: HostConfigChange];
  }
}

/**
 * 落盘失败的那一句：拒写（{@link isConfigSaveRefused}）说已在运行态生效、未写入配置文件，并按 `reconcile` 说之后怎样与文件
 * 对齐（reload：修好文件后按文件内容重载；restart：重启时以文件内容为准）；其余失败说写入失败、改动保留在文档里
 */
export function saveFailureText(err: unknown, reconcile: 'reload' | 'restart'): TextRef {
  return isConfigSaveRefused(err)
    ? t('notWritten', { error: textOf(err), reconcile })
    : t('writeFailed', { error: textOf(err) });
}
