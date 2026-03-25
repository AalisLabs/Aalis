import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-webui-client';

export const inject = {
  required: [{ service: 'webui-server', capabilities: ['api-v1'] }],
};

export const provides = ['webui-client'];

// ===== 插件入口 =====

export function apply(ctx: Context): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = resolve(__dirname, '../client/dist');

  ctx.provide('webui-client', {
    getClientDir: () => clientDist,
  });

  ctx.logger.info(`默认前端已注册: ${clientDist}`);
}
