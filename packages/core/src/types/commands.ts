// ===== 指令服务接口 =====

import type { CommandDefinition, RegisteredCommand, CommandContext, ExecutionGuard } from './core.js';

/**
 * 指令服务接口
 *
 * 管理用户可调用的斜杠指令的注册、解析、执行。
 * 由 plugin-commands 创建 CommandRegistry 并注册为服务。
 */
export interface CommandService {
  /** 指令前缀 */
  prefix: string;
  /** 全局开关：是否将所有指令自动注册为 AI 工具 */
  globalAsTools: boolean;
  /** 指令→工具桥接回调 */
  onToolBridge?: (cmd: RegisteredCommand) => (() => void) | undefined;

  register(command: CommandDefinition, pluginName: string): () => void;
  unregisterByPlugin(pluginName: string): void;
  execute(name: string, ctx: CommandContext): Promise<string | undefined>;
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null;
  has(name: string): boolean;
  get(name: string): RegisteredCommand | undefined;
  getAll(): RegisteredCommand[];

  loadOverrides(overrides: Record<string, { authority?: number; safety?: string }>): void;
  setOverride(name: string, override: { authority?: number; safety?: string }): void;
  removeOverride(name: string): void;
  getOverrides(): Record<string, { authority?: number; safety?: string }>;

  /** 设置执行守卫（由权限插件注入） */
  setExecutionGuard(guard: ExecutionGuard): void;
}
