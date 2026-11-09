import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  LogHub,
  lifecycle,
  optional,
  provide,
} from '../../packages/core/src/index.js';

// 管理动作冻结关闭计划后给仍在初始化的激活发取消信号；监听器是插件代码，可能当场调 stop()。停机与在途的拆卸不能互等。

type Box = { save(): void };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await Promise.race([app.stop(), sleep(500)]);
});

const stopWithin = (app: App, ms: number): Promise<'ok' | 'timeout'> =>
  Promise.race([app.stop().then(() => 'ok' as const), sleep(ms).then(() => 'timeout' as const)]);

describe('取消信号的监听器里调 stop()', () => {
  it('停用提供者时同批仍在初始化的依赖方被 abort，它的监听器里调 stop()：停机照常结束，各插件都清理一次', async () => {
    const app = new App({ name: 'T', logHub: new LogHub() });
    apps.push(app);
    const svc = defineService<Box>('zz-reentry-abort');
    const disposed: string[] = [];
    const count = (name: string) => () => void disposed.push(name);
    await app.plugin(
      definePlugin({
        name: 'zz-provider',
        uses: { provide, lifecycle },
        provides: [svc],
        apply({ provide, lifecycle }) {
          provide.use(svc, { save() {} });
          lifecycle.use.onDispose(count('zz-provider'));
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'zz-outside',
        uses: { s: optional(svc), lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onDispose(count('zz-outside'));
        },
      }),
    );
    void app.plugin(
      definePlugin({
        name: 'zz-starting',
        uses: { s: svc, lifecycle },
        async apply({ lifecycle }) {
          lifecycle.use.onDispose(count('zz-starting'));
          const { signal } = lifecycle.use;
          signal.addEventListener('abort', () => void app.stop());
          await new Promise(resolve => signal.addEventListener('abort', resolve));
        },
      }),
    );
    await sleep(20);
    expect(app.plugins.getPlugin('zz-starting')?.state).toBe('activating');
    void app.plugins.disable('zz-provider');
    expect(await stopWithin(app, 2000)).toBe('ok');
    expect(disposed.sort()).toEqual(['zz-outside', 'zz-provider', 'zz-starting']);
  });
});
