import { afterEach, describe, expect, it } from 'vitest';
import {
  type App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  type PluginDefinition,
  provide,
} from '../../packages/core/src/index.js';
import { activationHost, createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// 编排层的边缘路径：required 真环的兜底排序、关停计划里缠绕的 required 环、重算振荡的点名告警、
// 管理动作的幂等早退、卸载在途时的 join、注册期与激活期的非 Error 抛出值。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world() {
  const lines: Array<{ level: 'debug' | 'info' | 'warn' | 'error'; text: string }> = [];
  const record =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (...args: unknown[]) =>
      void lines.push({ level, text: args.map(String).join(' ') });
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  const app = createInspectableApp({ config: { name: 'T', logLevel: 'debug', plugins: {} }, logger });
  apps.push(app);
  const at = (level: 'debug' | 'info' | 'warn' | 'error') =>
    lines.filter(line => line.level === level).map(line => line.text);
  return { app, at, host: app.bind({ provide }).provide };
}

const stateOf = (app: App, id: string) => app.plugins.getPlugin(id)?.state;

describe('插件拓扑：required 真环', () => {
  it('告警点出残留个数；环外插件先按拓扑序激活，环内成员按声明序追加在后', async () => {
    const w = world();
    const a = defineService<object>('zz-oe-cyc-a');
    const b = defineService<object>('zz-oe-cyc-b');
    const applied: string[] = [];
    await w.app.plugin(
      definePlugin({
        name: 'cyc-a',
        uses: { b, provide },
        provides: [a],
        apply({ provide }) {
          applied.push('cyc-a');
          provide(a, {});
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'cyc-b',
        uses: { a, provide },
        provides: [b],
        apply({ provide }) {
          applied.push('cyc-b');
          provide(b, {});
        },
      }),
    );
    await w.app.plugins.idle();
    // 两者互为 required 且没有别的提供者：谁也起不来
    expect(stateOf(w.app, 'cyc-a')).toBe('pending');
    expect(stateOf(w.app, 'cyc-b')).toBe('pending');
    expect(w.at('warn')).toContain('topoSortByDeps: 检测到 required 依赖环，残留 2 个按声明序追加');

    // 后注册、未声明 provides 的 seed 同时补上两项：它在拓扑前缀里先起，环内两者随后按声明序激活
    await w.app.plugin(
      definePlugin({
        name: 'seed',
        uses: { provide },
        apply({ provide }) {
          applied.push('seed');
          provide(a, {});
          provide(b, {});
        },
      }),
    );
    await w.app.plugins.idle();
    expect(applied).toEqual(['seed', 'cyc-a', 'cyc-b']);
    expect(stateOf(w.app, 'cyc-a')).toBe('active');
    expect(stateOf(w.app, 'cyc-b')).toBe('active');
  });

  it('已有 required 环时，多提供者的软边成环检查照常终止，环外插件照常激活', async () => {
    const w = world();
    const s = defineService<object>('zz-oe-multi-s');
    const d = defineService<object>('zz-oe-multi-d');
    const a = defineService<object>('zz-oe-multi-a');
    const b = defineService<object>('zz-oe-multi-b');
    const provider = (name: string) =>
      definePlugin({ name, uses: { provide }, provides: [s], apply: ({ provide }) => void provide(s, {}) });
    await w.app.plugin(provider('p1'));
    await w.app.plugin(provider('p2'));
    // hub 用 s（两个声明提供者：p1 是硬边，p2 是软边），它的下游 ring-a / ring-b 互为 required 成环。
    // p2 → hub 这条软边的成环检查要从 hub 顺着下游走，途经这个环也必须终止。
    await w.app.plugin(
      definePlugin({
        name: 'hub',
        uses: { s, provide },
        provides: [d],
        apply: ({ provide }) => void provide(d, {}),
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'ring-a',
        uses: { d, b, provide },
        provides: [a],
        apply: ({ provide }) => void provide(a, {}),
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'ring-b',
        uses: { a, provide },
        provides: [b],
        apply: ({ provide }) => void provide(b, {}),
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getStatus().map(p => [p.instanceId, p.state])).toEqual([
      ['p1', 'active'],
      ['p2', 'active'],
      ['hub', 'active'],
      ['ring-a', 'pending'],
      ['ring-b', 'pending'],
    ]);
    expect(w.at('warn')).toContain('topoSortByDeps: 检测到 required 依赖环，残留 2 个按声明序追加');
  });
});

describe('关停编排：缠绕的 required 环', () => {
  it('两个 required 环共用一个插件：每次只放开环内一个阶段，残环再点名一次，停机不悬挂', async () => {
    const w = world();
    const a = defineService<object>('zz-oe-fig-a');
    const b = defineService<object>('zz-oe-fig-b');
    const c = defineService<object>('zz-oe-fig-c');
    const closed: string[] = [];
    // seed 先垫上 b、c，hub 才能起；随后 left / right 以更高优先级顶替 b、c，又都 required 用 hub 的 a。
    // 停机时的胜者关系：hub ⇄ left、hub ⇄ right 两个 required 环共用 hub。
    await w.app.plugin(
      definePlugin({
        name: 'seed',
        uses: { provide },
        apply({ provide }) {
          provide(b, {});
          provide(c, {});
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'hub',
        uses: { b, c, provide, lifecycle },
        provides: [a],
        apply(caps) {
          caps.provide(a, {});
          caps.lifecycle.onDispose(() => void closed.push('hub'));
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'left',
        uses: { a, provide, lifecycle },
        provides: [b],
        apply(caps) {
          caps.provide(b, {}, { priority: 10 });
          caps.lifecycle.onDispose(() => void closed.push('left'));
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'right',
        uses: { a, provide, lifecycle },
        provides: [c],
        apply(caps) {
          caps.provide(c, {}, { priority: 10 });
          caps.lifecycle.onDispose(() => void closed.push('right'));
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.app.plugins.getStatus().every(p => p.state === 'active')).toBe(true);

    await w.app.stop();
    const cycles = w.at('warn').filter(x => x.includes('required 依赖成环'));
    expect(cycles).toEqual([
      '关停顺序：required 依赖成环 [right, left, hub]，环内无法保证都先于各自的提供者，其余顺序不受影响',
      '关停顺序：required 依赖成环 [left, hub]，环内无法保证都先于各自的提供者，其余顺序不受影响',
    ]);
    expect(closed).toEqual(['right', 'left', 'hub']);
  });
});

describe('重算振荡', () => {
  it('插件对来回翻转超过 2N+8 轮：告警点名末轮仍在翻转的插件，振荡停下后照常收敛', async () => {
    const w = world();
    const gate = defineService<object>('zz-oe-osc-gate');
    const blocker = defineService<object>('zz-oe-osc-blocker');
    let offGate = w.host(gate, {});
    const LIMIT = 6;
    let takeovers = 0;
    // opener 有 gate 才起并提供 blocker；closer 有 blocker 才起，起来就收走 gate、关闭时还回去。
    // 两者互相否定：每两轮翻转一次，直到 closer 第 LIMIT 次之后不再收 gate。
    await w.app.plugin(
      definePlugin({
        name: 'opener',
        uses: { gate, provide },
        provides: [blocker],
        apply: ({ provide }) => void provide(blocker, {}),
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'closer',
        uses: { blocker, lifecycle },
        apply({ lifecycle }) {
          if (takeovers >= LIMIT) return;
          takeovers++;
          offGate();
          lifecycle.onDispose(() => {
            offGate = w.host(gate, {});
          });
        },
      }),
    );
    await w.app.plugins.idle();

    const oscillation = w.at('warn').filter(x => x.includes('轮未收敛'));
    expect(oscillation).toEqual([
      'recompute 12 轮未收敛（上限 12 = 2×插件数+8），疑似插件间状态振荡。最后一轮仍在翻转: opener',
    ]);
    expect(takeovers).toBe(LIMIT);
    expect(stateOf(w.app, 'opener')).toBe('active');
    expect(stateOf(w.app, 'closer')).toBe('active');
  });
});

describe('管理动作的幂等早退', () => {
  it('已启用再 enable、已禁用再 disable：直接返回 true，不重跑激活也不重复落账', async () => {
    const w = world();
    let applies = 0;
    await w.app.plugin(definePlugin({ name: 'steady', apply: () => void applies++ }));
    await w.app.plugins.idle();
    expect(stateOf(w.app, 'steady')).toBe('active');

    expect(await w.app.plugins.enable('steady')).toBe(true);
    await w.app.plugins.idle();
    expect(stateOf(w.app, 'steady')).toBe('active');
    expect(applies).toBe(1);
    expect(w.at('info').filter(x => x.includes('插件已启用'))).toEqual([]);

    expect(await w.app.plugins.disable('steady')).toBe(true);
    expect(await w.app.plugins.disable('steady')).toBe(true);
    await w.app.plugins.idle();
    expect(stateOf(w.app, 'steady')).toBe('disabled');
    expect(w.at('info').filter(x => x.includes('插件已禁用'))).toEqual(['插件已禁用: steady']);
  });
});

describe('卸载在途时再 unload', () => {
  it('第二次返回时条目已离开注册表，可立即重新注册；第一次收尾不误删新条目', async () => {
    const w = world();
    const missing = defineService<object>('zz-oe-missing');
    const stale = definePlugin({ name: 'waiting', uses: { missing }, apply() {} });
    const fresh = definePlugin({ name: 'waiting', apply() {} });
    await w.app.plugin(stale);
    await w.app.plugins.idle();
    expect(stateOf(w.app, 'waiting')).toBe('pending');

    const first = w.app.plugins.unload('waiting');
    // 第一次已把条目写成 disposed、还没摘出注册表：第二次走 join 分支
    expect(stateOf(w.app, 'waiting')).toBe('disposed');
    let reRegister: Promise<boolean> | undefined;
    const second = w.app.plugins.unload('waiting').then(ok => {
      // 第二次返回的那一刻：旧条目已摘除，同名立即可注册
      reRegister = w.app.plugins.register(fresh);
      return ok;
    });
    expect(await second).toBe(true);
    expect(await reRegister).toBe(true);
    expect(await first).toBe(true);
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('waiting')?.definition).toBe(fresh);
    expect(stateOf(w.app, 'waiting')).toBe('active');
  });
});

describe('非 Error 抛出值的文案', () => {
  it('注册期校验以非 Error 值抛出：按 String 化的原因记 warn 并拒绝注册', async () => {
    const w = world();
    const definition = {
      name: 'odd-def',
      get uses(): never {
        throw 'uses 读取失败';
      },
      apply() {},
    } as unknown as PluginDefinition;
    expect(await w.app.plugins.register(definition)).toBe(false);
    expect(w.at('warn')).toContain('插件定义校验失败，拒绝注册: uses 读取失败');
    expect(w.app.plugins.getPlugin('odd-def')).toBeUndefined();
  });

  it('apply 以非 Error 值拒绝：error 态的文案是 String 化的原值', async () => {
    const w = world();
    await w.app.plugin(definePlugin({ name: 'odd-apply', apply: () => Promise.reject(404) }));
    await w.app.plugins.idle();
    const status = w.app.plugins.getStatus().find(p => p.instanceId === 'odd-apply');
    expect(status?.state).toBe('error');
    expect(status?.error).toBe('404');
    expect(w.at('error')).toContain('插件 "odd-apply" 激活失败: 404');
  });
});

describe('保留的安全网：故障注入', () => {
  it('关停计划里某个激活的阶段抛错：逐阶段记 error 点名，其余激活照常关闭、计划完成（故障激活自身的清理不保证）', async () => {
    const { app, at } = world();
    const disposed: string[] = [];
    for (const name of ['a', 'b']) {
      await app.plugin(
        definePlugin({
          name,
          uses: { lifecycle },
          apply({ lifecycle }) {
            lifecycle.onDispose(() => void disposed.push(name));
          },
        }),
      );
    }
    await app.plugins.idle();
    const a = [...rootActivation(app).children].find(child => child.id === 'a')!;
    a.resources.drain = () => {
      throw new Error('注入的收尾故障');
    };
    await app.stop();
    expect(at('error').filter(text => text.startsWith('关停 "a" 的'))).toEqual([
      expect.stringContaining('关停 "a" 的收尾阶段抛错'),
      expect.stringContaining('关停 "a" 的关闭阶段抛错'),
    ]);
    expect(disposed).toEqual(['b']);
  });

  it('拆卸编排整体抛错：记「拆卸抛错」，条目仍清掉激活引用、卸载照常完成', async () => {
    const { app, at } = world();
    await app.plugin(definePlugin({ name: 'solo', apply() {} }));
    await app.plugins.idle();
    const solo = [...rootActivation(app).children].find(child => child.id === 'solo')!;
    solo.closeInfo = () => {
      throw new Error('注入的编排故障');
    };
    expect(await app.plugins.unload('solo')).toBe(true);
    expect(at('error').filter(text => text.includes('拆卸抛错'))).toHaveLength(1);
    expect(app.plugins.getPlugin('solo')).toBeUndefined();
  });

  it('不传 logger 直接建根激活：给出明确报错', () => {
    const { app } = world();
    expect(() => activationHost(app).create(undefined, 'orphan')).toThrow('根激活需要 logger');
  });
});
