import { afterEach, describe, expect, it } from 'vitest';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, type Logger, provide } from '../../packages/core/src/index.js';
import { toolRequest } from '../fixtures/tool-call.js';
import { makeToolRegistry } from '../fixtures/tool-registry.js';

// ════════════════════════════════════════════════════════════
// 工具表与工具分组表跨插件按登记方的位次排，与钩子链、事件监听同一条规则：宿主的根最前，插件按实例 id 的码元序，
// 同一登记方的几条按登记先后；不看登记发生的时刻。同名的几条都留着：位次靠前的那条生效，它撤回后下一条顶上。
// ════════════════════════════════════════════════════════════

function quiet() {
  const warnings: string[] = [];
  const debugs: string[] = [];
  const logger: Logger = {
    debug: (...args) => void debugs.push(args.map(String).join(' ')),
    info() {},
    warn: (...args) => void warnings.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  return { logger, warnings, debugs };
}

const tool = (name: string, reply = name): Omit<RegisteredTool, 'pluginName'> => ({
  definition: {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
  },
  handler: async () => reply,
});
const call = toolRequest({ sessionId: 's', platform: 'test' });

describe('工具表：按登记方的位次排', () => {
  it('清单先比位次、同一登记方按登记先后，不看登记发生的时刻', () => {
    const registry = makeToolRegistry(quiet().logger);
    registry.register(tool('b1'), 'b', 'b');
    registry.register(tool('a1'), 'a', 'a');
    registry.register(tool('root1'), 'root', '');
    registry.register(tool('a2'), 'a', 'a');
    const names = () => registry.getDefinitions().map(d => d.function.name);
    expect(names()).toEqual(['root1', 'a1', 'a2', 'b1']);
    expect(registry.getAll().map(t => t.name)).toEqual(['root1', 'a1', 'a2', 'b1']);
  });

  it('撤回再登记（插件重启）之后落回自己的位次', () => {
    const registry = makeToolRegistry(quiet().logger);
    const off = registry.register(tool('a1'), 'a', 'a');
    registry.register(tool('b1'), 'b', 'b');
    off();
    registry.register(tool('a1'), 'a', 'a');
    expect(registry.getDefinitions().map(d => d.function.name)).toEqual(['a1', 'b1']);
  });

  it('同名的两条：位次靠前的生效并告警点名双方，它撤回后被压住的那条顶上', async () => {
    const { logger, warnings } = quiet();
    const registry = makeToolRegistry(logger);
    registry.register(tool('same', '来自 b'), 'b', 'b');
    const offA = registry.register(tool('same', '来自 a'), 'a', 'a');
    registry.register(tool('other'), 'b', 'b');
    expect(registry.getAll().map(t => `${t.name}@${t.pluginName}`)).toEqual(['same@a', 'other@b']);
    expect((await registry.execute('same', {}, call)).content).toBe('来自 a');
    expect(warnings.filter(line => line.includes('same'))).toEqual([
      '工具 "same" 重名：a 的那条生效，b 的那条被压住，生效的撤回后顶上',
    ]);
    offA();
    expect(registry.getAll().map(t => `${t.name}@${t.pluginName}`)).toEqual(['same@b', 'other@b']);
    expect((await registry.execute('same', {}, call)).content).toBe('来自 b');
  });

  it('旧的那条还没撤、同一位次又登记同名的（直接调登记表）：新的一条生效、排在旧的那条的位置上，旧的撤回后不动它', async () => {
    const registry = makeToolRegistry(quiet().logger);
    const offOld = registry.register(tool('same', '旧的'), 'a', 'a');
    registry.register(tool('other'), 'a', 'a');
    registry.register(tool('same', '新的'), 'a', 'a');
    expect(registry.getDefinitions().map(d => d.function.name)).toEqual(['same', 'other']);
    expect((await registry.execute('same', {}, call)).content).toBe('新的');
    offOld();
    expect((await registry.execute('same', {}, call)).content).toBe('新的');
  });

  it('被压住的那条撤回，生效的不受影响', async () => {
    const registry = makeToolRegistry(quiet().logger);
    registry.register(tool('same', '来自 a'), 'a', 'a');
    const offB = registry.register(tool('same', '来自 b'), 'b', 'b');
    offB();
    expect((await registry.execute('same', {}, call)).content).toBe('来自 a');
    expect(registry.getAll().map(t => t.pluginName)).toEqual(['a']);
  });

  it('撤回调两次：注销只记一次（工具与分组）', () => {
    const { logger, debugs } = quiet();
    const registry = makeToolRegistry(logger);
    const off = registry.register(tool('t'), 'a', 'a');
    const offGroup = registry.registerGroup({ name: 'g', label: 'G' }, 'a', 'a');
    off();
    off();
    offGroup();
    offGroup();
    expect(debugs.filter(line => line.startsWith('注销工具: t'))).toHaveLength(1);
    expect(debugs.filter(line => line.startsWith('注销工具分组: g'))).toHaveLength(1);
  });

  it('未命中的工具名：建议里给的是工具表里的名字', async () => {
    const registry = makeToolRegistry(quiet().logger);
    registry.register(tool('read_file'), 'a', 'a');
    registry.register(tool('send_attachment'), 'b', 'b');
    expect(JSON.parse((await registry.execute('read_fil', {}, call)).content as string)).toEqual({
      error: '工具 "read_fil" 未找到，你是否想用：read_file',
    });
  });
});

describe('工具分组表：同一条规则', () => {
  it('按位次排；同名的两条位次靠前的生效，撤回后另一条顶上', () => {
    const registry = makeToolRegistry(quiet().logger);
    registry.registerGroup({ name: 'g-b', label: 'B' }, 'b', 'b');
    registry.registerGroup({ name: 'shared', label: '来自 b' }, 'b', 'b');
    const offA = registry.registerGroup({ name: 'shared', label: '来自 a' }, 'a', 'a');
    registry.registerGroup({ name: 'g-root', label: 'R' }, 'root', '');
    const shown = () => registry.getGroups().map(g => `${g.name}:${g.label}`);
    expect(shown()).toEqual(['g-root:R', 'shared:来自 a', 'g-b:B']);
    offA();
    expect(shown()).toEqual(['g-root:R', 'g-b:B', 'shared:来自 b']);
  });
});

describe('经绑定接口登记：插件重启不换位置', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop().catch(() => {});
  });

  it('先登记的插件重启之后，它的工具仍排在前面', async () => {
    const { logger } = quiet();
    const app = new App({ logLevel: 'error', logger });
    apps.push(app);
    const registry = makeToolRegistry(logger);
    await app.plugin(
      definePlugin({
        name: 'provider',
        uses: { provide },
        provides: [tools],
        apply: ({ provide }) => void provide.use(tools, registry),
      }),
    );
    const member = (name: string) =>
      definePlugin({
        name,
        uses: { tools },
        apply({ tools }) {
          tools.use.registerGroup({ name: `${name}-group`, label: name });
          tools.use.register(tool(`${name}-tool`));
        },
      });
    await app.plugin(member('a'));
    await app.plugin(member('b'));
    await app.plugins.idle();
    const names = () => registry.getDefinitions().map(d => d.function.name);
    const groups = () => registry.getGroups().map(g => g.name);
    expect(names()).toEqual(['a-tool', 'b-tool']);
    expect(groups()).toEqual(['a-group', 'b-group']);
    await app.plugins.bounce('a');
    await app.plugins.idle();
    expect(names()).toEqual(['a-tool', 'b-tool']);
    expect(groups()).toEqual(['a-group', 'b-group']);
  });

  it('运行中再登记同名的：旧的那条先撤回，新的一条排到这个插件那一段的末尾；重启后按登记先后', async () => {
    const { logger } = quiet();
    const app = new App({ logLevel: 'error', logger });
    apps.push(app);
    const registry = makeToolRegistry(logger);
    app.bind({ provide }).provide.use(tools, registry);
    let again: (() => void) | undefined;
    await app.plugin(
      definePlugin({
        name: 'a',
        uses: { tools },
        apply({ tools }) {
          for (const name of ['t1', 't2', 't3']) tools.use.register(tool(name));
          again = () => void tools.use.register(tool('t1', '新的'));
        },
      }),
    );
    await app.plugin(
      definePlugin({ name: 'b', uses: { tools }, apply: ({ tools }) => void tools.use.register(tool('b1')) }),
    );
    const names = () => registry.getDefinitions().map(d => d.function.name);
    expect(names()).toEqual(['t1', 't2', 't3', 'b1']);
    again?.();
    expect(names()).toEqual(['t2', 't3', 't1', 'b1']);
    expect((await registry.execute('t1', {}, call)).content).toBe('新的');
    await app.plugins.bounce('a');
    await app.plugins.idle();
    expect(names()).toEqual(['t1', 't2', 't3', 'b1']);
  });

  it('宿主的根经绑定接口登记：排在实例 id 码元序靠前的插件之前，同名时根的那条生效', async () => {
    const { logger } = quiet();
    const app = new App({ logLevel: 'error', logger });
    apps.push(app);
    const registry = makeToolRegistry(logger);
    app.bind({ provide }).provide.use(tools, registry);
    await app.plugin(
      definePlugin({
        name: 'a',
        uses: { tools },
        apply({ tools }) {
          tools.use.registerGroup({ name: 'shared', label: '来自 a' });
          tools.use.register(tool('same', '来自 a'));
        },
      }),
    );
    const host = app.bind({ tools });
    host.tools.use.registerGroup({ name: 'shared', label: '来自根' });
    host.tools.use.register(tool('same', '来自根'));
    expect((await registry.execute('same', {}, call)).content).toBe('来自根');
    expect(registry.getGroups().map(group => group.label)).toEqual(['来自根']);
  });
});
