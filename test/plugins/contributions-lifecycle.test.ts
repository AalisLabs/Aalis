declare module '@aalis/api-contributions' {
  interface ContributionPointMap {
    '__t:lifecycle-point': { id: string; label: string };
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { App, definePlugin, type Logger } from '../../packages/core/src/index.js';
import { Registry } from '../../packages/plugin-contributions/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createActivationFixture } from '../helpers/activation.js';

// ════════════════════════════════════════════════════════════
// contributions 门面随插件激活的交付与撤回。贡献点 '__t:lifecycle-point' 经真实的 declaration merging
// 登记进 @aalis/api-contributions 的 ContributionPointMap：contribute / collect 不需要 as never，
// spec 的字段类型随键推导。撤回时机与关闭后登记的政策在 test/core 用测试枢纽锚定。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

describe('contributions 门面：交付随激活撤回', () => {
  it('交付随插件卸载撤回；collect 取快照', async () => {
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
    const app = new App({ name: 'T', logLevel: 'error', logger });
    apps.push(app);
    await registerHubs(app);
    await app.plugin(
      definePlugin({
        name: 'giver',
        uses: { contributions },
        apply: ({ contributions }) => void contributions.contribute('__t:lifecycle-point', { id: 'a', label: 'A' }),
      }),
    );
    await app.plugins.idle();
    const host = app.bind({ contributions });
    const snapshot = host.contributions.collect('__t:lifecycle-point');
    expect(snapshot.map(h => h.spec.label)).toEqual(['A']);
    await app.plugins.unload('giver');
    expect(host.contributions.collect('__t:lifecycle-point')).toEqual([]);
    expect(snapshot).toHaveLength(1);
  });

  it('登记与退订对称；全局键与局部 id 往返不失真（id 含空格等字符）', async () => {
    const root = createActivationFixture();
    root.caps.provide(contributions, new Registry());
    const p = root.host.create(root.activation, 'p');
    const bound = root.host.bind(p, { contributions }).contributions;
    const off = bound.contribute('__t:lifecycle-point', { id: 'a b', label: 'x' });
    expect(bound.collect('__t:lifecycle-point').map(entry => [entry.key, entry.spec.id])).toEqual([['p/a b', 'a b']]);
    off();
    expect(bound.collect('__t:lifecycle-point')).toEqual([]);
    await p.disposeAsync();
  });
});
