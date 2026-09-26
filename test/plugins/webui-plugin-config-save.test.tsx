// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// 插件配置保存成功后显示服务端回执的 message：被裁掉的 schema 外字段等附注只在回执里，
// 固定的本地提示会把它们吞掉，用户以为改动全部生效。

const NOTED = '插件 demo 配置已更新（已忽略未声明的配置字段: typoField）';

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  api: vi.fn(async (url: string, opts?: RequestInit) => {
    if (url === '/api/plugins/demo/config' && opts?.method === 'PUT') return { ok: true, message: NOTED };
    throw new Error(`unexpected ${url}`);
  }),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
}));

import { PluginConfigPage } from '../../packages/plugin-webui-client/src/pages/PluginConfigPage.js';
import type { PluginInfo } from '../../packages/plugin-webui-client/src/types.js';

afterEach(cleanup);

it('保存插件配置：显示服务端回执里的 message（含附注），不用本地固定提示', async () => {
  const plugin: PluginInfo = {
    name: 'demo',
    instanceId: 'demo',
    state: 'active',
    provides: [],
    reusable: false,
    uses: [],
    config: { greeting: 'hi' },
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
  fireEvent.click(screen.getByText('demo'));
  fireEvent.click(screen.getByText('编辑配置'));
  fireEvent.click(screen.getByText('保存'));
  expect(await screen.findByText(NOTED)).toBeTruthy();
  expect(screen.queryByText('demo 配置已更新，正在重载…')).toBeNull();
});
