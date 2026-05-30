/**
 * plugin-commands-api — useCommandService helper 回归测试
 *
 * 重点验证统一收敛到 whenService 之后的两条关键路径：
 *  1. **hot-forward**：commands 已就绪时链式调用同步落到真 builder 上
 *  2. **bounce-replay**：commands 服务被 unregister → 重新 provide 后，
 *     先前注册的命令自动重挂到新 service 上（含所有 alias/option/action）
 */
import { ConfigManager, Context, EventBus, HookRegistry, Logger, ServiceContainer } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import {
  type CommandBuilder,
  type CommandHandler,
  type CommandMeta,
  type CommandService,
  type InternalCommandMeta,
  type OptionRegisterOptions,
  useCommandService,
} from '../../packages/plugin-commands-api/src/index.js';

// ===== mock CommandService =====

interface RegisteredCmd {
  name: string;
  description?: string;
  meta: InternalCommandMeta;
  aliases: string[];
  options: Array<{ name: string; syntax: string; opts?: OptionRegisterOptions }>;
  actions: CommandHandler[];
  usage: string[];
  examples: string[];
}

function makeCommandService(): { svc: CommandService; cmds: Map<string, RegisteredCmd> } {
  const cmds = new Map<string, RegisteredCmd>();
  const svc: CommandService = {
    command(name: string, description?: string, meta?: CommandMeta): CommandBuilder {
      const reg: RegisteredCmd = {
        name,
        description,
        meta: (meta ?? {}) as InternalCommandMeta,
        aliases: [],
        options: [],
        actions: [],
        usage: [],
        examples: [],
      };
      cmds.set(name, reg);
      const builder: CommandBuilder = {
        alias(n) {
          reg.aliases.push(n);
          return builder;
        },
        option(n, syntax, opts) {
          reg.options.push({ name: n, syntax, opts });
          return builder;
        },
        action(handler) {
          reg.actions.push(handler);
          return builder;
        },
        usage(text) {
          reg.usage.push(text);
          return builder;
        },
        example(line) {
          reg.examples.push(line);
          return builder;
        },
      };
      return builder;
    },
    unregister(name: string): void {
      cmds.delete(name);
    },
  } as unknown as CommandService;
  return { svc, cmds };
}

function rootCtx(): Context {
  const events = new EventBus();
  const services = new ServiceContainer();
  const hooks = new HookRegistry();
  const logger = new Logger('test');
  const config = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
  return new Context({ id: 'cmd-test', events, services, hooks, logger, config });
}

describe('useCommandService — hot-forward + bounce-replay', () => {
  it('commands 已就绪：链式调用同步落到真 builder', () => {
    const ctx = rootCtx();
    const { svc, cmds } = makeCommandService();
    ctx.provide('commands', svc);

    useCommandService(ctx)
      .command('ping', 'p')
      .alias('p')
      .option('verbose', '-v')
      .action(async () => undefined)
      .usage('ping [opts]');

    const cmd = cmds.get('ping');
    expect(cmd).toBeDefined();
    expect(cmd?.aliases).toEqual(['p']);
    expect(cmd?.options).toHaveLength(1);
    expect(cmd?.actions).toHaveLength(1);
    expect(cmd?.usage).toEqual(['ping [opts]']);
  });

  it('commands bounce：新 service 上线后命令带全部 alias/option/action 自动重挂', async () => {
    const ctx = rootCtx();
    const a = makeCommandService();
    const handle = ctx.provide('commands', a.svc);

    useCommandService(ctx)
      .command('echo', 'e')
      .alias('say')
      .action(async () => undefined);

    expect(a.cmds.get('echo')?.aliases).toEqual(['say']);

    // bounce：unregister 旧 service，provide 新 service
    handle();
    // 等事件落地
    await new Promise(r => setTimeout(r, 0));

    const b = makeCommandService();
    ctx.provide('commands', b.svc);
    await new Promise(r => setTimeout(r, 0));

    const cmd = b.cmds.get('echo');
    expect(cmd, 'echo 应在新 service 上被自动重挂').toBeDefined();
    expect(cmd?.aliases).toEqual(['say']);
    expect(cmd?.actions).toHaveLength(1);
    // 旧 service 不应再保留
    expect(a.cmds.has('echo')).toBe(false);
  });

  it('commands 未就绪：链式调用全部缓冲，service 上线后一次性重放', async () => {
    const ctx = rootCtx();
    useCommandService(ctx)
      .command('lazy', 'l')
      .alias('lz')
      .option('count', '-c')
      .action(async () => undefined);

    const { svc, cmds } = makeCommandService();
    ctx.provide('commands', svc);
    await new Promise(r => setTimeout(r, 0));

    const cmd = cmds.get('lazy');
    expect(cmd).toBeDefined();
    expect(cmd?.aliases).toEqual(['lz']);
    expect(cmd?.options).toEqual([{ name: 'count', syntax: '-c', opts: undefined }]);
    expect(cmd?.actions).toHaveLength(1);
  });
});
