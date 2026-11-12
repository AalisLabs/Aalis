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
}

/** 插件管理面 getStatus 返回的一条：一个插件实例此刻的状态 */
export interface PluginStatusEntry {
  name: string;
  instanceId: string;
  /** 展示值（见 {@link PluginDefinition.displayName}） */
  displayName?: unknown;
  state: PluginState;
  provides?: string[];
  reusable?: boolean;
  /**
   * 完整 uses 声明的快照，依赖信息只在这里：所有服务统一参与依赖解析，key 保留 apply 参数名；required 参与激活闸，
   * optional（包了 optional() 的）不参与
   */
  uses: Array<{ key: string; service: string; kind: 'required' | 'optional' }>;
  /** 同 {@link PluginEntry.error} */
  error?: string;
  /** 同 {@link PluginEntry.failure} */
  failure?: unknown;
  /** 激活超过 `AppOptions.slowThresholdMs` 仍未完成、已转入后台（state 为 activating）时为 true，否则不给 */
  slow?: boolean;
  /**
   * 旧实例关完仍有工作没落定（清理或被拆的初始化超过 `AppOptions.disposeTimeoutMs`）时为 true，否则不给。state 照常是
   * 目标态；它停下之前同一 id 不启动新实例，停下后按目标态继续。与 `slow` 对称：一个是新实例没启动完，一个是旧实例没停完
   */
  lingering?: boolean;
  // 配置详情（config / configSchema）不属状态摘要——
  // 消费者经 getPlugin(instanceId) 从 entry.config / entry.definition 读取。
}

/**
 * 插件管理服务接口
 *
 * 管理类插件在 uses 里声明 `pluginsService` 获取。内部由 core 的 PluginManager 提供，消费方不应直接 import App 类。
 *
 * 管理动作（register / unload / enable / disable / bounce / updateConfig）的返回值同一口径：
 * **false = 主体不在注册表，或本次动作被状态 / 政策规则挡下**；**true = 其余，含主体已在目标态的幂等情形**。
 * 每个 false 分支都已记一笔日志，调用方不必重复，按级别分：
 * - error：注册被拒、该插件或实例因此不会运行——定义或实例 id 校验失败（含定义里有另一份 core 造的对象）、未声明 reusable
 *   的多实例、多实例 id 不是「name:后缀」、注册时配置无效（不是纯对象或无法拷贝）；
 * - warn：重名（重复请求被忽略）、disabled 态的 bounce、updateConfig 的新配置无效；
 * - debug：主体不在注册表、'disposed' 终态（含卸载在途）、停机中。
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
  /**
   * 获取单个插件条目：调用时刻的浅快照，之后的状态变化不改它（要最新的就再调一次，或看 getStatus），写它也进不了注册表。
   * `config` 是当前配置的一份拷贝；`definition` 是登记时的定义对象，core 已在登记时取定它的字段，改它不生效。改配置走 updateConfig
   */
  getPlugin(instanceId: string): PluginEntry | undefined;
  /**
   * 增量重载单个插件：按现有配置拆掉当前激活 → 转 pending → 重算后重新激活。换配置走 updateConfig。
   * 插件要重启自己就调它。不换代码——要换代码走 `unload` + `register`。disabled 态被政策挡下（warn，返回 false）。
   * 不得在插件 apply / onReady 回调 / onDrain / onDispose 内 await 针对自身或自身用到的任何提供者（required、optional 或
   * follow 跟随）的本动作：拆卸可能要等这些回调返回，两边至多互等到宽限超时（`disposeTimeoutMs` 为 0 时一直等），旧实例
   * 超过宽限仍未停下（`lingering`）。对别的插件发起本动作，在本激活关闭期间等它同样会互等：动作的对象、或用到它的插件，
   * 与本插件在同一批关闭里且排在本插件之后时，那份计划要等它们关完。一批里有谁、谁排在后面，回调里看不出来：
   * onDrain / onDispose 里要发起本动作就不要等它；apply / onReady 里等它要与本激活的 `signal` 赛跑。
   */
  bounce(instanceId: string): Promise<boolean>;
  /**
   * 换上新的运行配置并按 bounce 重启，调用约束同 bounce。入参须为纯对象并被拷贝，不是纯对象或拷贝失败时保留旧配置、返回 false。disabled 态只换配置、
   * 保持禁用并返回 true，启用时按新配置激活
   */
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
   * 不得在插件 apply / onDispose 内调用（互等死锁）。onReady 回调里可以等，但要与本激活的 `signal` 赛跑：等待期间本激活
   * 开始关闭时，关闭等这个回调落定、回调等静置、静置等这次关闭，互等到宽限超时（`disposeTimeoutMs` 为 0 时一直等）。
   */
  idle(): Promise<void>;
  /**
   * 插件状态可能变了时调用 fn：每轮重算收敛后一次（停机那一轮不通知），只登记了禁用条目、不必重算时也调一次；回调里重读
   * getStatus，可以 await idle()。
   * 规则同选择层的 watch：登记时不调；下一个微任务调，期间的多次合并成一次；已退订的、订阅方已开始关闭的不调；
   * 抛错与拒绝只记在订阅方名下。返回退订，随订阅方的激活撤回
   */
  watch(fn: () => void | Promise<void>): () => void;
}
