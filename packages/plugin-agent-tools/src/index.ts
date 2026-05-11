import type { Context } from '@aalis/core';
import { ToolRegistry } from './tools.js';
import '@aalis/plugin-tools-api';

export const name = '@aalis/plugin-agent-tools';
export const displayName = '工具注册表';
export const provides = ['tools'];

export function apply(ctx: Context): void {
  const tools = new ToolRegistry(ctx.logger);
  ctx.provide('tools', tools);
}

