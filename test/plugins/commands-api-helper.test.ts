/**
 * api-commands — useCommandService helper 回归测试
 *
 * 重点验证统一收敛到 whenService 之后的两条关键路径：
 *  1. **hot-forward**：commands 已就绪时链式调用同步落到真 builder 上
 *  2. **bounce-replay**：commands 服务被 unregister → 重新 provide 后，
 *     先前注册的命令自动重挂到新 service 上（含所有 alias/option/action）
 */
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '@aalis/core';
import { describe, expect, it } from 'vitest';
import {
  type CommandBuilder,
  type CommandHandler,
  type CommandMeta,
  type CommandService,
  type InternalCommandMeta,
  type OptionRegisterOptions,
  useCommandService,
} from '../../packages/api-commands/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';

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
  const contributions = new ContributionRegistry();
  const logger = new DefaultLogger('test');
  const config = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
  return new Context({ id: 'cmd-test', events, services, hooks, contributions, logger, config });
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

// ─────────────────────────────────────────────────────────────
// 这条通路此前只被上面那个 Map<name, 一条> 的替身覆盖 —— 它忽略 unregister 的第二个实参，
// 于是「只摘自己那一层」这个语义在 api-commands 侧零覆盖：实测把 makeBuilder 的
// `svc.unregister(name, meta.pluginName)` 改回单参，1174 个用例无一变红、tsc 也不红
// （少传参数是类型兼容的）。而真改回去，CommandRegistry 会 `stack.splice(0)` 把同名指令的
// 全部声明连根删除 —— 正是 38fbd22e 修掉的那个病。故这里换用真注册表把语义钉死。
describe('useCommandService — 卸载只摘自己那一层（走真 CommandRegistry）', () => {
  const mkLogger = () => {
    const l = { warn() {}, debug() {}, info() {}, error() {}, child: () => mkLogger() };
    return l;
  };

  it('两个插件注册同名指令，其中一个 dispose 后另一个仍在', async () => {
    const root = rootCtx();
    const registry = new CommandRegistry(mkLogger() as never);
    root.provide('commands', registry);

    const a = root.fork('plugin-a');
    const b = root.fork('plugin-b');
    useCommandService(a)
      .command('ping', 'A 的 ping')
      .action(async () => 'a');
    useCommandService(b)
      .command('ping', 'B 的 ping')
      .action(async () => 'b');

    expect(await registry.execute('ping', execInput()), '栈顶是后注册的 B').toBe('b');

    await b.disposeAsync();
    expect(
      registry.getAll().find(c => c.name === 'ping'),
      'B 卸载后 A 的声明必须还在（连根删除会让整个节点消失）',
    ).toBeDefined();
    expect(await registry.execute('ping', execInput()), '复位到 A 的实现').toBe('a');
  });
});

function execInput() {
  return { args: [] as string[], sessionId: 's', platform: 'test', userId: 'u', sessionType: 'private' as const };
}
