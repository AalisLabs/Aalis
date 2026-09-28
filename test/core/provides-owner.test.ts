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
          provide(service, { source: 'donor' }, { onBehalfOf: 'claimant/model' });
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

  it('another activation’s entry is excluded from the claimant’s dev-mode reverse check', async () => {
    const foreign = defineService<{ source: string }>('__t:owner-foreign');
    const { app, warnings } = world();
    await app.plugin(
      definePlugin({
        name: 'donor',
        uses: { provide },
        apply({ provide }) {
          provide(foreign, { source: 'donor' }, { onBehalfOf: 'claimant/foreign' });
        },
      }),
    );
    await app.plugins.idle();

    await app.plugin(definePlugin({ name: 'claimant', apply() {} }));
    await app.plugins.idle();

    expect(app.plugins.getPlugin('claimant')?.state).toBe('active');
    expect(warnings.filter(line => line.includes('插件 "claimant"') && line.includes('未在 provides'))).toEqual([]);
    expect(warnings.filter(line => line.includes('插件 "donor"') && line.includes('未在 provides'))).toEqual([]);
  });

  it('the activation’s own id/sub entry satisfies provides', async () => {
    const service = defineService<{ source: string }>('__t:owner-self');
    const { app } = world();
    await app.plugin(
      definePlugin({
        name: 'owner',
        provides: [service],
        uses: { provide },
        apply({ provide }) {
          provide(service, { source: 'owner' }, { entryId: 'owner/model' });
        },
      }),
    );
    await app.plugins.idle();

    expect(app.plugins.getPlugin('owner')?.state).toBe('active');
    expect(app.bind({ services }).services.all(service)[0]?.contextId).toBe('owner/model');
  });

  it('onBehalfOf remains outside the registering activation’s provides', async () => {
    const service = defineService<{ source: string }>('__t:owner-proxy');
    const { app, warnings } = world();
    await app.plugin(
      definePlugin({
        name: 'proxy',
        provides: [service],
        uses: { provide },
        apply({ provide }) {
          provide(service, { source: 'proxy' }, { onBehalfOf: 'other' });
        },
      }),
    );
    await app.plugins.idle();

    expect(app.plugins.getPlugin('proxy')?.state).toBe('error');
    expect(app.plugins.getPlugin('proxy')?.error).toContain('声明 provides');
    expect(warnings.filter(line => line.includes('为前缀'))).toEqual([]);
  });
});
