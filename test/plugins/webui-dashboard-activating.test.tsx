// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginInfo } from '../../packages/plugin-webui-client/src/types.js';

// 仪表盘的插件计数曾只数 active 与 error：激活中的插件（含超过慢激活阈值、转入后台的）两头都不算，
// 「活跃插件 3 / 5」里少掉的两个无处可查。

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  api: vi.fn(async () => ({})),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
}));

import { DashboardPage } from '../../packages/plugin-webui-client/src/pages/DashboardPage.js';

afterEach(cleanup);

const row = (name: string, extra: Partial<PluginInfo>): PluginInfo => ({
  name,
  instanceId: name,
  state: 'active',
  provides: [],
  reusable: false,
  uses: [],
  config: {},
  ...extra,
});

const cardValue = (label: string) =>
  screen.getByText(label).parentElement?.querySelector('.overview-card-value')?.textContent;

it('激活中的插件（含转入后台的）单列计数', () => {
  render(
    <DashboardPage
      status={null}
      connected
      servicesData={null}
      plugins={[
        row('a', {}),
        row('b', { state: 'activating' }),
        row('c', { state: 'activating', slow: true }),
        row('d', { state: 'error' }),
        row('e', { state: 'disabled' }),
      ]}
    />,
  );
  expect(cardValue('活跃插件')).toBe('1 / 5');
  expect(cardValue('激活中插件')).toBe('2');
  expect(cardValue('错误插件')).toBe('1');
});

it('没有激活中的插件时不显示该卡片', () => {
  render(<DashboardPage status={null} connected servicesData={null} plugins={[row('a', {})]} />);
  expect(screen.queryByText('激活中插件')).toBeNull();
});
