import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundPublish, PublishedItem, PublishSurface } from '../../packages/api-publish/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import type { PagesClient } from '../../packages/plugin-works-site/src/cloudflare/client.js';
import type { WorksSiteConfig } from '../../packages/plugin-works-site/src/config.js';
import { WorksDeployer } from '../../packages/plugin-works-site/src/deploy.js';
import { WorksStore } from '../../packages/plugin-works-site/src/state.js';
import { registerWorksPage } from '../../packages/plugin-works-site/src/webui.js';
import { defineTexts, resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { ownView } from '../fixtures/own-storage.js';
import { type PageHost, pageHost, replyOf } from '../fixtures/page-host.js';
import { memoryStorage } from '../fixtures/paper.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 作品站页：经 webui-server 的真实登记表登记、取数与调动作。缩略图交发布服务给的存储地址（宿主换成 /api/media），
// 不碰审核插件的临时目录；状态写盘后页面重取，健康状况不正常时发「出错」提示，恢复后撤回。
// ════════════════════════════════════════════════════════════

/** 默认实例的状态文件 */
const STATE_URI = 'pluginData:/works-site/state.json';
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

/** 发布服务交来的状态与拒绝原因：文字对象 */
const t = defineTexts({
  ns: '@zz/works-site-page',
  language: 'zh-CN',
  source: { paused: '已暂停', ledgerDown: '账本读不出来' } as const,
  locales: { en: { paused: 'Paused', ledgerDown: 'The ledger cannot be read' } },
});

const running: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of running.splice(0)) {
    await app.stop();
    pages.dispose();
  }
});

/** 起页面：webui-server 的真实登记表，作品站页登记在 zz-works-page 名下 */
async function serve(store: WorksStore, deployer: WorksDeployer, publish: BoundPublish) {
  const app = new App({ name: 'T', logLevel: 'error' });
  const pages = pageHost();
  running.push({ app, pages });
  app.bind({ provide }).provide.use(webuiServer, pages.service);
  await app.plugin(
    definePlugin({
      name: 'zz-works-page',
      uses: { webui: webuiServer },
      apply: ({ webui }) =>
        registerWorksPage({ webui: webui.use, publish: fixedRef(publish), store, deployer, config }),
    }),
  );
  await app.plugins.idle();
  return pages;
}

