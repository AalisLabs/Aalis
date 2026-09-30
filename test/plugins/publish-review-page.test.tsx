// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebuiPage } from '../../packages/api-webui/src/index.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { registerReviewPage } from '../../packages/plugin-publish-review/src/webui.js';
import type { WebuiPageDef } from '../../packages/plugin-webui-client/src/types.js';
import { registerWorksPage } from '../../packages/plugin-works-site/src/webui.js';

const actions = new Map<string, (args: Record<string, unknown>) => unknown>();
vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async (_plugin: string, method: string, args = {}) => actions.get(method)?.(args)),
  api: vi.fn(async () => ({})),
  errText: (_error: unknown, fallback: string) => fallback,
  proxiedMediaUrl: (url: string) => url,
}));

import { DynamicPage } from '../../packages/plugin-webui-client/src/components/DynamicPage.js';

afterEach(() => {
  cleanup();
  actions.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('真实审核页和作品站页在后台变化后自动刷新全页；切页与卸载回收旧定时器', async () => {
  vi.useFakeTimers();
  const pages: WebuiPage[] = [];
  const webui = {
    registerPage: (page: WebuiPage) => pages.push(page),
    registerAction: (key: string, action: (args: Record<string, unknown>) => unknown) => actions.set(key, action),
  } as never;
  const reviewStore = new ReviewStore({} as never);
  registerReviewPage({
    store: reviewStore,
    storage: {} as never,
    ownerTimeoutHours: 12,
    service: {} as never,
    preview: { active: [] } as never,
    webui,
  });
  let online = true;
  registerWorksPage({
    webui,
    publish: {} as never,
    store: {} as never,
    config: { siteOrigin: 'https://works.example', productionBranch: 'main', failOpen: false } as never,
    deployer: { health: () => ({ ok: online, reason: '后台部署失败' }) } as never,
  });
  const baselineTimers = vi.getTimerCount();
  const view = render(<DynamicPage page={{ ...pages[0]!, plugin: 'review' } as WebuiPageDef} />);
  await act(async () => {});
  expect(view.container.querySelectorAll('.dyn-stat-value')[2]?.textContent).toBe('0');
  reviewStore.data.nominations.push({ at: Date.now(), source: 'paper' });
  reviewStore.failure = '后台账本损坏';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(view.container.querySelectorAll('.dyn-stat-value')[2]?.textContent).toBe('1');
  expect(screen.getByText(/后台账本损坏/)).toBeTruthy();
  view.rerender(<DynamicPage page={{ ...pages[1]!, plugin: 'works' } as WebuiPageDef} />);
  await act(async () => {});
  expect(vi.getTimerCount()).toBe(baselineTimers + 1);
  online = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(screen.getByText(/后台部署失败/)).toBeTruthy();
  view.unmount();
  expect(vi.getTimerCount()).toBe(baselineTimers);
});
it('真实审核页面显示统计和说明；点击预览后出现可点链接，批准后同步刷新统计与链接', async () => {
  const store = new ReviewStore({} as never);
  const id = 'abcdefghij';
  store.data.queue[id] = {
    id,
    state: 'awaiting-owner',
    origin: { producer: 'paper', ref: 'one', label: '朋友' },
    group: 'g',
    groupLabel: 'g',
    surfaces: ['works'],
    title: '网页作品',
    summary: '',
    kind: 'html',
    files: [],
    hasCover: false,
    nominatedAt: Date.now(),
    awaitingSince: Date.now(),
    awaitingReason: 'fallback',
    review: {
      flags: ['模型拒绝'],
      reasons: ['包含不适合公开的内容'],
      images: [],
      hasRender: false,
      classification: '模型建议拒绝',
    },
  };
  const active: Array<{ id: string; url: string }> = [];
  let page!: WebuiPage;
  registerReviewPage({
    store,
    storage: {} as never,
    ownerTimeoutHours: 12,
    service: {
      approve: async () => {
        delete store.data.queue[id];
        return true;
      },
    } as never,
    preview: {
      active,
      open: async () => {
        const url = 'http://127.0.0.1:1234/random/';
        active.push({ id, url });
        return url;
      },
      revoke: () => {
        active.length = 0;
      },
    } as never,
    webui: {
      registerPage: (value: WebuiPage) => {
        page = value;
      },
      registerAction: (key: string, action: (args: Record<string, unknown>) => unknown) => {
        actions.set(key, action);
      },
    } as never,
  });
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { container } = render(
    <DynamicPage page={{ ...page, plugin: '@aalis/plugin-publish-review' } as WebuiPageDef} />,
  );
  await screen.findByText('网页作品');
  await screen.findByText('自动审核未通过，需人工裁决');
  await screen.findByText('包含不适合公开的内容');
  await screen.findByText(/撤下后，已打开页面/);
  await waitFor(() => expect(container.querySelector('.dyn-stat-value')?.textContent).toBe('1'));
  fireEvent.click(screen.getByRole('button', { name: '隔离预览' }));
  expect((await screen.findByRole('link', { name: id })).getAttribute('href')).toBe('http://127.0.0.1:1234/random/');
  fireEvent.click(screen.getByRole('button', { name: '批准' }));
  await waitFor(() => expect(screen.queryByRole('link', { name: id })).toBeNull());
  await waitFor(() => expect(container.querySelector('.dyn-stat-value')?.textContent).toBe('0'));
});
