import { describe, expect, it } from 'vitest';
import { App, definePlugin, LogHub, lifecycle } from '../../packages/core/src/index.js';

// 停机时没有依赖关系的插件按登记序倒着关（后注册的先关），与激活实例挂上的先后无关：重启过的插件不被提到最前。

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
