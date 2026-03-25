// ===== 指令服务接口 =====

import type { CommandDefinition, RegisteredCommand, CommandContext } from './core.js';

/**
 * 指令服务接口
 *
 * 管理用户可调用的斜杠指令的注册、解析、执行。
 * 具体实现由 plugin-commands 提供。
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

  setAuthority(authority: AuthorityService): void;
}

// 引入 AuthorityService 以便 setAuthority 声明
import type { AuthorityService } from './authority.js';
