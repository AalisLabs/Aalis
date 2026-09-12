// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceInfo } from '../../packages/plugin-webui-client/src/types.js';

// ════════════════════════════════════════════════════════════
// 服务偏好切换的失败可见性：setPrefer / clearPrefer 只有 try/finally 没有
// catch —— 请求失败时 busy 解了、下拉框却已显示成新值（受控值来自旧 info，
// 下一次 onPreferChanged 才会纠正），用户看不出切换没生效，rejection 也只
// 落成 unhandled。补 catch 出声，与页面其它请求同款。
// ════════════════════════════════════════════════════════════

let apiFail: Error | null = null;
const apiCalls: Array<{ path: string; method?: string }> = [];

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  api: vi.fn(async (path: string, init?: { method?: string }) => {
    apiCalls.push({ path, method: init?.method });
    if (apiFail) throw apiFail;
    return {};
  }),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
}));

import { ServiceCard } from '../../packages/plugin-webui-client/src/components/ServiceCard.js';

/** 两个提供者 + 已有偏好：下拉切换与「恢复默认」按钮都在 */
const multi: ServiceInfo = {
  providers: [
    { contextId: 'plugin-llm-openai', priority: 10 },
    { contextId: 'plugin-llm-ollama', priority: 5 },
  ],
  preferred: 'plugin-llm-openai',
};

beforeEach(() => {
  apiCalls.length = 0;
  apiFail = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('服务偏好切换失败', () => {
  it('setPrefer 抛错时出声告知，不静默', async () => {
    apiFail = new Error('上下文 plugin-llm-ollama 未提供 llm');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<ServiceCard name="llm" info={multi} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plugin-llm-ollama' } });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('上下文 plugin-llm-ollama 未提供 llm'));
  });

  it('clearPrefer 抛错时出声告知，不静默', async () => {
    apiFail = new Error('服务 llm 不存在');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<ServiceCard name="llm" info={multi} />);
    fireEvent.click(screen.getByText('恢复默认'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('服务 llm 不存在'));
  });

  it('切换成功不弹提示，且回调通知上层刷新', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onPreferChanged = vi.fn();
    render(<ServiceCard name="llm" info={multi} onPreferChanged={onPreferChanged} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plugin-llm-ollama' } });
    await waitFor(() => expect(onPreferChanged).toHaveBeenCalled());
    expect(alertSpy).not.toHaveBeenCalled();
    expect(apiCalls).toEqual([{ path: '/api/services/llm/prefer', method: 'POST' }]);
  });
});
