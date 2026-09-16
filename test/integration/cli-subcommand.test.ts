import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { tryDispatchSubcommand } from '../../packages/runtime/src/subcommand.js';

/**
 * CLI 子命令分发集成测试（防回归）。
 *
 * 保证 commands 服务存在时 tryDispatchSubcommand 命中 → 调用 execute → 打印结果 → 返回 0；
 * 未命中 / 服务缺失 → 报错并返回 2——**不存在放行分支**：argv 非空即子命令模式，未命中若返回
 * 「继续」，调用方就会照常起守护进程，打错的命令名变成与运行中实例并存的第二个实例。
 *
 * 不依赖具体命令（如 doctor），只用一个内联 mock 的 CommandService 来验证
 * 分发协议本身，避免把测试和具体插件耦合（doctor 命令名将来可能改）。
 */
describe('tryDispatchSubcommand', () => {
  it('未注册 commands 服务时报错并返回 2', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const errors: string[] = [];
    try {
      const result = await tryDispatchSubcommand(
        app,
        ['doctor'],
        () => {},
        msg => errors.push(msg),
      );
      expect(result).toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('doctor');
      expect(errors[0]).toContain('commands 服务不可用');
    } finally {
      await app.stop();
    }
  });

  it('命令名未注册时报错（含命令名）并返回 2，不调用 execute', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const errors: string[] = [];
    let executed = false;
    try {
      app.ctx.provide('commands', {
        has: (_: string) => false,
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        execute: async (..._args: any[]) => {
          executed = true;
          return undefined;
        },
      } as never);
      const result = await tryDispatchSubcommand(
        app,
        ['nonexistent', 'arg1'],
        () => {},
        msg => errors.push(msg),
      );
      expect(result).toBe(2);
      expect(executed).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('未知子命令「nonexistent」');
    } finally {
      await app.stop();
    }
  });

  it('命中已注册命令：调用 execute、打印结果、返回 0', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const captured: string[] = [];
    const errors: string[] = [];
    let executedWith: { name: string; args: string[]; raw: string } | undefined;
    try {
      app.ctx.provide('commands', {
        has: (name: string) => name === 'demo',
        execute: async (name: string, ctx: { args: string[]; raw: string }) => {
          executedWith = { name, args: ctx.args, raw: ctx.raw };
          return `demo executed with ${ctx.args.length} args`;
        },
      } as never);
      const result = await tryDispatchSubcommand(
        app,
        ['demo', 'foo', 'bar'],
        msg => captured.push(msg),
        msg => errors.push(msg),
      );
      expect(result).toBe(0);
      expect(executedWith).toEqual({ name: 'demo', args: ['foo', 'bar'], raw: '/demo foo bar' });
      expect(captured).toEqual(['demo executed with 2 args']);
      expect(errors).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('execute 返回 undefined 时不打印、仍返回 0', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const captured: string[] = [];
    try {
      app.ctx.provide('commands', {
        has: (name: string) => name === 'silent',
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        execute: async (..._args: any[]) => undefined,
      } as never);
      const result = await tryDispatchSubcommand(app, ['silent'], msg => captured.push(msg));
      expect(result).toBe(0);
      expect(captured).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});
