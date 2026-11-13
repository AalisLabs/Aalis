import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, type Logger, provide } from '../../packages/core/src/index.js';

const svc = defineService<object>('single-pass-svc');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const apps: App[] = [];
function world(options: { slowThresholdMs?: number } = {}) {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const app = new App({ logLevel: 'error', logger, ...options });
  apps.push(app);
  return app;
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('重算收敛之后不另跑一遍', () => {
  it('激活一个提供服务的插件：plugins.watch 的订阅只收到一次通知', async () => {
    const app = world();
    let notified = 0;
    app.plugins.watch(() => void notified++);
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { provide },
        provides: [svc],
        apply: ({ provide }) => void provide.use(svc, {}),
      }),
    );
    await app.plugins.idle();
    await tick();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    expect(notified).toBe(1);
  });
});

describe('重算途中到来的请求不丢', () => {
  it('激活失败的那次 apply 里登记的插件照常激活', async () => {
    const app = world();
    let late: Promise<unknown> | undefined;
    await app.plugin(
      definePlugin({
        name: 'failing',
        async apply() {
          await null;
          late = app.plugin(definePlugin({ name: 'late', apply() {} }));
          throw new Error('激活失败');
        },
      }),
    );
    await late;
    await app.plugins.idle();
    expect(app.plugins.getPlugin('failing')?.state).toBe('error');
    expect(app.plugins.getPlugin('late')?.state).toBe('active');
  });

  it('转入后台的那次激活等待期间登记的插件照常激活', async () => {
    const app = world({ slowThresholdMs: 5 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let late: Promise<unknown> | undefined;
    const slow = app.plugin(
      definePlugin({
        name: 'slow',
        async apply() {
          await null;
          late = app.plugin(definePlugin({ name: 'late', apply() {} }));
          await gate;
        },
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    await late;
    await app.plugins.idle();
    expect(app.plugins.getPlugin('slow')?.state).toBe('activating');
    expect(app.plugins.getPlugin('late')?.state).toBe('active');
    release();
    await slow;
    await app.plugins.idle();
    expect(app.plugins.getPlugin('slow')?.state).toBe('active');
  });
});
