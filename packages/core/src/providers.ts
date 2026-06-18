import type { AalisConfig } from './config.js';
import type { PluginModule } from './plugin.js';

/**
 * `@aalis/core` 注入点（host providers）。
 *
 * 把"配置从哪里来 / 插件从哪里来 / 怎么重启"这三件 I/O 相关的事
 * 抽成接口，由宿主（@aalis/runtime 或外部嵌入者）实现并注入。core 本身
 * 不再 import 任何 `node:fs` / `node:path` / `node:url` / `node:child_process`
 * / `yaml`，可在浏览器、单文件二进制、嵌入式集成等场景里运行。
 *
 * 设计原则：
 * - **同步优先**：能同步就同步（fs sync 读 yaml 完全可接受）；异步留给真异步源
 *   （HTTP、远程配置中心等）。
 * - **可选能力**：`save` / `watch` / `reload` 都标记为可选；只读宿主可以不提供。
 * - **opaque metadata**：descriptor.source 等字段是 loader 自己理解的字符串；core 不解释。
 */

// ============================================================
// 配置提供者
// ============================================================

/**
 * 配置提供者：负责"持久化层"。core 内部的 `ConfigManager` 持有运行时
 * 解析后的 `AalisConfig` 快照，所有读写都走自己的内存结构；
 * `save()` / `watch()` 才转交给 provider。
 *
 * 因此 provider 不必提供 `load()`——`AalisConfig` 由宿主在构造 `App` 之前
 * 自己加载好传进来即可。这让 core 完全无视"配置从哪里读"的细节。
 */
export interface ConfigProvider {
  /**
   * 持久化当前完整 config 快照。
   *
   * 实现可以做：写文件、PUT 到 HTTP 端点、写 KV 存储等。
   * 不提供时表示宿主拒绝持久化（典型场景：内存配置 / 只读部署）。
   */
  save?(config: AalisConfig): void | Promise<void>;

  /**
   * 订阅外部对配置源的变更（其他进程改了配置文件、远端推送等）。
   *
   * 当 provider 检测到 config 已变化时调用 `onChange(next)`，
   * core 的 ConfigManager 会用新快照重置内部状态并触发热重载。
   *
   * 返回的 dispose 函数会在 `App.stop()` 时被调用。
   */
  watch?(onChange: (next: AalisConfig) => void): () => void;
}

// ============================================================
// 插件加载器
// ============================================================

/**
 * 已发现但尚未导入的插件条目。`source` 是 loader 自己理解的字符串
 * （fs loader 用绝对路径，URL loader 用 URL，内存 loader 用 module 别名）。
 * core 仅用它在 `reload()` 调用时回传——不解释含义。
 */
export interface PluginDescriptor {
  /** 插件模块名，与 `PluginModule.name` 一致；core 用此匹配多实例配置 */
  name: string;
  /** 给 loader 自己用的不透明定位串 */
  source: string;
  /** loader 可挂任意辅助元数据（cache key、版本号、manifest 等） */
  metadata?: Record<string, unknown>;
}

/**
 * 插件加载器：负责"插件从哪里来"。
 *
 * - `discover()` 列出当前可用的插件条目
 * - `load(descriptor)` 把条目 import 成 `PluginModule`
 * - `reload(descriptor)` 可选——支持热重载（fs loader 用 mtime 做 cache buster）
 */
export interface PluginLoader {
  discover(): Promise<PluginDescriptor[]>;
  load(descriptor: PluginDescriptor): Promise<PluginModule | null>;
  /** 热重载——不提供时 `App.rescanPlugins()` 会退化为 `load()` */
  reload?(descriptor: PluginDescriptor): Promise<PluginModule | null>;
}

// ============================================================
// 重启策略
// ============================================================

/**
 * 重启策略：`App.restart()` 把"如何重启"委托给宿主。
 *
 * - Node 进程宿主：spawn 一个新进程然后退出
 * - 浏览器宿主：`location.reload()`
 * - 嵌入式宿主：可能就是 noop，或者通知外层重新创建 App
 *
 * `restart(opts.stop)` 由 App 传入"先停掉当前实例"的回调；
 * **时序由 strategy 决定**——例如 HTTP 宿主可能想先延迟几百毫秒让响应返回客户端再 stop，
 * CLI/嵌入式宿主可能直接 `await stop()` 后立刻重启，core 不再硬编码时延。
 */
export interface RestartStrategy {
  restart(opts: { stop: () => Promise<void> }): void | Promise<void>;
}
