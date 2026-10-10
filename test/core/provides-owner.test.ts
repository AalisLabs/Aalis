import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, type Logger, provide, services } from '../../packages/core/src/index.js';

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function world() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args) => void warnings.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'provides-owner', logLevel: 'error', logger, devMode: true });
  apps.push(app);
  return { app, warnings };
}

describe('provides checks the registering activation', () => {
  it('another activation cannot satisfy a declaration with the claimant’s entryId; rollback preserves its entry', async () => {
    const service = defineService<{ source: string }>('__t:owner-claim');
    const { app } = world();
    await app.plugin(
      definePlugin({
        name: 'donor',
        uses: { provide },
        apply({ provide }) {
          provide(service, { source: 'donor' }, { entryId: 'claimant/model' });
        },
      }),
    );
    await app.plugins.idle();

    await app.plugin(definePlugin({ name: 'claimant', provides: [service], apply() {} }));
    await app.plugins.idle();

    expect(app.plugins.getPlugin('claimant')?.state).toBe('error');
    expect(app.plugins.getPlugin('claimant')?.error).toContain('声明 provides');
    expect(
      app
        .bind({ services })
        .services.all(service)
        .map(({ contextId, instance }) => ({ contextId, instance })),
    ).toEqual([{ contextId: 'claimant/model', instance: { source: 'donor' } }]);
    expect(app.plugins.getPlugin('donor')?.state).toBe('active');
  });

  it('the dev-mode reverse check matches by owner: an entry registered for another identity counts for its registrant', async () => {
    const foreign = defineService<{ source: string }>('__t:owner-foreign');
    const { app, warnings } = world();
    await app.plugin(
      definePlugin({
        name: 'donor',
        uses: { provide },
        apply({ provide }) {
          provide(foreign, { source: 'donor' }, { entryId: 'claimant/foreign' });
        },
      }),
    );
    await app.plugins.idle();

    expect(warnings.filter(line => line.includes('插件 "donor"') && line.includes('未在 provides'))).toHaveLength(1);
  });

  it('an entry registered for another identity satisfies the registrant’s provides', async () => {
    const service = defineService<{ source: string }>('__t:owner-proxy');
    const { app } = world();
    await app.plugin(
      definePlugin({
        name: 'proxy',
        provides: [service],
        uses: { provide },
        apply({ provide }) {
          provide(service, { source: 'proxy' }, { entryId: 'other' });
        },
      }),
    );
    await app.plugins.idle();

    expect(app.plugins.getPlugin('proxy')?.state).toBe('active');
  });
});

describe('dev-mode duplicate provide advisory', () => {
  it('warns only for the same activation, service and contextId', async () => {
    const service = defineService<{ n: number }>('__t:owner-duplicate');
    const { app, warnings } = world();
    await app.plugin(
      definePlugin({
        name: 'dup',
        provides: [service],
        uses: { provide },
        apply({ provide }) {
          provide(service, { n: 1 }, { entryId: 'dup/sub' });
          provide(service, { n: 2 });
          provide(service, { n: 3 });
        },
      }),
    );
    await app.plugins.idle();

    expect(warnings.filter(line => line.includes('provide 过一次'))).toEqual([
      expect.stringContaining('服务 "__t:owner-duplicate" 已由本激活以 "dup" provide 过一次'),
    ]);
  });
});
