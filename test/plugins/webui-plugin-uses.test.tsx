// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PluginConfigPage } from '../../packages/plugin-webui-client/src/pages/PluginConfigPage.js';
import type { PluginInfo } from '../../packages/plugin-webui-client/src/types.js';

afterEach(cleanup);

it('没有配置的插件也能展开全部声明，核心与第三方服务统一标为必需或可选', () => {
  const plugin: PluginInfo = {
    name: 'declaration-only',
    instanceId: 'declaration-only',
    state: 'pending',
    provides: [],
    core: false,
    reusable: false,
    config: {},
    uses: [
      { key: 'bus', service: 'events', kind: 'required' },
      { key: 'logger', service: 'logger', kind: 'optional' },
      { key: 'db', service: 'storage', kind: 'required' },
      { key: 'cache', service: 'storage', kind: 'optional' },
    ],
    requiredServices: ['events', 'storage'],
    optionalServices: ['logger', 'storage'],
    capabilities: ['visibility:restricted'],
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
  expect(screen.queryByText('必需 bus → events')).toBeNull();
  fireEvent.click(screen.getByText('declaration-only'));
  expect(screen.getByText('必需 bus → events').title).toContain('服务就绪后');
  expect(screen.getByText('可选 logger').title).toContain('不阻止');
  expect(screen.getByText('必需 db → storage').title).toContain('服务就绪后');
  expect(screen.getByText('可选 cache → storage').title).toContain('不阻止');
  expect(screen.getByText('visibility:restricted').title).toBe('触达的敏感能力');
  expect(screen.queryByText('需 storage')).toBeNull();
});
