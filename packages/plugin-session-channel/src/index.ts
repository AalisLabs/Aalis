import type { ConfigSchema, Context } from '@aalis/core';

import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage, Message } from '@aalis/plugin-message-api';
import { SessionChannelManager } from './manager.js';

export { SessionChannelManager } from './manager.js';
export * from './types.js';

export const name = '@aalis/plugin-session-channel';
export const displayName = '会话频道聚合';
export const subsystem = 'session';
export const inject = {
  required: ['memory'] as const,
};
export const provides = ['session-channel'];

export const configSchema: ConfigSchema = {
  // 目前没有运行时配置；channel 的创建/绑定都通过 service API 进行。
  // 后续如果加上"自动创建默认 channel"等场景再补 schema。
};

export const defaultConfig = {};

export async function apply(ctx: Context, _config: Record<string, unknown>): Promise<void> {
  const memory = ctx.getService<MemoryService>('memory');
  if (!memory) {
    ctx.logger.error('memory 服务不可用，session-channel 无法启动');
    return;
  }

  const manager = new SessionChannelManager(ctx, memory);
  await manager.load();

  ctx.provide('session-channel', manager, {
    label: '会话频道聚合',
  });

  // 入站汇聚：仅订阅 archived 锚点，避免归档失败的消息被当成已入历史
  ctx.on(
    'inbound:message:archived',
    (data: { sessionId: string; incoming: IncomingMessage; archivedMessage: Message }) => {
      manager.handleArchived(data);
    },
  );

  ctx.logger.info('session-channel 已启动');
}
