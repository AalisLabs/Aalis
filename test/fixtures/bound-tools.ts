import type { BoundTools, RegisteredTool, ToolService } from '@aalis/api-tools';

type ToolSpec = Omit<RegisteredTool, 'pluginName'>;

/**
 * 单测内部函数用的 tools 绑定接口替身：只关心「登记了什么」与「读 API 给什么」，
 * 生命周期相关的能力（follow、退订）给空实现——要测这些得经真实 App 装载。
 */
export function stubBoundTools(options: { onRegister?(tool: ToolSpec): void; current?: ToolService } = {}): BoundTools {
  return {
    register: tool => {
      options.onRegister?.(tool);
      return () => {};
    },
    registerGroup: () => () => {},
    follow: () => () => {},
    all: () => [],
    current: options.current,
    require: () => {
      if (!options.current) throw new Error('替身没有配置 tools 提供者');
      return options.current;
    },
  };
}
