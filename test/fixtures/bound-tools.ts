import type { BoundTools, RegisteredTool, ToolService } from '@aalis/api-tools';

type ToolSpec = Omit<RegisteredTool, 'pluginName'>;

/**
 * 单测内部函数用的 tools 业务层替身：只关心「登记了什么」与「读 API 给什么」。读 API 转给 current，
 * 没有配置 current 时调用即抛错；随激活撤回、换人重挂要经真实 App 装载才测得到。
 */
export function stubBoundTools(options: { onRegister?(tool: ToolSpec): void; current?: ToolService } = {}): BoundTools {
  const missing = (): never => {
    throw new Error('替身没有配置 tools 提供者');
  };
  const reads: ToolService = options.current ?? {
    register: missing,
    registerGroup: missing,
    getDefinitions: missing,
    getSummaries: missing,
    getAll: missing,
    execute: missing,
    setExecutionGuard: missing,
    getGroups: missing,
  };
  return Object.assign(Object.create(reads) as BoundTools, {
    register: (tool: ToolSpec) => {
      options.onRegister?.(tool);
      return () => {};
    },
    registerGroup: () => () => {},
  });
}
