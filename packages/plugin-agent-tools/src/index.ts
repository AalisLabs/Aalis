import type { Context } from '@aalis/core';
import { ToolRegistry } from './tools.js';

export const name = '@aalis/plugin-agent-tools';
export const displayName = '工具注册表';
export const provides = ['tools'];

export function apply(ctx: Context): void {
  const tools = new ToolRegistry(ctx.logger);

  // 加载工具覆盖配置
  const toolOverrides = ctx.config.get('toolOverrides');
  if (toolOverrides) tools.loadOverrides(toolOverrides as Record<string, { authority?: number; safety?: string }>);

  ctx.provide('tools', tools);
}

