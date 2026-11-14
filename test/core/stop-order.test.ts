import { describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, LogHub, lifecycle, provide } from '../../packages/core/src/index.js';

// 停机时没有依赖关系的插件按登记序倒着关（后注册的先关），与激活实例挂上的先后无关：重启过的插件不被提到最前。
// 有依赖时，同时可关的阶段里仍取登记最晚的那个。

describe('停机次序：无依赖时后注册的先关', () => {
  it('先登记的 A 重启过之后停机：仍是 B 先收尾、先清理，A 在后', async () => {
    const app = new App({ logHub: new LogHub() });
    const trail: string[] = [];
    const plugin = (name: string) =>
      definePlugin({
        name,
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onDrain(() => void trail.push(`收尾 ${name}`));
          lifecycle.use.onDispose(() => void trail.push(`清理 ${name}`));
        },
      });
    await app.pluginAll([{ definition: plugin('A') }, { definition: plugin('B') }]);
    await app.plugins.bounce('A');
    await app.plugins.idle();
    trail.length = 0;
    await app.stop();
    expect(trail).toEqual(['收尾 B', '清理 B', '收尾 A', '清理 A']);
  });
});

describe('停机次序：同时可关的取登记最晚的', () => {
  it('消费者 Q 关完才轮到它的提供者 P，这时宿主也可以收尾：先关 P；宿主用着 B 的服务，B 的清理排在宿主收尾之后', async () => {
    const app = new App({ logHub: new LogHub() });
    const sp = defineService<object>('so-p');
    const sb = defineService<object>('so-b');
    const trail: string[] = [];
    const track = (name: string, use: { onDrain(run: () => void): unknown; onDispose(run: () => void): unknown }) => {
      use.onDrain(() => void trail.push(`收尾 ${name}`));
      use.onDispose(() => void trail.push(`清理 ${name}`));
    };
    const provider = (name: string, service: typeof sp) =>
      definePlugin({
        name,
        uses: { lifecycle, provide },
        provides: [service],
        apply({ lifecycle, provide }) {
          provide.use(service, {});
          track(name, lifecycle.use);
        },
      });
    const host = app.bind({ sb, lifecycle });
    track('宿主', host.lifecycle.use);
    await app.pluginAll(
      [
        definePlugin({ name: 'Q', uses: { lifecycle, sp }, apply: ({ lifecycle }) => track('Q', lifecycle.use) }),
        provider('P', sp),
        definePlugin({ name: 'A', uses: { lifecycle }, apply: ({ lifecycle }) => track('A', lifecycle.use) }),
        provider('B', sb),
      ].map(definition => ({ definition })),
    );
    await app.plugins.idle();
    await app.stop();
    expect(trail).toEqual([
      '收尾 B',
      '收尾 A',
      '清理 A',
      '收尾 Q',
      '清理 Q',
      '收尾 P',
      '清理 P',
      '收尾 宿主',
      '清理 B',
      '清理 宿主',
    ]);
  });
});
