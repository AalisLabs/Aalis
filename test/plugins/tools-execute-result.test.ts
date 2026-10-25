import { App, type Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { type ToolService, tools as toolsService } from '../../packages/api-tools/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ToolService.execute 的结果形态：handler 返回字符串或 {content, images}，execute 一律归一为
// ToolExecutionResult；错误路径（未找到 / 参数校验 / 抛错）同样是 {content: JSON 错误}，
// 调用方（agent / mcp-server / workflow）不必再区分。

async function withTools(fn: (svc: ToolService) => Promise<void>): Promise<void> {
  const app = new App({ name: 'T', logLevel: 'error' });
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.idle();
  const { tools } = app.bind({ tools: toolsService });
  const def = (name: string) => ({
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
  });
  tools.use.register({ definition: def('t_str'), handler: async () => 'plain' });
  tools.use.register({
    definition: def('t_img'),
    handler: async () => ({ content: 'c', images: ['data:image/png;base64,AA=='] }),
  });
  tools.use.register({ definition: def('t_empty_img'), handler: async () => ({ content: 'c', images: [] }) });
  tools.use.register({
    definition: def('t_throw'),
    handler: async () => {
      throw new Error('boom');
    },
  });
  if (!tools.present) throw new Error('tools 服务未注册');
  const svc = tools.use;
  try {
    await fn(svc);
  } finally {
    await app.stop();
  }
}

const callCtx = toolRequest({ sessionId: 's', platform: 'test', userId: 'u' });

describe('ToolService.execute 结果归一', () => {
  it('字符串 handler → {content}，不带 images 键', async () => {
    await withTools(async svc => {
      const r = await svc.execute('t_str', {}, callCtx);
      expect(r).toEqual({ content: 'plain' });
      expect('images' in r).toBe(false);
    });
  });

  it('携图 handler → images 原样透出；空数组视同无图', async () => {
    await withTools(async svc => {
      expect(await svc.execute('t_img', {}, callCtx)).toEqual({
        content: 'c',
        images: ['data:image/png;base64,AA=='],
      });
      const empty = await svc.execute('t_empty_img', {}, callCtx);
      expect(empty).toEqual({ content: 'c' });
      expect('images' in empty).toBe(false);
    });
  });

  it('错误路径统一为 {content: JSON 错误}：未找到 / handler 抛错', async () => {
    await withTools(async svc => {
      const missing = await svc.execute('nope', {}, callCtx);
      expect(JSON.parse(missing.content).error).toContain('未找到');
      const thrown = await svc.execute('t_throw', {}, callCtx);
      expect(JSON.parse(thrown.content).error).toBe('boom');
    });
  });
});

describe('执行层的结局日志按 toolFailed 记', () => {
  it('工具返回带 error 的 JSON 或命令退出码不为 0：记一条执行失败，不记执行成功；抛错同一句；中止的记执行中止；成功才记执行成功', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: (...args: unknown[]) => void lines.push(`debug ${args.map(String).join(' ')}`),
      info() {},
      warn: (...args: unknown[]) => void lines.push(`warn ${args.map(String).join(' ')}`),
      error: (...args: unknown[]) => void lines.push(`error ${args.map(String).join(' ')}`),
      child: () => logger,
    };
    const app = new App({ name: 'T', logger });
    try {
      await app.plugins.register(toolsPlugin, {});
      await app.plugins.idle();
      const { tools } = app.bind({ tools: toolsService });
      const def = (name: string) => ({
        type: 'function' as const,
        function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
      });
      tools.use.register({ definition: def('t_err'), handler: async () => '{"error":"x"}' });
      tools.use.register({
        definition: def('t_throw'),
        handler: async () => {
          throw new Error('boom');
        },
      });
      tools.use.register({
        definition: def('t_cmd'),
        display: { kind: 'command', fields: { command: 'command' }, result: { exitCode: 'exitCode' } },
        handler: async () => '{"exitCode":1,"stdout":""}',
      });
      // 停掉的命令：调用的信号中止之后进程被杀，退出码不为 0
      const stop = new AbortController();
      tools.use.register({
        definition: def('t_stopped'),
        display: { kind: 'command', fields: { command: 'command' }, result: { exitCode: 'exitCode' } },
        handler: async () => {
          stop.abort();
          return '{"exitCode":-1,"stdout":""}';
        },
      });
      tools.use.register({ definition: def('t_ok'), handler: async () => '{"ok":true}' });
      for (const name of ['t_err', 't_throw', 't_cmd']) await tools.use.execute(name, {}, callCtx);
      await tools.use.execute('t_stopped', {}, { ...callCtx, signal: stop.signal });
      await tools.use.execute('t_ok', {}, callCtx);
      const outcomes = lines.filter(line => /工具 t_\w+ 执行/.test(line));
      expect(outcomes).toEqual([
        'error 工具 t_err 执行失败: x',
        'error 工具 t_throw 执行失败: boom',
        'error 工具 t_cmd 执行失败: 退出码 1',
        'debug 工具 t_stopped 执行中止',
        'debug 工具 t_ok 执行成功',
      ]);
    } finally {
      await app.stop();
    }
  });
});
