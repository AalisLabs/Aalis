import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, provide, services } from '../../packages/core/src/index.js';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

describe('follow 串行交接在旧清理同步改胜者时仍成立', () => {
  it('旧清理的 Promise 落定前不挂新实例；落定后挂的是清理里改过的胜者', async () => {
    const app = new App({ config: { name: 't', logLevel: 'error', plugins: {} }, devMode: false });
    apps.push(app);
    const S = defineService<{ name: string }>('t:reentry:s');
    const host = app.bind({ provide, services });
    host.provide(S, { name: 'A' }, { priority: 2, onBehalfOf: 'prov-a' });
    host.provide(S, { name: 'B' }, { priority: 1, onBehalfOf: 'prov-b' });
    host.provide(S, { name: 'C' }, { priority: 0, onBehalfOf: 'prov-c' });
    const log: string[] = [];
    let pending = 0;
    await app.plugin(
      definePlugin({
        name: 'f',
        uses: { s: S, services },
        apply({ s, services }) {
          s.follow(p => {
            log.push(`attach ${p.name} pending=${pending}`);
            return () => {
              pending++;
              // 旧清理同步改胜者：重入的 pump 必须让步，等本次清理落定后再按新胜者挂
              if (p.name === 'A') services.prefer(S, 'prov-c');
              return new Promise<void>(r => setTimeout(r, 10)).then(() => {
                pending--;
              });
            };
          });
        },
      }),
    );
    await app.plugins.idle();
    host.services.prefer(S, 'prov-b');
    await new Promise(r => setTimeout(r, 50));
    expect(log).toEqual(['attach A pending=0', 'attach C pending=0']);
  });
});
