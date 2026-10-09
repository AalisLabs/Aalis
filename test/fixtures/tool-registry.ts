import type { Logger } from '../../packages/core/src/index.js';
import { BackgroundTasks, DEFAULT_LIMITS } from '../../packages/plugin-tools/src/background.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';

/** 插件之外直接构造的工具注册表：后台任务登记不发事件、只记在内存，上限取默认 */
export function makeToolRegistry(logger: Logger): ToolRegistry {
  const tasks = new BackgroundTasks({ logger, events: { emit: async () => {} }, limits: DEFAULT_LIMITS });
  return new ToolRegistry(logger, tasks);
}
