import { describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, lifecycle, provide, services } from '../../packages/core/src/index.js';

// 停机只靠关停计划（根激活 → 全部插件激活）关掉每一个插件，不依赖资源层的任何父子级联。
describe('App.stop 关掉全部插件', () => {
  it('无依赖、有依赖、二级依赖的插件在 stop 后都已清理，服务从容器消失，条目进入 disposed', async () => {
    const app = new App({ name: 'stop-all', logLevel: 'error' });
    const A = defineService<{ v: number }>('t:stop-all:a');
    const B = defineService<{ v: number }>('t:stop-all:b');
    const closed: string[] = [];
    const mk = (name: string, provides?: typeof A, uses: Record<string, typeof A> = {}) =>
      definePlugin({
        name,
        provides: provides ? [provides] : undefined,
        uses: { provide, lifecycle, ...uses },
        apply(caps) {
          if (provides) caps.provide(provides, { v: 1 });
          caps.lifecycle.onDispose(() => void closed.push(name));
        },
      });
    await app.plugin(mk('solo'));
    await app.plugin(mk('a', A));
    await app.plugin(mk('b', B, { a: A }));
    await app.plugin(mk('c', undefined, { b: B }));
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(p => p.state)).toEqual(['active', 'active', 'active', 'active']);
    const lookup = app.bind({ services }).services;
    await app.stop();
    expect([...closed].sort()).toEqual(['a', 'b', 'c', 'solo']);
    expect(lookup.names().filter(n => n.startsWith('t:stop-all'))).toEqual([]);
    expect(app.plugins.getStatus().map(p => p.state)).toEqual(['disposed', 'disposed', 'disposed', 'disposed']);
  });
});
