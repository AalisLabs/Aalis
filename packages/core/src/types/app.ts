// ----- App 服务接口 -----

import type { PluginEntry, PluginState } from './plugin.js';
import type { PluginDefinition } from '../composition/plugin-definition.js';

/**
 * App 生命周期 + 配置 接口
 *
 * 管理类插件在 uses 里声明 `appService` 获取，用于触发应用级操作，无需直接导入 App 类。
 */
export interface AppService {
  /** 停止应用 */
  stop(): Promise<void>;
  /**
   * 重启应用（延迟 spawn 新实例后退出当前实例；具体机制由宿主注入的 RestartStrategy 决定）。
   *
   * @param opts.rollback 不透明回滚凭据，仅在「新实例未能接管」时由策略消费。
   *   形状由宿主策略与发起方约定，core 只透传（见 `RestartStrategy`）。
   */
  restart(opts?: { rollback?: unknown }): void;
  /**
   * 持久化当前配置。返回的 Promise 兑现时保存已完成：同步 provider 立即完成，异步 provider 等其落定；
   * provider 失败以拒绝传出，**调用方应 await**（此前异步 provider 的失败被静默吞掉）。
   * 不保证并发保存的先后与外部编辑的合并——那是宿主 provider 的契约，不在此承诺。
   */
  saveConfig(): Promise<void>;
}

/** PluginManager 暴露给插件消费的接口 */
export interface PluginStatusEntry {
  name: string;
  instanceId: string;
  displayName?: string;
  state: PluginState;
  provides?: string[];
  reusable?: boolean;
  /** 完整 uses 声明的快照；所有服务统一参与依赖解析，key 保留 apply 参数名。 */
  uses: Array<{ key: string; service: string; kind: 'required' | 'optional' }>;
  /** 参与激活闸的依赖服务名（uses 里未包 optional 的外部服务；能力披露用：该插件「要调用哪些子系统」） */
  requiredServices?: string[];
  /** 不参与激活闸的依赖服务名（uses 里包了 optional 的） */
  optionalServices?: string[];
  error?: string;
  // 配置详情（config / configSchema）不属状态摘要——
  // 消费者经 getPlugin(instanceId) 从 entry.config / entry.definition 读取。
}

/**
 * 插件管理服务接口
 *
 * 管理类插件在 uses 里声明 `pluginsService` 获取。内部由 core 的 PluginManager 提供，消费方不应直接 import App 类。
 *
 * 管理动作（register / unload / enable / disable / bounce / updateConfig）的返回值同一口径：
 * **false = 主体不在注册表，或本次动作被状态 / 政策规则挡下**（重名、未声明 reusable 的多实例、
 * 'disposed' 单向终态、disabled 态 bounce、定义或实例 id 校验失败）；**true = 其余，含主体已在目标态的幂等情形**。
 * 每个 false 分支都已记一笔日志（政策挡下 warn，主体不存在与 'disposed' 在途 debug），调用方不必重复。
 * true 只说明请求已受理，不说明激活已落定——那看 `idle()`。
 * 停机进行中，unload / disable 汇入停机计划后立即返回 true（不等待拆卸完成，拆卸由停机计划执行）；register / bounce 返回 false。
 */
export interface PluginManagerService {
  /** 获取所有已注册插件的状态 */
  getStatus(): PluginStatusEntry[];
  /** 获取单个插件条目 */
  getPlugin(instanceId: string): PluginEntry | undefined;
  /**
   * 增量重载单个插件：拆掉当前激活 → 转 pending → 重算后重新激活。`opts.config` 同时写回配置。
   * 插件要重启自己就调它。不换代码——要换代码走 `unload` + `register`。
   */
  bounce(instanceId: string, opts?: { config?: Record<string, unknown> }): Promise<boolean>;
  /** 更新插件配置并热重载：`bounce(instanceId, { config })` 的薄壳 */
  updateConfig(instanceId: string, config: Record<string, unknown>): Promise<boolean>;
  /** 启用插件 */
  enable(instanceId: string): Promise<boolean>;
  /** 禁用插件 */
  disable(instanceId: string): Promise<boolean>;
  /** 彻底卸载插件：拆掉激活并从注册表移除（用于市场卸载，区别于 disable 仅置禁用态） */
  unload(instanceId: string): Promise<boolean>;
  /** 注册并尝试激活一份插件定义（多实例经 instanceId 区分；供管理面基于 register/unload 组合实例编排） */
  register(definition: PluginDefinition, config?: Record<string, unknown>, instanceId?: string): Promise<boolean>;
  /**
   * 等待插件状态机静置（无在飞/排队的 recompute）。变更 API 在 flight 在飞时
   * 排队早退，需要"尘埃落定后再观察"的调用方在变更后 await 本方法。
   * 不得在插件 apply / onDispose 内调用（互等死锁）。
   */
  idle(): Promise<void>;
}
