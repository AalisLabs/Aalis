import { describe, expect, it } from 'vitest';
import { App, definePlugin, LogHub } from '../../packages/core/src/index.js';

// apply 抛出的值由插件决定，可能是任何东西：归因（是不是本次 required 依赖不可用）不能在它身上执行会抛错的操作。

describe('apply 抛出怪值', () => {
  it('读原型就抛错的对象（getPrototypeOf 陷阱抛错的 Proxy）：归因不抛，插件进 error，idle 落定', async () => {
    const app = new App({ name: 'T', logHub: new LogHub() });
    const hostile = new Proxy(new Error('x'), {
      getPrototypeOf() {
        throw new Error('trap');
      },
    });
    await app.plugin(
      definePlugin({
        name: 'zz-hostile',
        apply() {
          throw hostile;
        },
      }),
    );
    const settled = await Promise.race([
      app.plugins.idle().then(() => 'idle'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    expect(settled).toBe('idle');
    expect(app.plugins.getPlugin('zz-hostile')?.state).toBe('error');
    await app.stop();
  });
});
