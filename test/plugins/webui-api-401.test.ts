// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, pageAction, redirectToLoginOn401 } from '../../packages/plugin-webui-client/src/api.js';

// ════════════════════════════════════════════════════════════
// WebUI 会话失效(401) 收口：旧行为是 api() 把 {error:'unauthenticated'} 当数据
// 返回 → 组件吃到错误形状后白屏。新行为：401 统一跳回 '/' 触发服务端登录页，
// 并抛错中止当前处理，使会话过期时出现登录框而非黑屏。
// ════════════════════════════════════════════════════════════

describe('webui api() 会话失效(401) → 跳登录页而非白屏', () => {
  let replaceMock: ReturnType<typeof vi.fn>;
  const origLocation = window.location;

  beforeEach(() => {
    replaceMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { replace: replaceMock, href: 'http://localhost/' },
      writable: true,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { value: origLocation, writable: true, configurable: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redirectToLoginOn401：401 跳转并返回 true；其它状态返回 false 不跳', () => {
    expect(redirectToLoginOn401(401)).toBe(true);
    expect(replaceMock).toHaveBeenCalledWith('/');
    replaceMock.mockClear();
    expect(redirectToLoginOn401(200)).toBe(false);
    expect(redirectToLoginOn401(500)).toBe(false);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('api() 撞 401：跳 / 并抛错（不把 {error} 当数据返回）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 })),
    );
    await expect(api('/api/auth/status')).rejects.toThrow(/会话已失效/);
    expect(replaceMock).toHaveBeenCalledWith('/');
  });

  it('api() 正常 200：不跳转，返回 body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, n: 1 }), { status: 200 })),
    );
    await expect(api('/api/x')).resolves.toEqual({ ok: true, n: 1 });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('pageAction() 撞 401：跳 / 并抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 })),
    );
    await expect(pageAction('plugin', 'method')).rejects.toThrow(/会话已失效/);
    expect(replaceMock).toHaveBeenCalledWith('/');
  });
});
