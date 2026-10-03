import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundPublish, PublishedItem } from '../../packages/api-publish/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import type { WorksSiteConfig } from '../../packages/plugin-works-site/src/config.js';
import type { WorksDeployer } from '../../packages/plugin-works-site/src/deploy.js';
import { WorksStore } from '../../packages/plugin-works-site/src/state.js';
import { registerWorksPage } from '../../packages/plugin-works-site/src/webui.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { memoryStorage } from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// 作品站页：经 webui-server 的真实登记表登记、取数与调动作。缩略图交发布服务给的存储地址（宿主换成 /api/media），
// 不碰审核插件的临时目录；状态写盘后页面重取，健康状况不正常时发「出错」提示，恢复后撤回。
// ════════════════════════════════════════════════════════════

const id = 'abcdefghij';
const item: PublishedItem = {
  id,
  group: 'opaque',
  groupLabel: '朋友',
  surfaces: ['works'],
  kind: 'media',
  title: '画',
  summary: '',
  publishedAt: 1,
  files: [{ path: 'image.png', size: 3, contentType: 'image/png' }],
  hasThumbnail: true,
};
const config: WorksSiteConfig = {
  targetId: 'works',
  basePath: '/',
  accountId: '0'.repeat(32),
  apiToken: 'sentinel',
  projectName: 'aalis',
  productionBranch: 'main',
  siteOrigin: 'https://aalis.pages.dev',
  mainOrigins: ['https://aalis.pages.dev'],
  failOpen: false,
  siteTitle: '作品集',
  siteIntro: '',
};

const running: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of running.splice(0)) {
    await app.stop();
    pages.dispose();
  }
});

async function fixture() {
  const store = new WorksStore(memoryStorage(new Map()));
  await store.load();
  await store.update(state => {
    state.current.main = { id: 'aaaaaaaa-1', branch: 'main', nonce: 'n1', at: 2, files: {}, works: [item] };
    state.history.push({ at: 3, branch: 'main', deployment: 'aaaaaaaa-1', result: 'live' });
  });
  const thumbnailUri = vi.fn((work: string) => `public:/${work}/thumb.png`);
  const withdraw = vi.fn(async () => ({ ok: true as const }));
  const publish = { current: { thumbnailUri, withdraw } } as unknown as BoundPublish;
  let health: { ok: true } | { ok: false; reason: string } = { ok: true };
  const deployer = {
    health: () => health,
    onlineFailOpen: false,
    active: true,
    change: vi.fn(),
    acknowledge: vi.fn(async () => false),
  };
  const app = new App({ name: 'T', logLevel: 'error' });
  const pages = pageHost();
  running.push({ app, pages });
  app.bind({ provide }).provide(webuiServer, pages.service);
  await app.plugin(
    definePlugin({
      name: 'zz-works-page',
      uses: { webui: webuiServer },
      apply: ({ webui }) =>
        registerWorksPage({ webui, publish, store, deployer: deployer as unknown as WorksDeployer, config }),
    }),
  );
  await app.plugins.idle();
  return {
    store,
    pages,
    deployer,
    withdraw,
    thumbnailUri,
    setHealth: (next: typeof health) => {
      health = next;
    },
  };
}

describe('作品站页', () => {
  it('过登记门槛：概况、作品、部署、告警四个标签；概况写主站与健康状况', async () => {
    const h = await fixture();
    expect(h.pages.logs).toEqual([]);
    const view = h.pages.view('works-site');
    expect(view).toMatchObject({ title: '作品站', placement: 'plugin', icon: 'images' });
    expect('tabs' in view.content && view.content.tabs.map(tab => tab.title)).toEqual(['概况', '作品', '部署', '告警']);
    expect(await h.pages.data('works-site', 'health')).toEqual(
      expect.arrayContaining([
        { label: '主站', value: 'https://aalis.pages.dev/', kind: 'link' },
        { label: '健康', value: { text: '正常' }, kind: 'status' },
        { label: '上次部署', value: 'live' },
      ]),
    );
  });

  it('作品的缩略图只取发布服务给的存储地址，宿主换成 /api/media', async () => {
    const h = await fixture();
    expect(await h.pages.data('works-site', 'works')).toEqual([
      {
        id,
        thumbnail: `/api/media?${new URLSearchParams({ uri: `public:/${id}/thumb.png` })}`,
        title: '画',
        kind: 'media',
        branch: '主站',
        alias: '',
        url: `https://aalis.pages.dev/w/${id}/`,
        at: 2,
      },
    ]);
    expect(h.thumbnailUri).toHaveBeenCalledWith(id);
  });

  it('撤下：交给发布服务并安排重新部署；不在线上的作品与读不出的告警回错误', async () => {
    const h = await fixture();
    expect(await h.pages.act('works-site', 'withdrawWork', { rowKey: id })).toEqual({
      status: 200,
      body: { message: '已撤下' },
    });
    expect(h.withdraw).toHaveBeenCalledWith(id, { kind: 'owner' }, 'owner 在作品页撤下');
    expect(h.deployer.change).toHaveBeenCalledTimes(1);
    expect(await h.pages.act('works-site', 'withdrawWork', { rowKey: 'bbbbbbbbbb' })).toEqual({
      status: 500,
      body: { error: '作品不存在' },
    });
    expect(await h.pages.act('works-site', 'acknowledgeAlert', { rowKey: 'none' })).toEqual({
      status: 500,
      body: { error: '告警不存在' },
    });
  });

  it('状态写盘后页面重取；健康状况不正常时发「出错」提示，恢复后撤回', async () => {
    const h = await fixture();
    expect(h.pages.notices()).toEqual([]);
    h.setHealth({ ok: false, reason: '部署连续失败' });
    const before = h.pages.invalidations.length;
    await h.store.update(state => {
      state.lastFailure = 'deploy-failed';
    });
    expect(h.pages.invalidations.slice(before)).toContainEqual({ instance: 'zz-works-page', pageKey: 'works-site' });
    expect(h.pages.notices()).toEqual([
      {
        instance: 'zz-works-page',
        id: 'health',
        level: 'error',
        title: '作品站：部署连续失败',
        open: { page: 'works-site' },
      },
    ]);
    h.setHealth({ ok: true });
    await h.store.update(state => {
      state.lastFailure = undefined;
    });
    expect(h.pages.notices()).toEqual([]);
  });
});
