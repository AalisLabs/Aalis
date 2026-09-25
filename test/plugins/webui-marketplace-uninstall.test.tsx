// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// 卸载只删代码目录与残留配置；插件写进存储根的数据没有插件归属、不会被清理，
// 插件市场与插件配置页两个卸载入口的确认弹窗都要把这一点说出来，免得用户以为卸载即清干净。

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  api: vi.fn(async (url: string) => {
    if (url.startsWith('/api/marketplace?')) {
      return {
        packages: [
          { name: '@example/plugin-demo', description: '', version: '1.0.0', installed: true, category: 'plugin' },
        ],
      };
    }
    if (url === '/api/system-components') return { components: [] };
    throw new Error(`unexpected ${url}`);
  }),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
}));

import { MarketplacePage } from '../../packages/plugin-webui-client/src/pages/MarketplacePage.js';
import { PluginConfigPage } from '../../packages/plugin-webui-client/src/pages/PluginConfigPage.js';
import type { PluginInfo } from '../../packages/plugin-webui-client/src/types.js';

afterEach(cleanup);

it('卸载确认弹窗提示存储根里的插件数据不会被删除', async () => {
  render(<MarketplacePage plugins={[]} onRefresh={() => {}} />);
  fireEvent.click(await screen.findByText('卸载'));
  expect(await screen.findByText(/存储根的数据不会被删除/)).toBeTruthy();
});

it('插件配置页的卸载确认弹窗同样提示存储根里的插件数据不会被删除', async () => {
  const plugin: PluginInfo = {
    name: '@example/plugin-demo',
    instanceId: '@example/plugin-demo',
    state: 'active',
    provides: [],
    reusable: false,
    uses: [],
    config: {},
  };
  render(
    <PluginConfigPage
      plugins={[plugin]}
      config={null}
      onRefresh={() => {}}
      onConfigSaved={() => {}}
      onRestart={() => {}}
    />,
  );
  fireEvent.click(screen.getByText('卸载'));
  expect(await screen.findByText(/存储根的数据不会被删除/)).toBeTruthy();
});
