// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// 建实例回 2xx 即实例已登记、配置已写入（激活失败转 error 态也一样）：收起表单、刷新插件列表，回执里的说明照原样显示。
// 落盘失败（回执带 applied）时实例已在运行态登记：同样收起表单、刷新，原因照原样显示；其余错误码表单留着供改正。
// 启停成功时，服务端回执可能附带说明（仍在激活、在等依赖）：照原样显示，不换成固定文案。
// 改配置、删实例出错时同样刷新插件列表：落盘失败（回执带 applied）、删实例后卸载失败时，运行态或配置已经变了。

const SUFFIX_INPUT = '输入实例后缀（如 vision）';

const reply = vi.hoisted(() => ({
  handle: async (_url: string, _opts?: RequestInit): Promise<unknown> => {
    throw new Error('未设置回执');
  },
}));

vi.mock('../../packages/plugin-webui-client/src/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../packages/plugin-webui-client/src/api.js')>()),
  api: vi.fn((url: string, opts?: RequestInit) => reply.handle(url, opts)),
}));

import { ApiError } from '../../packages/plugin-webui-client/src/api.js';
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
  fireEvent.change(screen.getByPlaceholderText(SUFFIX_INPUT), { target: { value: 'x' } });
  fireEvent.click(screen.getByText('创建'));
}

it('建实例后激活失败（2xx）：显示回执里的原因，收起表单并刷新插件列表', async () => {
  const message = '已创建实例 multi:x，但激活失败，已转为 error 态（坏配置）；配置已写入配置文件';
  reply.handle = async (url, opts) => {
    if (url === '/api/plugins/multi/instances' && opts?.method === 'POST') {
      return { ok: true, instanceId: 'multi:x', message, ignored: [] };
    }
    throw new Error(`unexpected ${url}`);
  };
  const onRefresh = renderPage({ reusable: true });
  createInstance();
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.queryByPlaceholderText(SUFFIX_INPUT), '实例已登记，表单留着再点「创建」只会得到「已存在」').toBeNull();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('建实例落盘失败（回执带 applied）：显示原因，收起表单并刷新插件列表', async () => {
  const error =
    '已在运行态生效，但未写入配置文件（配置文件有尚未生效的外部修改，为免覆盖已拒绝本次保存）；修好该文件后会按文件内容重载';
  reply.handle = async (url, opts) => {
    if (url === '/api/plugins/multi/instances' && opts?.method === 'POST') throw new ApiError(error, true);
    throw new Error(`unexpected ${url}`);
  };
  const onRefresh = renderPage({ reusable: true });
  createInstance();
  expect(await screen.findByText(error)).toBeTruthy();
  expect(screen.queryByPlaceholderText(SUFFIX_INPUT), '实例已登记，表单留着再点「创建」只会得到「已存在」').toBeNull();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('建实例回其它错误码（不带 applied）：显示原因，表单留着，并刷新插件列表', async () => {
  const error = '实例 multi:x 未登记（停机中或被拒，见日志），配置未写入';
  reply.handle = async (url, opts) => {
    if (url === '/api/plugins/multi/instances' && opts?.method === 'POST') throw new ApiError(error, false);
    throw new Error(`unexpected ${url}`);
  };
  const onRefresh = renderPage({ reusable: true });
  createInstance();
  expect(await screen.findByText(error)).toBeTruthy();
  expect((screen.getByPlaceholderText(SUFFIX_INPUT) as HTMLInputElement).value).toBe('x');
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

it('改配置出错（已在运行态生效、写入失败，回执带 applied）：显示原因，刷新插件列表', async () => {
  const error =
    '已在运行态生效，但写入配置文件失败（EACCES: permission denied）；改动保留在文档里，下次保存成功时一并写入';
  reply.handle = async (url, opts) => {
    if (url === '/api/plugins/multi/config' && opts?.method === 'PUT') throw new ApiError(error, true);
    throw new Error(`unexpected ${url}`);
  };
  const onRefresh = renderPage({ config: { v: 1 } });
  fireEvent.click(screen.getByText('multi'));
  fireEvent.click(screen.getByText('编辑配置'));
  fireEvent.click(screen.getByText('保存'));
  expect(await screen.findByText(error)).toBeTruthy();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('删实例出错（已从配置文件删除、卸载失败的 500）：显示原因，刷新插件列表', async () => {
  const error = '已从配置文件删除实例 multi:x，但卸载失败（坏）；重启后不再登记';
  reply.handle = async (url, opts) => {
    if (url === '/api/plugins/multi%3Ax/instance' && opts?.method === 'DELETE') throw new ApiError(error, false);
    throw new Error(`unexpected ${url}`);
  };
  const onRefresh = renderPage({ instanceId: 'multi:x' });
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }));
  expect(await screen.findByText(error)).toBeTruthy();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});
