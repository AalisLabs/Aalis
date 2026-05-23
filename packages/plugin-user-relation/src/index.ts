/**
 * plugin-user-relation —— 人物关系与事件图（M1：数据层）
 *
 * 本插件目前只提供：
 * - 关系图数据模型（types.ts）
 * - 基于 MemoryService.saveMetadata 的存储层（store.ts）
 * - 应用层 API（service.ts，注册为 `user-relation` service）
 *
 * 后续里程碑：
 * - M2: 定时 LLM 提取器（plugin-scheduler + plugin-llm 调度）
 * - M3: agent middleware 注入相关上下文
 * - M4/M5: WebUI page-actions + react-flow 可视化
 */
import type { ConfigSchema, Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import { RelationService } from './service.js';
import { RelationStore } from './store.js';

export const name = '@aalis/plugin-user-relation';
export const displayName = '人物关系图';
export const subsystem = 'memory';
export const provides = ['user-relation'];
export const inject = {
  required: ['memory'],
};

export const configSchema: ConfigSchema = {
  enabled: {
    type: 'boolean',
    label: '启用人物关系图',
    description: '关闭后插件不注册 user-relation 服务，已有数据保留在 metadata 中不受影响',
    default: true,
  },
};

export function apply(ctx: Context, config: Record<string, unknown>): void {
  if (config.enabled === false) return;

  const memory = ctx.getService<MemoryService>('memory');
  if (!memory) {
    // inject.required 已声明 memory，理论上不会到这里；保险起见显式 throw 便于排查
    throw new Error('[plugin-user-relation] memory 服务不可用，无法初始化关系图存储');
  }

  const store = new RelationStore(memory);
  const service = new RelationService(store);
  ctx.provide('user-relation', service);
}

export { RelationService } from './service.js';
export { RelationStore } from './store.js';
export * from './types.js';
