import { type LogEntry, LogHub } from '@aalis/core';

/**
 * 启动期 bootstrap buffer：在任何 sink（file/console）装好之前订阅 LogHub，
 * 把启动期产生的所有 LogEntry 暂存。等所有 sink 装好后调用 `dispose()`
 * 解除订阅并清空——之后所有日志直接通过 LogHub.onEntry 走 sink 实时落盘 / 渲染。
 *
 * 设计要点：
 * - **进程级单例**：通过 module-level state 实现，必须由 `src/index.ts` 在最早
 *   时机调用 `installBootstrapBuffer()` 一次（在 Logger 第一次被调用之前）。
 * - **多 sink 共享**：每个 sink 装载时调用 `snapshot()` 拿到当前已捕获条目副本
 *   并自行消费（写文件 / 渲染 stdout）；snapshot 不改变状态，可任意次。
 * - **显式 dispose**：所有 sink 装好后由 host 显式 `dispose()` —— 之后 buffer
 *   不再接收新条目，但已订阅的 sink 通过 `LogHub.onEntry` 继续收实时事件。
 * - **核心零状态**：LogHub 自身不再持有 buffer，bootstrap 这种"短暂状态"是
 *   runtime 关注点，不污染 core。
 */
interface BootstrapBuffer {
  /** 当前已捕获 entries 的副本。可重复调用。 */
  snapshot(): LogEntry[];
  /** 解除订阅 + 清空。重复调用幂等。 */
  dispose(): void;
}

let installed: BootstrapBuffer | null = null;

/**
 * 安装 bootstrap buffer。必须在所有日志产生之前调用（即 `src/index.ts` 顶部）。
 * 重复调用返回同一实例。
 */
export function installBootstrapBuffer(hub: LogHub = LogHub.default): BootstrapBuffer {
  if (installed) return installed;

  let entries: LogEntry[] = [];
  let disposed = false;
  const off = hub.onEntry(entry => {
    if (!disposed) entries.push(entry);
  });

  const handle: BootstrapBuffer = {
    snapshot() {
      return entries.slice();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      entries = [];
      off();
    },
  };

  installed = handle;
  return handle;
}

/** 获取已安装的 bootstrap buffer。未安装则返回空 stub（snapshot 永远空）。 */
export function getBootstrapBuffer(): BootstrapBuffer {
  if (installed) return installed;
  return { snapshot: () => [], dispose: () => {} };
}

/** 测试钩子：重置 installed 状态。仅供单元测试使用。 */
export function __resetBootstrapBufferForTests(): void {
  installed?.dispose();
  installed = null;
}
