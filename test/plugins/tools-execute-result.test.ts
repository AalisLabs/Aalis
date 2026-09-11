import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { ToolService } from '../../packages/api-tools/src/index.js';
import { useToolService } from '../../packages/api-tools/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';

// ToolService.execute 的结果形态：handler 返回字符串或 {content, images}，execute 一律归一为
// ToolExecutionResult；错误路径（未找到 / 参数校验 / 抛错）同样是 {content: JSON 错误}，
// 调用方（agent / mcp-server / workflow）不必再区分。

async function withTools(fn: (svc: ToolService) => Promise<void>): Promise<void> {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(toolsModule as never, {});
  await app.plugins.idle();
  const reg = useToolService(app.ctx);
  const def = (name: string) => ({
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
  });
  reg.register({ definition: def('t_str'), handler: async () => 'plain' });
  reg.register({
    definition: def('t_img'),
    handler: async () => ({ content: 'c', images: ['data:image/png;base64,AA=='] }),
  });
  reg.register({ definition: def('t_empty_img'), handler: async () => ({ content: 'c', images: [] }) });
  reg.register({
    definition: def('t_throw'),
    handler: async () => {
      throw new Error('boom');
    },
  });
  const svc = app.ctx.getService<ToolService>('tools');
  if (!svc) throw new Error('tools 服务未注册');
  try {
    await fn(svc);
  } finally {
    await app.stop();
  }
}

const ctx = { sessionId: 's', platform: 'test', userId: 'u' };

describe('ToolService.execute 结果归一', () => {
  it('字符串 handler → {content}，不带 images 键', async () => {
    await withTools(async svc => {
      const r = await svc.execute('t_str', {}, ctx);
      expect(r).toEqual({ content: 'plain' });
      expect('images' in r).toBe(false);
    });
  });

  it('携图 handler → images 原样透出；空数组视同无图', async () => {
    await withTools(async svc => {
      expect(await svc.execute('t_img', {}, ctx)).toEqual({ content: 'c', images: ['data:image/png;base64,AA=='] });
      const empty = await svc.execute('t_empty_img', {}, ctx);
      expect(empty).toEqual({ content: 'c' });
      expect('images' in empty).toBe(false);
    });
  });

  it('错误路径统一为 {content: JSON 错误}：未找到 / handler 抛错', async () => {
    await withTools(async svc => {
      const missing = await svc.execute('nope', {}, ctx);
      expect(JSON.parse(missing.content).error).toContain('未找到');
      const thrown = await svc.execute('t_throw', {}, ctx);
      expect(JSON.parse(thrown.content).error).toBe('boom');
    });
  });
});
