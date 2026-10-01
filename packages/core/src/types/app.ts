// ----- App 服务接口 -----

import type { PluginEntry, PluginState } from './plugin.js';
import type { PluginDefinition } from '../composition/plugin-definition.js';

/**
 * App 生命周期接口
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
  /** 激活超过 `AppOptions.slowThresholdMs` 仍未完成、已转入后台（state 为 activating）时为 true，否则不给 */
  slow?: boolean;
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
 * 'disposed' 单向终态、disabled 态不带配置的 bounce、定义或实例 id 校验失败、配置无法拷贝）；**true = 其余，含主体已在目标态的幂等情形**。
 * 每个 false 分支都已记一笔日志（政策挡下 warn，其中定义里有另一份 core 造的对象时按安装问题记 error；主体不存在、
 * 'disposed' 在途与停机中 debug），调用方不必重复。
 * true 只说明请求已受理，不说明激活已落定——那看 `idle()`。
 * beginShutdown 后（含停机完成后）新发起的六个管理动作一律立即返回 false，不修改状态或配置。
 * 清理由已有停机计划负责，等待完整停机应在外部 await App.stop()，不要在清理回调里等待自身。
 *
 * 管理动作只改运行态，不写配置文档。要跨重启保留（启停、新配置），调用方在动作成功后经 host-config
 * 写文档并落盘。
 */
export interface PluginManagerService {
  /** 获取所有已注册插件的状态 */
  getStatus(): PluginStatusEntry[];
  /** 获取单个插件条目 */
  getPlugin(instanceId: string): PluginEntry | undefined;
  /**
   * 增量重载单个插件：拆掉当前激活 → 转 pending → 重算后重新激活。`opts.config` 换成新的运行配置。
   * 插件要重启自己就调它。不换代码——要换代码走 `unload` + `register`。disabled 态只换上 `opts.config`、保持禁用，
   * 启用时按它激活；不带配置时被政策挡下（warn，返回 false）。停机进行中一律返回 false、不换配置（记 debug）。
   * 不得在插件 apply / onDrain / onDispose 内 await 针对自身或自身 required 提供者的本动作：拆卸要等这些回调返回，
   * 两边至多互等到宽限超时，apply 被判「未在宽限内停止」。
   */
  bounce(instanceId: string, opts?: { config?: Record<string, unknown> }): Promise<boolean>;
  /** 更新插件配置并热重载：`bounce(instanceId, { config })` 的薄壳，调用约束同 bounce；禁用态只换配置、保持禁用 */
  updateConfig(instanceId: string, config: Record<string, unknown>): Promise<boolean>;
  /** 启用插件 */
  enable(instanceId: string): Promise<boolean>;
  /** 禁用插件。调用约束同 bounce */
  disable(instanceId: string): Promise<boolean>;
  /** 彻底卸载插件：拆掉激活并从注册表移除（用于市场卸载，区别于 disable 仅置禁用态）。调用约束同 bounce */
  unload(instanceId: string): Promise<boolean>;
  /** 注册并尝试激活一份插件定义（多实例经 instanceId 区分；供管理面基于 register/unload 组合实例编排） */
  register(
    definition: PluginDefinition,
    config?: Record<string, unknown>,
    instanceId?: string,
    options?: { disabled?: boolean },
  ): Promise<boolean>;
  /**
   * 等待插件状态机静置（无在飞/排队的 recompute）。变更 API 在 flight 在飞时
   * 排队早退，需要"尘埃落定后再观察"的调用方在变更后 await 本方法。
   * 不等转入后台的激活（超过 slowThresholdMs 仍未完成的，以 activating、`slow: true` 可见）：它落定后另触发一次重算。
   * 不得在插件 apply / onDispose 内调用（互等死锁）。
   */
  idle(): Promise<void>;
}
