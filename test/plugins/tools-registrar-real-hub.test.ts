import { afterEach, describe, expect, it } from 'vitest';
import { type ProcessService, processService } from '../../packages/api-process/src/index.js';
import { type BoundTools, tools } from '../../packages/api-tools/src/index.js';
import { type App, createApp, definePlugin, type Logger, optional, provide } from '../../packages/core/src/index.js';
import type { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { makeToolRegistry } from '../fixtures/tool-registry.js';

// ════════════════════════════════════════════════════════════
// core 的登记账本（registrar）接真实的 tools 枢纽：重入替换不留孤儿、换人后旧表与新表都撤干净、
// 登记型与调用型同一声明。core 自己的语义由 test/core 的合成枢纽守，这里守的是 api-tools 的绑定与
// plugin-tools 的注册表接在一起后同样成立。
// ════════════════════════════════════════════════════════════

const tick = () => new Promise<void>(r => setImmediate(r));
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world() {
  const app = createApp({ name: 'tools-real-hub', logger: silent });
  apps.push(app);
  return { app, provide: app.bind({ provide }).provide.use };
}

function toolDef(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
  };
}

async function execTool(reg: ToolRegistry, name: string) {
  return (await reg.execute(name, {}, { sessionId: 's', platform: 'test' })).content;
}

describe('registrar 接真实 tools 枢纽', () => {
  it('真实枢纽 tools：卸载消费者后 execute 必须报未注册', async () => {
    const { app, provide } = world();
    const reg = makeToolRegistry(silent);
    const box: { bound?: BoundTools } = {};
    const orig = reg.register.bind(reg);
    reg.register = (tool, activation) => {
      const off = orig(tool, activation);
      if (tool.definition.function.name === 'alpha' && box.bound) {
        box.bound.register({ definition: toolDef('zulu'), handler: async () => 'from-reenter' });
      }
      return off;
    };
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { tools: optional(tools) },
        apply({ tools }) {
          box.bound = tools.use;
          tools.use.register({ definition: toolDef('alpha'), handler: async () => 'alpha' });
          tools.use.register({ definition: toolDef('keep'), handler: async () => 'keep' });
          tools.use.register({ definition: toolDef('zulu'), handler: async () => 'from-ledger' });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    provide(tools, reg);
    await tick();
    expect(
      reg
        .getAll()
        .map(t => t.name)
        .sort(),
    ).toEqual(['alpha', 'keep', 'zulu']);

    await app.plugins.unload('consumer');
    const names = reg
      .getAll()
      .map(t => t.name)
      .sort();
    const zulu = await execTool(reg, 'zulu');
    const keep = await execTool(reg, 'keep');
    const alpha = await execTool(reg, 'alpha');
    expect({ names, zulu, keep, alpha }, '卸载后枢纽应空，execute 应全部未找到').toEqual({
      names: [],
      zulu: expect.stringContaining('未找到'),
      keep: expect.stringContaining('未找到'),
      alpha: expect.stringContaining('未找到'),
    });
  });

  it('真实枢纽 tools：换人后旧表与新表在消费者卸载后都不可再派活', async () => {
    const { app, provide } = world();
    const a = makeToolRegistry(silent);
    const b = makeToolRegistry(silent);
    const box: { bound?: BoundTools } = {};
    const wrap = (reg: ToolRegistry) => {
      const orig = reg.register.bind(reg);
      reg.register = (tool, activation) => {
        const off = orig(tool, activation);
        if (tool.definition.function.name === 'alpha' && box.bound) {
          box.bound.register({ definition: toolDef('zulu'), handler: async () => 'reenter' });
        }
        return off;
      };
    };
    wrap(a);
    wrap(b);
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { tools: optional(tools) },
        apply({ tools }) {
          box.bound = tools.use;
          tools.use.register({ definition: toolDef('alpha'), handler: async () => 'a' });
          tools.use.register({ definition: toolDef('zulu'), handler: async () => 'ledger' });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    provide(tools, a, { priority: 1, entryId: 'root/a' });
    await tick();
    provide(tools, b, { priority: 2, entryId: 'root/b' });
    await tick();
    await app.plugins.unload('consumer');
    expect(await execTool(a, 'zulu'), '旧表不得留孤儿').toContain('未找到');
    expect(await execTool(b, 'zulu'), '新表不得留孤儿').toContain('未找到');
  });

  it('真实枢纽 tools：同键重入登记出的孤儿在消费者卸载后不可执行', async () => {
    const { app, provide } = world();
    const provider = makeToolRegistry(silent);
    provide(tools, provider);
    let bound!: BoundTools;
    await app.plugin(
      definePlugin({
        name: 'tool-consumer',
        uses: { tools },
        apply({ tools }) {
          bound = tools.use;
        },
      }),
    );
    const definition = {
      type: 'function' as const,
      function: { name: 'same', description: 'same', parameters: { type: 'object' as const, properties: {} } },
    };
    const register = provider.register.bind(provider);
    let once = true;
    provider.register = (tool, owner) => {
      const off = register(tool, owner);
      if (once) {
        once = false;
        bound.register({ definition, handler: async () => 'orphan' });
      }
      return off;
    };
    bound.register({ definition, handler: async () => 'outer' });
    await app.plugins.unload('tool-consumer');
    expect((await provider.execute('same', {}, { sessionId: 'test', platform: 'test' })).content).toContain('未找到');
  });

  it('真实注册型能力 tools 与真实调用型服务 process 走同一声明', async () => {
    const { app, provide } = world();
    const registry = makeToolRegistry(silent);
    provide(tools, registry);
    const fakeProcess = { execFile: async () => ({ stdout: 'v1', stderr: '', code: 0 }) } as unknown as ProcessService;
    provide(processService, fakeProcess);
    let out = '';
    await app.plugin(
      definePlugin({
        name: 'runner',
        uses: { tools, process: processService },
        apply({ tools, process }) {
          tools.use.registerGroup({ name: 'g', label: 'g' });
          tools.use.register({
            definition: {
              type: 'function',
              function: { name: 'run', description: '', parameters: { type: 'object', properties: {} } },
            },
            groups: ['g'],
            handler: async () => {
              out = (await process.use.execFile('echo', [])).stdout;
              return out;
            },
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(registry.getAll().map(t => t.name)).toEqual(['run']);
    await registry.execute('run', {}, { sessionId: 's', platform: 't' });
    expect(out).toBe('v1');
    await app.plugins.unload('runner');
    expect(registry.getAll()).toEqual([]);
    expect(registry.getGroups()).toEqual([]);
  });
});
