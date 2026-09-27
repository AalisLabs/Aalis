// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// 建实例后激活失败时服务端回 500，但实例已登记为 error 态：前端显示原因之外还要刷新插件列表，否则看不到这个实例。
// 建实例与启停成功时，服务端回执可能附带说明（按禁用态登记、仍在激活、在等依赖）：照原样显示，不换成固定文案。

const FAILED = '已创建实例 multi:x，但激活失败，已转为 error 态（坏配置）；配置已写入配置文件';

const reply = vi.hoisted(() => ({
  handle: async (_url: string, _opts?: RequestInit): Promise<unknown> => {
    throw new Error('未设置回执');
  },
}));

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  api: vi.fn((url: string, opts?: RequestInit) => reply.handle(url, opts)),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
}));

import { PluginConfigPage } from '../../packages/plugin-webui-client/src/pages/PluginConfigPage.js';
import type { PluginInfo } from '../../packages/plugin-webui-client/src/types.js';

afterEach(cleanup);

function renderPage(plugin: Partial<PluginInfo>) {
  const onRefresh = vi.fn();
  render(
    <PluginConfigPage
      plugins={[
        {
          name: 'multi',
          instanceId: 'multi',
          state: 'active',
          provides: [],
          reusable: false,
          uses: [],
          config: {},
          ...plugin,
        },
      ]}
      config={null}
      onRefresh={onRefresh}
      onConfigSaved={() => {}}
      onRestart={() => {}}
    />,
  );
  return onRefresh;
}

function createInstance() {
  fireEvent.click(screen.getByText('+ 实例'));
  fireEvent.change(screen.getByPlaceholderText('输入实例后缀（如 vision）'), { target: { value: 'x' } });
  fireEvent.click(screen.getByText('创建'));
}

it('建实例失败：显示服务端给的原因，并刷新插件列表', async () => {
  reply.handle = async (url, opts) => {
    if (url === '/api/plugins/multi/instances' && opts?.method === 'POST') throw new Error(FAILED);
    throw new Error(`unexpected ${url}`);
  };
  const onRefresh = renderPage({ reusable: true });
  createInstance();
  expect(await screen.findByText(FAILED)).toBeTruthy();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('建实例成功：显示服务端回执里的说明', async () => {
  const message = '已创建实例 multi:x；配置文件的 disabledPlugins 里有它，已按禁用态登记，启用后激活';
  reply.handle = async url => {
    if (url === '/api/plugins/multi/instances') return { ok: true, instanceId: 'multi:x', message };
    throw new Error(`unexpected ${url}`);
  };
  renderPage({ reusable: true });
  createInstance();
  expect(await screen.findByText(message)).toBeTruthy();
});

it('启用成功：显示服务端回执里的说明', async () => {
  const message = '插件 multi 已启用；仍在激活（超过慢激活阈值，已转入后台），结果以插件列表为准';
  reply.handle = async url => {
    if (url === '/api/plugins/multi/enable') return { ok: true, message };
    throw new Error(`unexpected ${url}`);
  };
  renderPage({ state: 'disabled' });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(await screen.findByText(message)).toBeTruthy();
});
