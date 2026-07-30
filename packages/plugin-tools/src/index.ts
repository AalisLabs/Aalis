import type { Context } from '@aalis/core';
import { ToolRegistry } from './tools.js';
import '@aalis/plugin-tools-api'; // 本包唯一的 declaration merging 激活点（tool:* 钩子与工具类型）——删掉会丢键类型，不可删

export const name = '@aalis/plugin-tools';
export const displayName = '工具注册表';
export const subsystem = 'agent';
export const provides = ['tools'];

export function apply(ctx: Context): void {
  const tools = new ToolRegistry(ctx.logger);
  ctx.provide('tools', tools);
}
