import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { tryDispatchSubcommand } from '../../packages/runtime/src/subcommand.js';

/**
 * CLI 子命令分发集成测试（防回归）。
 *
 * 这是 M5 doctor-as-command 后的承诺回测：保证 commands 服务存在时，
 * tryDispatchSubcommand 命中 → 调用 execute → 打印结果 → 返回 0。
 *
 * 不依赖具体命令（如 doctor），只用一个内联 mock 的 CommandService 来验证
 * 分发协议本身，避免把测试和具体插件耦合（doctor 命令名将来可能改）。
 */
describe('tryDispatchSubcommand', () => {
  it('未注册 commands 服务时返回 null', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    try {
      const result = await tryDispatchSubcommand(app, ['doctor']);
      expect(result).toBeNull();
    } finally {
      await app.stop();
    }
  });

  it('命令名未注册时返回 null', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    try {
      app.ctx.provide(
        'commands',
        {
          has: (_: string) => false,
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          execute: async (..._args: any[]) => undefined,
        },
        { capabilities: ['test'] },
      );
      const result = await tryDispatchSubcommand(app, ['nonexistent', 'arg1']);
      expect(result).toBeNull();
    } finally {
      await app.stop();
    }
  });

  it('命中已注册命令：调用 execute、打印结果、返回 0', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const captured: string[] = [];
    let executedWith: { name: string; args: string[]; raw: string } | undefined;
    try {
      app.ctx.provide(
        'commands',
        {
          has: (name: string) => name === 'demo',
          execute: async (name: string, ctx: { args: string[]; raw: string }) => {
            executedWith = { name, args: ctx.args, raw: ctx.raw };
            return `demo executed with ${ctx.args.length} args`;
          },
        },
        { capabilities: ['test'] },
      );
      const result = await tryDispatchSubcommand(app, ['demo', 'foo', 'bar'], msg => captured.push(msg));
      expect(result).toBe(0);
      expect(executedWith).toEqual({ name: 'demo', args: ['foo', 'bar'], raw: '/demo foo bar' });
      expect(captured).toEqual(['demo executed with 2 args']);
    } finally {
      await app.stop();
    }
  });

  it('execute 返回 undefined 时不打印、仍返回 0', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const captured: string[] = [];
    try {
      app.ctx.provide(
        'commands',
        {
          has: (name: string) => name === 'silent',
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          execute: async (..._args: any[]) => undefined,
        },
        { capabilities: ['test'] },
      );
      const result = await tryDispatchSubcommand(app, ['silent'], msg => captured.push(msg));
      expect(result).toBe(0);
      expect(captured).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});