async function fixture() {
  const store = new WorksStore(ownView(memoryStorage(new Map()), 'works-site'));
  await store.load();
  await store.update(state => {
    state.current.main = { id: 'aaaaaaaa-1', branch: 'main', nonce: 'n1', at: 2, files: {}, works: [item] };
    state.history.push({ at: 3, branch: 'main', deployment: 'aaaaaaaa-1', result: 'live' });
  });
  const thumbnailUri = vi.fn((work: string) => `public:/${work}/thumb.png`);
  const withdraw = vi.fn(async () => ({ ok: true as const }));
  let health: ReturnType<PublishSurface['health']> = { ok: true };
  const deployer = {
    health: () => health,
    onlineFailOpen: false as boolean | undefined,
    active: true,
    change: vi.fn(),
    retry: vi.fn(),
    acknowledge: vi.fn(async () => false),
    resume: vi.fn(async () => false),
    alignSettings: vi.fn(async () => {}),
    cleanupUnknown: vi.fn(async () => {}),
  };
  const publish = { thumbnailUri, withdraw } as unknown as BoundPublish;
  const pages = await serve(store, deployer as unknown as WorksDeployer, publish);
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
  it('过登记门槛：概况、作品、部署、告警四个标签；暂停原因原样交给出口', async () => {
    const h = await fixture();
    expect(h.pages.logs).toEqual([]);
    const view = toSource(h.pages.view('works-site'));
    expect(view).toMatchObject({ title: '作品站', placement: 'plugin', icon: 'images' });
    expect('tabs' in view.content && view.content.tabs.map(tab => tab.title)).toEqual(['概况', '作品', '部署', '告警']);
    // 暂停原因是文字对象，原样交给出口按读者语言渲染
    await h.store.update(state => {
      state.paused = { reason: t('paused'), at: 4 };
    });
    const rows = await h.pages.data<Array<{ label: unknown; value: unknown }>>('works-site', 'health');
    expect(rows.find(row => toSource(row.label) === '暂停')?.value).toEqual(t('paused'));
  });

  it('作品的缩略图只取发布服务给的存储地址，宿主换成 /api/media', async () => {
    const h = await fixture();
    expect(toSource(await h.pages.data('works-site', 'works'))).toEqual([
      {
        id,
        thumbnail: `/api/media?${new URLSearchParams({ uri: `public:/${id}/thumb.png` })}`,
        title: '画',
        kind: '媒体',
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
    expect(toSource(await h.pages.act('works-site', 'withdrawWork', { rowKey: id }))).toEqual({
      status: 200,
      body: { message: '已撤下' },
    });
    expect(h.withdraw).toHaveBeenCalledWith(id, { kind: 'owner' }, 'owner 在作品页撤下');
    expect(h.deployer.change).toHaveBeenCalledTimes(1);
    expect(await h.pages.act('works-site', 'withdrawWork', { rowKey: 'bbbbbbbbbb' })).toMatchObject({ status: 500 });
    expect(await h.pages.act('works-site', 'acknowledgeAlert', { rowKey: 'none' })).toMatchObject({ status: 500 });
  });

  it('撤下时发布服务交来的站点状态与拒绝原因是文字对象：回执与报错按读者语言渲染', async () => {
    const h = await fixture();
    h.withdraw.mockResolvedValueOnce({ ok: true, degraded: t('paused') } as never);
    const { body } = await h.pages.act('works-site', 'withdrawWork', { rowKey: id });
    const message = (body as { message: unknown }).message as never;
    expect(resolveText(message, ['en'])).toBe('Withdrawal registered; site status: Paused');
    expect(resolveText(message, ['zh-CN'])).toBe('撤下已登记；站点状态：已暂停');
    h.withdraw.mockResolvedValueOnce({ refused: t('ledgerDown') } as never);
    expect(await h.pages.act('works-site', 'withdrawWork', { rowKey: id })).toEqual({
      status: 500,
      body: { error: t('ledgerDown') },
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
    expect(toSource(h.pages.notices())).toEqual([
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

  it.each([
    [
      'en',
      {
        overview: [
          { label: 'Publish target', value: 'works' },
          { label: 'Main site', value: 'https://aalis.pages.dev/', kind: 'link' },
          { label: 'Health', value: { text: 'OK' }, kind: 'status' },
          { label: 'Last deployment', value: 'Live' },
          { label: 'Last deployed at', value: 9, kind: 'time' },
          { label: 'Paused', value: 'No' },
          { label: 'fail_open', value: 'Expected false; online: true' },
          { label: 'Token expiry', value: 'Unknown or never expires' },
        ],
        unchecked: [
          { label: 'Last deployment', value: 'None yet' },
          { label: 'fail_open', value: 'Expected false; online: not checked' },
        ],
        works: [
          ['Web page', 'p-0a1b2c3d'],
          ['Media', 'Main site'],
        ],
        history: ['Live', 'Failed', 'Rolled back', 'zz-result'],
        alerts: ['Untracked deployment', 'Cache lag', 'zz-kind'],
        replies: [
          'Marked as read',
          'Alert not found',
          'Scheduled a deployment retry',
          'Resumed automatic deployment',
          'Mark the unread alerts as read first',
          'Project settings aligned',
          'Aligning the project settings failed',
          'Redeployed and cleaned up untracked deployments',
          'Redeploying and cleaning up did not finish',
          'Work not found',
          'The works site has not started or has stopped',
        ],
      },
    ],
    [
      'zh-CN',
      {
        overview: [
          { label: '发布目标', value: 'works' },
          { label: '主站', value: 'https://aalis.pages.dev/', kind: 'link' },
          { label: '健康', value: { text: '正常' }, kind: 'status' },
          { label: '上次部署', value: '已上线' },
          { label: '上次部署时间', value: 9, kind: 'time' },
          { label: '暂停', value: '否' },
          { label: 'fail_open', value: '期望 false，线上 true' },
          { label: 'token 到期', value: '未知或不过期' },
        ],
        unchecked: [
          { label: '上次部署', value: '尚无' },
          { label: 'fail_open', value: '期望 false，线上 未核对' },
        ],
        works: [
          ['网页', 'p-0a1b2c3d'],
          ['媒体', '主站'],
        ],
        history: ['已上线', '失败', '已回滚', 'zz-result'],
        alerts: ['账外部署', '缓存滞后', 'zz-kind'],
        replies: [
          '已标为已读',
          '告警不存在',
          '已安排重试部署',
          '已恢复自动部署',
          '请先把未读告警标为已读',
          '项目设置已对齐',
          '项目设置对齐失败',
          '已重新部署并清理账外部署',
          '重新部署与清理未完成',
          '作品不存在',
          '作品站尚未启动或已停止',
        ],
      },
    ],
  ])('%s：概况、作品类型与分支、部署结果、告警类型，动作的回执与报错（不在表里的结果与告警类型显示原值）', async (language, expected) => {
    const h = await fixture();
    const page = { ...item, id: 'bcdefghijk', group: 'g1', kind: 'html' as const };
    await h.store.update(state => {
      state.groups.g1 = { branch: 'p-0a1b2c3d', createdAt: 1 };
      state.current.main.works = [page, item];
      state.history = (['live', 'failed', 'rolled-back', 'zz-result'] as const).map(result => ({
        at: 9,
        branch: 'main',
        deployment: 'aaaaaaaa-1',
        result,
      }));
      state.alerts = ['unknown-deployment', 'cache-lag', 'zz-kind'].map((kind, i) => ({
        id: `a${i}`,
        kind: kind as 'cache-lag',
        detail: 'test',
        at: 1,
      }));
    });
    h.deployer.onlineFailOpen = true;
    const rows = async (id: string) =>
      renderIn(await h.pages.data<Array<Record<string, unknown>>>('works-site', id), language);
    expect(await rows('health')).toEqual(expected.overview);
    expect((await rows('works')).map(row => [row.kind, row.branch])).toEqual(expected.works);
    expect((await rows('history')).map(row => row.result)).toEqual(expected.history);
    expect((await rows('alerts')).map(row => row.kind)).toEqual(expected.alerts);
    await h.store.update(state => {
      state.history = [];
    });
    h.deployer.onlineFailOpen = undefined;
    expect(await rows('health')).toEqual(expect.arrayContaining(expected.unchecked));

    h.deployer.acknowledge.mockResolvedValueOnce(true);
    h.deployer.resume.mockResolvedValueOnce(true);
    h.deployer.alignSettings.mockResolvedValueOnce().mockRejectedValueOnce(new Error('x'));
    h.deployer.cleanupUnknown.mockResolvedValueOnce().mockRejectedValueOnce(new Error('x'));
    const act = (action: string, rowKey?: string) => h.pages.act('works-site', action, rowKey ? { rowKey } : {});
    const replies = [
      await act('acknowledgeAlert', 'a0'),
      await act('acknowledgeAlert', 'none'),
      await act('retryDeploy'),
      await act('resumeDeploy'),
      await act('resumeDeploy'),
      await act('alignSettings'),
      await act('alignSettings'),
      await act('cleanupUnknown'),
      await act('cleanupUnknown'),
      await act('withdrawWork', 'cdefghijkl'),
    ];
    h.deployer.active = false;
    replies.push(await act('retryDeploy'));
    expect(renderIn(replies.map(replyOf), language)).toEqual(expected.replies);
  });

  it.each([
    ['en', 'The works site state file could not be read', 'Works site: The works site state file could not be read'],
    ['zh-CN', '作品站状态文件读取失败', '作品站：作品站状态文件读取失败'],
  ])('%s：状态文件读不出时，概况的健康一栏、「出错」提示与动作的报错', async (language, reason, title) => {
    const store = new WorksStore(ownView(memoryStorage(new Map([[STATE_URI, '{broken']])), 'works-site'));
    await store.load();
    const deployer = new WorksDeployer({
      config,
      store,
      client: {} as PagesClient,
      publish: ref(),
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: new AbortController().signal,
    });
    const pages = await serve(store, deployer, {} as BoundPublish);
    expect(renderIn(await pages.data('works-site', 'health'), language)).toContainEqual({
      label: language === 'en' ? 'Health' : '健康',
      value: { text: reason, state: 'error' },
      kind: 'status',
    });
    const titles = pages.notices().map(notice => notice.title);
    expect(renderIn(titles, language)).toEqual([title]);
    const { body } = await pages.act('works-site', 'retryDeploy');
    expect(renderIn(body, language)).toEqual({ error: reason });
  });
});
