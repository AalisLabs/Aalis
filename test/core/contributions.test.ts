import { describe, expect, it } from 'vitest';
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '../../packages/core/src/index.js';

// 测试用贡献点键。ContributionPointMap 是空接口（由 -api 包 merging 填充），
// 测试里与 hooks 测试同一惯例：用 as never 绕过键约束，运行时行为不受影响。
const POINT = '__t:point' as never;

type Spec = { id: string; payload?: string };

function makeContext(id = 'root'): Context {
  return new Context({
    id,
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger: new DefaultLogger('test'),
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  });
}

describe('ContributionRegistry / Context.contribute / collect', () => {
  it('注册顺序无关：collect 按全局键码元序，逐字节确定', () => {
    const root = makeContext();
    const b = root.fork('plugin-b');
    const a = root.fork('plugin-a');
    // 故意乱序注册
    b.contribute(POINT, { id: 'z' } as never);
    a.contribute(POINT, { id: 'y' } as never);
    a.contribute(POINT, { id: 'x' } as never);
    const keys = root.collect(POINT).map(e => e.key);
    expect(keys).toEqual(['plugin-a/x', 'plugin-a/y', 'plugin-b/z']);
  });

  it('同 ctx 同 id 重复注册 = 替换（幂等），旧 dispose 失效不误删新注册', () => {
    const ctx = makeContext().fork('plugin-a');
    const off1 = ctx.contribute(POINT, { id: 'k', payload: 'v1' } as never);
    ctx.contribute(POINT, { id: 'k', payload: 'v2' } as never);
    let specs = ctx.collect(POINT).map(e => e.spec as Spec);
    expect(specs).toHaveLength(1);
    expect(specs[0].payload).toBe('v2');
    // 旧注册的 dispose 不应删掉替换后的新注册
    off1();
    specs = ctx.collect(POINT).map(e => e.spec as Spec);
    expect(specs).toHaveLength(1);
    expect(specs[0].payload).toBe('v2');
  });

  it('不同 ctx 的同名局部 id 互不干扰（全局键含 ctx.id 前缀，抢注不可能）', () => {
    const root = makeContext();
    const a = root.fork('plugin-a');
    const b = root.fork('plugin-b');
    a.contribute(POINT, { id: 'same', payload: 'from-a' } as never);
    b.contribute(POINT, { id: 'same', payload: 'from-b' } as never);
    const specs = root.collect(POINT).map(e => e.spec as Spec);
    expect(specs.map(s => s.payload).sort()).toEqual(['from-a', 'from-b']);
  });

  it('空 id 或含 "/" 的 id 在注册期抛错（防全局键碰撞构造）', () => {
    const ctx = makeContext().fork('plugin-a');
    expect(() => ctx.contribute(POINT, { id: '' } as never)).toThrow(TypeError);
    expect(() => ctx.contribute(POINT, { id: 'b/c' } as never)).toThrow(TypeError);
  });

  it('ctx dispose 清扫本 ctx 的全部贡献，不动兄弟 ctx 的', () => {
    const root = makeContext();
    const a = root.fork('plugin-a');
    const b = root.fork('plugin-b');
    a.contribute(POINT, { id: 'x' } as never);
    b.contribute(POINT, { id: 'y' } as never);
    a.dispose();
    const keys = root.collect(POINT).map(e => e.key);
    expect(keys).toEqual(['plugin-b/y']);
  });

  it('contribute 返回的 dispose 可手动解除，collect 返回快照不受后续注册影响', () => {
    const ctx = makeContext().fork('plugin-a');
    const off = ctx.contribute(POINT, { id: 'x' } as never);
    const snapshot = ctx.collect(POINT);
    off();
    expect(ctx.collect(POINT)).toHaveLength(0);
    // 之前拿到的快照不变（不是活视图）
    expect(snapshot).toHaveLength(1);
  });

  it('collect 未知贡献点返回空数组', () => {
    expect(makeContext().collect('__t:nothing' as never)).toEqual([]);
  });

  it('同键反复重注册不在 dispose 链上累积闭包（替换时摘旧登记）', () => {
    const ctx = makeContext().fork('plugin-a');
    const before = ctx.disposableCount;
    for (let i = 0; i < 50; i++) ctx.contribute(POINT, { id: 'k', payload: `v${i}` } as never);
    expect(ctx.collect(POINT)).toHaveLength(1);
    // 每轮替换都摘掉上一次的登记，链长恒定（否则 50 个旧闭包滞留、旧 build 无法 GC）
    expect(ctx.disposableCount - before).toBe(1);
  });

  it('collect 按引用给出 spec：不拷贝、不改写 id，class 实例的原型方法完好', () => {
    const ctx = makeContext().fork('plugin-a');
    class Spec1 {
      id = 'cls';
      build() {
        return 'from-prototype';
      }
    }
    const original = new Spec1();
    ctx.contribute(POINT, original as never);
    const [entry] = ctx.collect(POINT);
    expect(entry.key).toBe('plugin-a/cls');
    expect(entry.spec).toBe(original); // 同一对象，非副本
    expect((entry.spec as unknown as Spec1).build()).toBe('from-prototype');
    expect((entry.spec as Spec).id).toBe('cls'); // 局部 id 未被改写为全局键
  });

  it('useModule 同名重复挂载：ctx.id 唯一化，贡献互不顶替、dispose 不误清兄弟', async () => {
    const root = makeContext();
    const mod = {
      name: 'dyn',
      apply(c: Context) {
        c.contribute(POINT, { id: 'blk' } as never);
      },
    };
    const off1 = await root.useModule(mod);
    await root.useModule(mod);
    expect(root.collect(POINT)).toHaveLength(2); // 后挂载者不顶替先挂载者

    off1();
    // 卸载其一不连带清掉另一个仍在役沙盒的贡献
    expect(root.collect(POINT)).toHaveLength(1);
  });
});
