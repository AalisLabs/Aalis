/**
 * api-commands — `commands` 绑定门面的回归测试
 *
 * 门面把指令声明记在资源口的登记账本（registrar）上，于是有这几条关键路径：
 *  1. **hot-forward**：提供者已在场时，链式调用在 apply 返回前就落到真 builder
 *  2. **buffer-replay**：提供者缺席时链式调用全部缓冲，提供者上线后一次性重放
 *  3. **provider 换人重挂**：提供者被注销 → 换一个新的，先前声明的指令带全部
 *     alias/option/action 自动挂到新提供者上，旧提供者上不留残留
 *  4. **关闭时与原语同一拍撤回**，不等本插件所提供服务的下游交接
 *  5. **同一激活同名再登记是替换**：只留后一次的那一层
 */
import { App, definePlugin, defineService, optional, type PluginDefinition, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { BoundCommands, ExecutionInput } from '../../packages/api-commands/src/index.js';
import {
  type CommandBuilder,
  type CommandHandler,
  type CommandMeta,
  type CommandService,
  commands,
  type InternalCommandMeta,
  type OptionRegisterOptions,
} from '../../packages/api-commands/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';

// ===== 桩 CommandService =====

interface RegisteredCmd {
  name: string;
  description?: string;
  meta: InternalCommandMeta;
  aliases: string[];
  options: Array<{ name: string; syntax: string; opts?: OptionRegisterOptions }>;
  arguments: Array<{ name: string; description: string }>;
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
        arguments: [],
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
        argument(n, description) {
          reg.arguments.push({ name: n, description });
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

// ===== 宿主与探针 =====

const newApp = () => new App({ name: 'T', logLevel: 'error' });

/**
 * 提供者上下线经事件广播到达跟随者，并可能触发插件重算：先等宏任务把微任务队列排空，
 * 再等状态机静置。
 */
async function settle(app: App): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  await app.plugins.idle();
}

/**
 * 最小探针插件：在自己的激活里用 `commands` 门面登记指令。
 *
 * commands 声明为**可选**依赖，为的是提供者上下线时探针保持激活——重挂与注销就只由
 * 门面的跟随回调承重。声明为 required 的话提供者一走 core 就把整个插件降级重激活，
 * 测到的是调度器而不是门面。
 */
function commandProbe(name: string, register: (commands: BoundCommands) => void): PluginDefinition {
  return definePlugin({
    name,
    uses: { commands: optional(commands) },
    apply(caps) {
      register(caps.commands.use);
    },
  });
}

/** 装载探针并确认它真的激活了：停在 pending 的话下面的断言会变成对空账本的比对 */
async function loadProbe(app: App, probe: PluginDefinition): Promise<void> {
  await app.plugin(probe);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(probe.name)?.state;
  if (state !== 'active') throw new Error(`探针 "${probe.name}" 未激活（state=${state}）`);
}

describe('commands 门面 — hot-forward + 换人重挂', () => {
  it('commands 已就绪：链式调用同步落到真 builder', async () => {
    const app = newApp();
    const host = app.bind({ provide });
    const { svc, cmds } = makeCommandService();
    host.provide.use(commands, svc);

    // 在 apply 里就地取快照：热转发的判据是「apply 返回前已经落到真 builder」，
    // 等 await 之后再看的话，缓冲重放同样会满足，断言就分不出这两条路径了。
    let hot: { aliases: string[]; options: number; actions: number; usage: string[] } | undefined;
    await loadProbe(
      app,
      commandProbe('probe-hot', commands => {
        commands
          .command('ping', 'p')
          .alias('p')
          .option('verbose', '-v')
          .action(async () => undefined)
          .usage('ping [opts]');
        const cmd = cmds.get('ping');
        if (cmd) {
          hot = {
            aliases: [...cmd.aliases],
            options: cmd.options.length,
            actions: cmd.actions.length,
            usage: [...cmd.usage],
          };
        }
      }),
    );

    expect(hot, 'apply 返回前链式调用就该落到真 builder').toBeDefined();
    expect(hot?.aliases).toEqual(['p']);
    expect(hot?.options).toBe(1);
    expect(hot?.actions).toBe(1);
    expect(hot?.usage).toEqual(['ping [opts]']);
    await app.stop();
  });

  it('commands 换人：新提供者上线后命令带全部 alias/option/action 自动重挂', async () => {
    const app = newApp();
    const host = app.bind({ provide });
    const a = makeCommandService();
    const handle = host.provide.use(commands, a.svc);

    await loadProbe(
      app,
      commandProbe('probe-rebind', commands => {
        commands
          .command('echo', 'e')
          .alias('say')
          .action(async () => undefined);
      }),
    );
    expect(a.cmds.get('echo')?.aliases).toEqual(['say']);

    // 换人：注销旧提供者，再上一个新的
    handle();
    await settle(app);

    const b = makeCommandService();
    host.provide.use(commands, b.svc);
    await settle(app);

    const cmd = b.cmds.get('echo');
    expect(cmd, 'echo 应在新提供者上被自动重挂').toBeDefined();
    expect(cmd?.aliases).toEqual(['say']);
    expect(cmd?.actions).toHaveLength(1);
    // 旧提供者不应再保留
    expect(a.cmds.has('echo')).toBe(false);
    await app.stop();
  });

  it('commands 未就绪：链式调用全部缓冲，提供者上线后一次性重放', async () => {
    const app = newApp();
    const host = app.bind({ provide });

    let bufferedDuringApply = false;
    await loadProbe(
      app,
      commandProbe('probe-lazy', commands => {
        commands
          .command('lazy', 'l')
          .alias('lz')
          .option('count', '-c')
          .action(async () => undefined);
        bufferedDuringApply = true;
      }),
    );
    expect(bufferedDuringApply, '提供者缺席时链式调用不得抛错').toBe(true);

    const { svc, cmds } = makeCommandService();
    expect(cmds.has('lazy'), '提供者上线之前不该有任何登记').toBe(false);
    host.provide.use(commands, svc);
    await settle(app);

    const cmd = cmds.get('lazy');
    expect(cmd).toBeDefined();
    expect(cmd?.aliases).toEqual(['lz']);
    expect(cmd?.options).toEqual([{ name: 'count', syntax: '-c', opts: undefined }]);
    expect(cmd?.actions).toHaveLength(1);
    await app.stop();
  });

  it('位置参数的说明同样热转发、换人后重放', async () => {
    const app = newApp();
    const host = app.bind({ provide });
    const a = makeCommandService();
    const handle = host.provide.use(commands, a.svc);
    await loadProbe(
      app,
      commandProbe('probe-argument', commands => {
        commands
          .command('find <q:string>', 'f')
          .argument('q', '要找的词')
          .action(async () => undefined);
      }),
    );
    const described = [{ name: 'q', description: '要找的词' }];
    expect(a.cmds.get('find <q:string>')?.arguments).toEqual(described);

    handle();
    await settle(app);
    const b = makeCommandService();
    host.provide.use(commands, b.svc);
    await settle(app);
    expect(b.cmds.get('find <q:string>')?.arguments).toEqual(described);
    await app.stop();
  });

  it('登记指令的激活关闭：指令与原语同一拍撤回，不等它所提供服务的下游交接', async () => {
    const app = newApp();
    const host = app.bind({ provide });
    const { svc, cmds } = makeCommandService();
    host.provide.use(commands, svc);
    const owned = defineService<object>('__t:commands-owned');
    await app.plugin(
      definePlugin({
        name: 'owner',
        provides: [owned],
        uses: { commands: optional(commands), provide },
        apply({ commands, provide }) {
          provide.use(owned, {});
          commands.use.command('ping', 'p').action(async () => undefined);
        },
      }),
    );
    let releaseHandover!: () => void;
    await app.plugin(
      definePlugin({
        name: 'downstream',
        uses: { owned: optional(owned) },
        apply({ owned }) {
          owned.follow(() => () => new Promise<void>(resolve => (releaseHandover = resolve)));
        },
      }),
    );
    await app.plugins.idle();
    expect(cmds.has('ping')).toBe(true);

    const unloading = app.plugins.unload('owner');
    await new Promise(r => setTimeout(r, 5));
    const duringHandover = cmds.has('ping');
    releaseHandover();
    await unloading;
    expect(duringHandover, '下游交接还没落定时指令已撤下').toBe(false);
    await app.stop();
  });
});

// ─────────────────────────────────────────────────────────────
// 「只摘自己那一层」这条语义在上面那个 Map<name, 一条> 的桩上是测不出来的 —— 它忽略
// unregister 的第二个实参。实测把 makeBuilder 的 `svc.unregister(name, meta.pluginName)`
// 改回单参，整仓用例无一变红、tsc 也不红（少传参数是类型兼容的）。而真改回去，
// CommandRegistry 会 `stack.splice(0)` 把同名指令的全部声明连根删除。故这里换用真注册表。
describe('commands 门面 — 卸载只摘自己那一层（走真 CommandRegistry）', () => {
  const mkLogger = () => {
    const l = { warn() {}, debug() {}, info() {}, error() {}, child: () => mkLogger() };
    return l;
  };

  it('两个插件注册同名指令，其中一个卸载后另一个仍在', async () => {
    const app = newApp();
    const host = app.bind({ provide });
    const registry = new CommandRegistry(mkLogger() as never, () => undefined);
    host.provide.use(commands, registry);

    await loadProbe(
      app,
      commandProbe('probe-a', commands => {
        commands.command('ping', 'A 的 ping').action(async () => 'a');
      }),
    );
    await loadProbe(
      app,
      commandProbe('probe-b', commands => {
        commands.command('ping', 'B 的 ping').action(async () => 'b');
      }),
    );

    expect(await registry.execute('ping', execInput()), '栈顶是后注册的 B').toBe('b');

    await app.plugins.unload('probe-b');
    await settle(app);
    expect(
      registry.getAll().find(c => c.name === 'ping'),
      'B 卸载后 A 的声明必须还在（连根删除会让整个节点消失）',
    ).toBeDefined();
    expect(await registry.execute('ping', execInput()), '复位到 A 的实现').toBe('a');
    await app.stop();
  });

  it('换人后重放抛错：新提供者上不留半截那一层，被它压住的同名指令照常生效', async () => {
    const app = newApp();
    const host = app.bind({ provide });
    const off = host.provide.use(commands, makeCommandService().svc);
    await loadProbe(
      app,
      commandProbe('probe-replay', commands => {
        commands
          .command('ping', '探针的 ping')
          .alias('pp')
          .action(async () => 'probe');
      }),
    );
    off();
    await settle(app);
    const registry = new CommandRegistry(mkLogger() as never, () => undefined);
    registry.command('ping', '原有的 ping', { pluginName: 'base' }).action(async () => 'base');
    const flaky = {
      command: (name: string, description?: string, meta?: InternalCommandMeta) =>
        Object.assign(Object.create(registry.command(name, description, meta)) as CommandBuilder, {
          alias: () => {
            throw new Error('别名冲突');
          },
        }),
      unregister: (name: string, contextId?: string) => registry.unregister(name, contextId),
    } as unknown as CommandService;
    host.provide.use(commands, flaky);
    await settle(app);
    expect(registry.get('ping')?.description).toBe('原有的 ping');
    await app.stop();
  });

  it('同一激活再登记同名指令：替换先前那次，只留一层', async () => {
    const app = newApp();
    const host = app.bind({ provide });
    const registry = new CommandRegistry(mkLogger() as never, () => undefined);
    host.provide.use(commands, registry);

    await loadProbe(
      app,
      commandProbe('probe-dup', commands => {
        commands.command('ping', '第一次', { risk: 'dangerous' }).action(async () => 'first');
        commands.command('ping', '第二次').action(async () => 'second');
      }),
    );

    const ping = registry.get('ping');
    expect(ping?.description).toBe('第二次');
    expect(ping?.risk, '先前那层已撤下，不再参与取最严').toBeUndefined();
    await app.stop();
  });
});

function execInput(): ExecutionInput {
  // 显式标注返回类型：此前是推断，于是漏了必填的 `raw` 也没人发现——
  // execute() 内部按 raw 解析原始输入，缺它等于测试跑在与生产不同的输入形状上。
  return {
    args: [] as string[],
    raw: '/ping',
    sessionId: 's',
    platform: 'test',
    userId: 'u',
    sessionType: 'private' as const,
  };
}
