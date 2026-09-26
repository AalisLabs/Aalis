// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PluginConfigPage } from '../../packages/plugin-webui-client/src/pages/PluginConfigPage.js';
import type { PluginInfo } from '../../packages/plugin-webui-client/src/types.js';

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

it('激活中的插件显示「激活中」，转入后台的另注明超过阈值', () => {
  render(
    <PluginConfigPage
      plugins={[row('warming', { state: 'activating' }), row('stalled', { state: 'activating', slow: true })]}
      config={null}
      onRefresh={() => {}}
      onConfigSaved={() => {}}
      onRestart={() => {}}
    />,
  );
  const warming = screen.getByText('激活中');
  expect(warming.className).toBe('badge pending');
  const stalled = screen.getByText('激活中（超过阈值）');
  expect(stalled.className).toBe('badge pending');
});
