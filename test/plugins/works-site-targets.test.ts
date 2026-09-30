import { describe, expect, it } from 'vitest';
import { storage } from '../../packages/api-storage/src/index.js';
import { type WebUIService, type WebuiPage, webuiServer } from '../../packages/api-webui/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import webuiPlugin from '../../packages/plugin-webui-server/src/index.js';
import { readConfig } from '../../packages/plugin-works-site/src/config.js';
import worksSite from '../../packages/plugin-works-site/src/index.js';
import { claimWorksTarget } from '../../packages/plugin-works-site/src/ownership.js';
import { STATE_URI, stateUriForInstance, WorksStore } from '../../packages/plugin-works-site/src/state.js';
import { hostedApp } from '../fixtures/app.js';
import { memoryStorage } from '../fixtures/paper.js';
import { freePort } from '../helpers/net.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const accountId = '0'.repeat(32);
const baseConfig = {
  accountId,
  apiToken: 'test-token',
  projectName: 'site-one',
  targetId: 'one',
  siteOrigin: 'https://one.example',
};
const parsed = (overrides: Record<string, unknown> = {}) => readConfig({ ...baseConfig, ...overrides }, silent);

describe('works-site target ownership', () => {
  it('keeps default state path and isolates other instance paths without sharing bytes', async () => {
    const disk = new Map<string, string>();
    const first = new WorksStore(memoryStorage(disk));
    const second = new WorksStore(memoryStorage(disk), '@aalis/plugin-works-site:draw');
    expect(first.uri).toBe(STATE_URI);
    expect(second.uri).toBe(stateUriForInstance('@aalis/plugin-works-site:draw'));
    expect(second.uri).not.toBe(first.uri);
    await first.load();
    await second.load();
    await first.update(state => {
      state.paused = { reason: 'one', at: 1 };
    });
    expect(second.data?.paused).toBeUndefined();
    expect(disk.has(first.uri)).toBe(true);
    expect(disk.has(second.uri)).toBe(true);
  });

  it('rejects duplicate target or project per App and releases only its own claim', () => {
    const appA = { stop: async () => {}, restart: () => {} };
    const appB = { stop: async () => {}, restart: () => {} };
    const one = parsed();
    const anotherTargetSameProject = parsed({ targetId: 'two' });
    const sameTargetDifferentProject = parsed({ projectName: 'site-two' });
    const other = parsed({ targetId: 'two', projectName: 'site-two' });
    const release = claimWorksTarget(appA, one);
    expect(() => claimWorksTarget(appA, anotherTargetSameProject)).toThrow(/已由/);
    expect(() => claimWorksTarget(appA, sameTargetDifferentProject)).toThrow(/已由/);
    const releaseOther = claimWorksTarget(appA, other);
    const releaseIndependent = claimWorksTarget(appB, one);
    release();
    expect(() => claimWorksTarget(appA, anotherTargetSameProject)).toThrow(/已由/); // other still owns target two
    releaseOther();
    expect(() => claimWorksTarget(appA, anotherTargetSameProject)).not.toThrow();
    releaseIndependent();
  });

  it('registers two real plugin instances with independent WebUI contexts before any Pages traffic', async () => {
    const pages: Array<{ contextId: string; page: WebuiPage }> = [];
    const disk = new Map<string, string>();
    const app = new App({ name: 'works-targets', logger: silent, logLevel: 'error' });
    const host = app.bind({ provide });
    host.provide(storage, memoryStorage(disk));
    host.provide(webuiServer, {
      registerPage(page: WebuiPage, contextId: string) {
        pages.push({ page, contextId });
        return () => {};
      },
      registerAction() {
        return () => {};
      },
    } as unknown as WebUIService);
    try {
      expect(await app.plugin(worksSite, baseConfig)).toBe(true);
      expect(
        await app.plugin(
          worksSite,
          {
            ...baseConfig,
            projectName: 'site-two',
            targetId: 'draw',
            siteOrigin: 'https://two.example',
            basePath: '/draw',
          },
          '@aalis/plugin-works-site:draw',
        ),
      ).toBe(true);
      await app.plugins.idle();
      expect(
        app.plugins
          .getStatus()
          .filter(item => item.name === worksSite.name)
          .map(item => item.state),
      ).toEqual(['active', 'active']);
      expect(pages.map(page => page.contextId).sort()).toEqual([
        '@aalis/plugin-works-site',
        '@aalis/plugin-works-site:draw',
      ]);
      expect(pages.map(({ page }) => page.key)).toEqual(['works-site:one', 'works-site:draw']);
      expect(pages[0]?.page.label).toContain('one');
      expect(pages[1]?.page.label).toContain('draw');
      expect(disk.has(STATE_URI)).toBe(true);
      expect(disk.has(stateUriForInstance('@aalis/plugin-works-site:draw'))).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('routes both instance pages and status actions through the actual WebUI server', async () => {
    const port = await freePort();
    const token = 'works-site-target-test';
    const { app } = hostedApp({ name: 'works-target-pages' }, { logger: silent });
    app.bind({ provide }).provide(storage, memoryStorage(new Map()));
    try {
      expect(
        await app.plugin(webuiPlugin, {
          port,
          host: '127.0.0.1',
          autoOpen: false,
          tokenMode: 'fixed',
          fixedToken: token,
        }),
      ).toBe(true);
      expect(await app.plugin(worksSite, { ...baseConfig, targetId: 'works' })).toBe(true);
      expect(
        await app.plugin(
          worksSite,
          {
            ...baseConfig,
            projectName: 'site-two',
            targetId: 'draw',
            siteOrigin: 'https://two.example',
            basePath: '/draw/',
          },
          '@aalis/plugin-works-site:draw',
        ),
      ).toBe(true);
      await app.plugins.idle();
      await app.start();
      const base = `http://127.0.0.1:${port}`;
      const headers = { Cookie: `aalis_webui_token=${token}` };
      const pages = (await (await fetch(`${base}/api/pages`, { headers })).json()) as Array<{
        key: string;
        plugin: string;
      }>;
      expect(pages.filter(page => page.key.startsWith('works-site')).map(page => [page.key, page.plugin])).toEqual([
        ['works-site', '@aalis/plugin-works-site'],
        ['works-site:draw', '@aalis/plugin-works-site:draw'],
      ]);
      for (const [plugin, expected] of [
        ['@aalis/plugin-works-site', 'https://one.example/'],
        ['@aalis/plugin-works-site:draw', 'https://two.example/draw/'],
      ]) {
        const response = await fetch(`${base}/api/page-action/${encodeURIComponent(plugin)}/worksStatus`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        });
        expect(response.status).toBe(200);
        expect(JSON.stringify(await response.json())).toContain(expected);
      }
    } finally {
      await app.stop();
    }
  });

  it('binds deployed state to its target, remote project, origin and directory', async () => {
    const disk = new Map<string, string>();
    const store = new WorksStore(memoryStorage(disk));
    await store.load();
    await store.bindScope(parsed());
    await store.update(state => {
      state.tombstones.push({ branch: 'main', path: '/w/abcdefghij/index.html', until: Date.now() + 1000 });
    });
    expect(disk.get(STATE_URI)).not.toContain(accountId);
    expect(disk.get(STATE_URI)).not.toContain('test-token');
    expect(store.data?.scope).toMatch(/^[a-f0-9]{64}$/);
    const reopened = new WorksStore(memoryStorage(disk));
    await reopened.load();
    await expect(reopened.bindScope(parsed())).resolves.toBeUndefined();
    for (const change of [
      { basePath: '/draw/' },
      { targetId: 'two' },
      { siteOrigin: 'https://two.example' },
      { projectName: 'site-two' },
      { accountId: '1'.repeat(32) },
      { productionBranch: 'production' },
    ]) {
      await expect(reopened.bindScope(parsed(change))).rejects.toThrow(/发布范围/);
    }
  });

  it('treats a deployed legacy v1 state as root and refuses a silent directory migration', async () => {
    const disk = new Map<string, string>();
    const legacy = new WorksStore(memoryStorage(disk));
    await legacy.load();
    await legacy.update(state => {
      state.known['12345678'] = { branch: 'main', at: 1 };
    });
    await expect(legacy.bindScope(parsed({ basePath: '/draw/' }))).rejects.toThrow(/发布范围/);
    await expect(legacy.bindScope(parsed({ targetId: 'works', basePath: '/' }))).resolves.toBeUndefined();
  });

  it('fails plugin activation before remote traffic when a deployed instance changes directory', async () => {
    const disk = new Map<string, string>();
    const previous = new WorksStore(memoryStorage(disk));
    await previous.load();
    await previous.bindScope(parsed({ targetId: 'works' }));
    await previous.update(state => {
      state.known['12345678'] = { branch: 'main', at: 1 };
    });
    const app = new App({ name: 'works-scope-change', logger: silent, logLevel: 'error' });
    app.bind({ provide }).provide(storage, memoryStorage(disk));
    try {
      await app.plugin(worksSite, { ...baseConfig, targetId: 'works', basePath: '/draw/' });
      await app.plugins.idle();
      expect(app.plugins.getStatus().find(item => item.name === worksSite.name)?.state).toBe('error');
    } finally {
      await app.stop();
    }
  });
});
