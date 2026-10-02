// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { paths, routes, useSessionAddress } from '../../packages/plugin-webui-client/src/routes.js';

// 地址表：当前会话与右侧面板的标签由地址决定，会话 id 里的冒号等字符编码进路径，读出时还原

afterEach(cleanup);

function Probe() {
  const address = useSessionAddress();
  return <output>{address ? `${address.sessionId}|${address.tab ?? ''}` : 'none'}</output>;
}

function at(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={routes.session} element={<Probe />} />
        <Route path={routes.sessionTab} element={<Probe />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByRole('status').textContent;
}

describe('地址表', () => {
  it('生成会话、面板标签、房间表与新会话的地址', () => {
    expect(paths.home).toBe('/');
    expect(paths.newSession).toBe('/new');
    expect(paths.session('webui:console:abc')).toBe('/s/webui%3Aconsole%3Aabc');
    expect(paths.session('onebot:10000:group:20001::sub/1', 'usage')).toBe(
      '/s/onebot%3A10000%3Agroup%3A20001%3A%3Asub%2F1/usage',
    );
    expect(paths.rooms({ instance: '@x/plugin-adapter:a' })).toBe('/rooms?instance=%40x%2Fplugin-adapter%3Aa');
    expect(paths.rooms({ platform: 'onebot' })).toBe('/rooms?platform=onebot');
  });

  it('当前会话从地址读出，生成的地址读回原样', () => {
    const id = 'onebot:10000:group:20001::sub/1';
    expect(at(paths.session(id))).toBe(`${id}|`);
    cleanup();
    expect(at(paths.session(id, 'settings'))).toBe(`${id}|settings`);
  });

  it('不认识的标签当作没有，不在会话地址上时没有当前会话', () => {
    expect(at('/s/abc/unknown')).toBe('abc|');
    cleanup();
    expect(at('/rooms?platform=onebot')).toBe('none');
  });
});
