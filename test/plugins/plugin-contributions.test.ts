import { describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { App, definePlugin } from '../../packages/core/src/index.js';
import type { Activation } from '../../packages/core/src/orchestration/activation.js';
import { Registry } from '../../packages/plugin-contributions/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createActivationFixture } from '../helpers/activation.js';

// plugin-contributions 的登记表经 contributions 门面（账本）使用：全局键、同键替换、随激活撤回。

// 测试用贡献点键。ContributionPointMap 是空接口（由 -api 包 merging 填充），
// 测试里与 hooks 测试同一惯例：用 as never 绕过键约束，运行时行为不受影响。
const POINT = '__t:point' as never;

type Spec = { id: string; payload?: string };

/** 根上登记 plugin-contributions 的登记表；at(id) 建一个子激活并绑定它的 contributions 门面 */
function world() {
  const root = createActivationFixture();
  const registry = new Registry();
  root.caps.provide(contributions, registry);
  const bind = (activation: Activation) => ({
    activation,
    registry,
    caps: root.host.bind(activation, { contributions }),
  });
  return { ...bind(root.activation), at: (id: string) => bind(root.host.create(root.activation, id)) };
}

/** 单个子激活 id 的夹具（'root' 即根自身） */
function makeFixture(id = 'root') {
  const w = world();
  return id === 'root' ? w : w.at(id);
}

describe('plugin-contributions 登记表 / contributions 门面', () => {
  it('注册顺序无关：collect 按全局键码元序，逐字节确定', () => {
    const root = world();
    const b = root.at('plugin-b');
    const a = root.at('plugin-a');
    // 故意乱序注册
    b.caps.contributions.contribute(POINT, { id: 'z' } as never);
    a.caps.contributions.contribute(POINT, { id: 'y' } as never);
    a.caps.contributions.contribute(POINT, { id: 'x' } as never);
    const keys = root.caps.contributions.collect(POINT).map(e => e.key);
    expect(keys).toEqual(['plugin-a/x', 'plugin-a/y', 'plugin-b/z']);
  });

  it('同 ctx 同 id 重复注册 = 替换（幂等），旧 dispose 失效不误删新注册', () => {
    const ctx = makeFixture('plugin-a');
    const off1 = ctx.caps.contributions.contribute(POINT, { id: 'k', payload: 'v1' } as never);
    ctx.caps.contributions.contribute(POINT, { id: 'k', payload: 'v2' } as never);
    let specs = ctx.caps.contributions.collect(POINT).map(e => e.spec as Spec);
    expect(specs).toHaveLength(1);
    expect(specs[0].payload).toBe('v2');
    // 旧注册的 dispose 不应删掉替换后的新注册
    off1();
    specs = ctx.caps.contributions.collect(POINT).map(e => e.spec as Spec);
    expect(specs).toHaveLength(1);
    expect(specs[0].payload).toBe('v2');
  });

  it('不同 ctx 的同名局部 id 互不干扰（全局键含 ctx.id 前缀，抢注不可能）', () => {
    const root = world();
    const a = root.at('plugin-a');
    const b = root.at('plugin-b');
    a.caps.contributions.contribute(POINT, { id: 'same', payload: 'from-a' } as never);
    b.caps.contributions.contribute(POINT, { id: 'same', payload: 'from-b' } as never);
    const specs = root.caps.contributions.collect(POINT).map(e => e.spec as Spec);
    expect(specs.map(s => s.payload).sort()).toEqual(['from-a', 'from-b']);
  });

  it('空 id 或含 "/" 的 id 在注册期抛错（防全局键碰撞构造）', () => {
    const ctx = makeFixture('plugin-a');
    expect(() => ctx.caps.contributions.contribute(POINT, { id: '' } as never)).toThrow(TypeError);
    expect(() => ctx.caps.contributions.contribute(POINT, { id: 'b/c' } as never)).toThrow(TypeError);
  });

  it('ctx dispose 清扫本 ctx 的全部贡献，不动兄弟 ctx 的', async () => {
    const root = world();
    const a = root.at('plugin-a');
    const b = root.at('plugin-b');
    a.caps.contributions.contribute(POINT, { id: 'x' } as never);
    b.caps.contributions.contribute(POINT, { id: 'y' } as never);
    await a.activation.disposeAsync();
    const keys = root.caps.contributions.collect(POINT).map(e => e.key);
    expect(keys).toEqual(['plugin-b/y']);
  });

  it('contribute 返回的 dispose 可手动解除，collect 返回快照不受后续注册影响', () => {
    const ctx = makeFixture('plugin-a');
    const off = ctx.caps.contributions.contribute(POINT, { id: 'x' } as never);
    const snapshot = ctx.caps.contributions.collect(POINT);
    off();
    expect(ctx.caps.contributions.collect(POINT)).toHaveLength(0);
    // 之前拿到的快照不变（不是活视图）
    expect(snapshot).toHaveLength(1);
  });

  it('collect 未知贡献点返回空数组', () => {
    expect(makeFixture().caps.contributions.collect('__t:nothing' as never)).toEqual([]);
  });

  it('同键反复重注册不在 dispose 链上累积闭包（替换时摘旧登记）', async () => {
    const ctx = makeFixture('plugin-a');
    // 首次登记挂上一条跟随提供者的清理（账本随提供者换人重挂），基线取在它之后
    ctx.caps.contributions.contribute(POINT, { id: 'k', payload: 'v0' } as never);
    const before = ctx.activation.resources.disposables.size;
    for (let i = 1; i < 50; i++) ctx.caps.contributions.contribute(POINT, { id: 'k', payload: `v${i}` } as never);
    // 登记表只剩最后一次：每轮替换由原语按同键顶掉上一次的登记
    expect(ctx.caps.contributions.collect(POINT).map(e => (e.spec as Spec).payload)).toEqual(['v49']);
    // 贡献不进清理链，链长不变（否则 50 个旧闭包滞留、旧 build 无法 GC）
    expect(ctx.activation.resources.disposables.size).toBe(before);
    // 不进链的那份登记仍随激活关闭整体切断
    await ctx.activation.disposeAsync();
    expect(ctx.caps.contributions.collect(POINT)).toHaveLength(0);
  });

  it('collect 按引用给出 spec：不拷贝、不改写 id，class 实例的原型方法完好', () => {
    const ctx = makeFixture('plugin-a');
    class Spec1 {
      id = 'cls';
      build() {
        return 'from-prototype';
      }
    }
    const original = new Spec1();
    ctx.caps.contributions.contribute(POINT, original as never);
    const [entry] = ctx.caps.contributions.collect(POINT);
    expect(entry.key).toBe('plugin-a/cls');
    expect(entry.spec).toBe(original); // 同一对象，非副本
    expect((entry.spec as unknown as Spec1).build()).toBe('from-prototype');
    expect((entry.spec as Spec).id).toBe('cls'); // 局部 id 未被改写为全局键
  });

  it('reusable 同一定义多实例：贡献按实例 id 分命名空间，互不顶替、卸载其一不误清另一个', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const root = app.bind({ contributions });
    const definition = definePlugin({
      name: 'dyn',
      reusable: true,
      uses: { contributions },
      apply({ contributions }) {
        contributions.contribute(POINT, { id: 'blk' } as never);
      },
    });
    await app.plugin(definition);
    await app.plugins.register(definition, {}, 'dyn:2');
    await app.plugins.idle();
    // 后注册的实例不顶替先注册者
    expect(root.contributions.collect(POINT).map(e => e.key)).toEqual(['dyn/blk', 'dyn:2/blk']);

    await app.plugins.unload('dyn');
    // 卸载其一不连带清掉另一个仍在役实例的贡献
    expect(root.contributions.collect(POINT).map(e => e.key)).toEqual(['dyn:2/blk']);
    await app.stop();
  });

  it('dispose 后的 contribute 被拒，不得顶替同 id 活实例的贡献', async () => {
    const root = world();
    const dead = root.at('plugin-a');
    dead.caps.contributions.contribute(POINT, { id: 'blk', payload: 'old' } as never);
    await dead.activation.disposeAsync();

    // bounce 后的新实例（同 ctx.id → 同全局键）
    const alive = root.at('plugin-a');
    alive.caps.contributions.contribute(POINT, { id: 'blk', payload: 'new' } as never);

    // 死 ctx 的迟到注册若被接受，会顶掉活实例的条目并被立即执行的 disposer 连带删除
    dead.caps.contributions.contribute(POINT, { id: 'blk', payload: 'zombie' } as never);

    const entries = root.caps.contributions.collect(POINT);
    expect(entries).toHaveLength(1);
    expect((entries[0].spec as Spec).payload).toBe('new');
  });

  it('退订即摘登记表条目：反复 contribute+off 不无界增长', () => {
    const ctx = makeFixture('plugin-a');
    ctx.caps.contributions.contribute(POINT, { id: 'warm' } as never)();
    const baseline = ctx.activation.resources.disposables.size;
    const withdrawn: ReturnType<typeof vi.fn>[] = [];
    const register = ctx.registry.register.bind(ctx.registry);
    vi.spyOn(ctx.registry, 'register').mockImplementation((...args) => {
      const off = vi.fn(register(...args));
      withdrawn.push(off);
      return off;
    });
    for (let i = 0; i < 200; i++) {
      ctx.caps.contributions.contribute(POINT, { id: `dyn-${i}` } as never)();
    }
    const previous = [...withdrawn];
    // 如果门面私有索引仍滞留旧 off，同键下一次登记会再次调用它；用真实退订次数检查索引释放。
    for (let i = 0; i < 200; i++) {
      ctx.caps.contributions.contribute(POINT, { id: `dyn-${i}` } as never)();
    }
    expect(previous.every(off => off.mock.calls.length === 1)).toBe(true);
    expect(ctx.caps.contributions.collect(POINT)).toHaveLength(0);
    expect(ctx.activation.resources.disposables.size, 'dispose 链不应滞留已退订的贡献闭包').toBe(baseline);
  });
});
