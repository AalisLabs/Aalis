// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebuiPageDef } from '../../packages/plugin-webui-client/src/types.js';

// ════════════════════════════════════════════════════════════
// 声明式表格的时间列（render: 'time'）与链接列（render: 'link'）：
// 时间值是毫秒时间戳或 ISO 字符串，显示为本地日期时间（今年的省去年份），解析不了的原样显示；
// 链接只把 http(s) 网址做成新标签页打开的链接（带 noopener noreferrer），javascript: 等一律按文本。
// ════════════════════════════════════════════════════════════

let rows: Array<Record<string, unknown>> = [];

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async () => rows),
  api: vi.fn(async () => ({})),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
  proxiedMediaUrl: (s: string) => s,
}));

import { DynamicPage } from '../../packages/plugin-webui-client/src/components/DynamicPage.js';

const page: WebuiPageDef = {
  key: 'works',
  label: '作品站',
  plugin: 'plugin-works-site',
  content: [
    {
      type: 'table',
      source: 'listWorks',
      columns: [
        { key: 'title', label: '标题' },
        { key: 'at', label: '上线时刻', render: 'time' },
        { key: 'url', label: '网址', render: 'link' },
      ],
    },
  ],
};

afterEach(cleanup);

describe('表格的时间列与链接列', () => {
  it('毫秒时间戳与 ISO 字符串都显示为本地日期时间，悬停给完整时间；今年的不写年份', async () => {
    const thisYear = new Date(new Date().getFullYear(), 2, 5, 9, 7).getTime();
    rows = [
      { title: '甲', at: thisYear, url: '' },
      { title: '乙', at: '2001-02-03T04:05:00.000Z', url: '' },
    ];
    render(<DynamicPage page={page} />);
    await waitFor(() => expect(screen.getByText('甲')).toBeTruthy());
    const times = document.querySelectorAll('time');
    expect(times).toHaveLength(2);
    expect(times[0].dateTime).toBe(new Date(thisYear).toISOString());
    expect(times[0].textContent).not.toContain(String(new Date().getFullYear()));
    expect(times[0].textContent).toMatch(/3.*5.*09:07/);
    expect(times[1].dateTime).toBe('2001-02-03T04:05:00.000Z');
    expect(times[1].textContent).toContain('2001');
    expect(times[1].title).toContain('2001');
  });

  it('解析不了的时间原样显示，空值不显示', async () => {
    rows = [
      { title: '甲', at: '未知', url: '' },
      { title: '乙', at: '', url: '' },
    ];
    render(<DynamicPage page={page} />);
    await waitFor(() => expect(screen.getByText('未知')).toBeTruthy());
    expect(document.querySelectorAll('time')).toHaveLength(0);
  });

  it('安全：只有 http(s) 网址做成链接，新标签页打开且不带 opener 与 referrer；其他协议按文本', async () => {
    rows = [
      { title: '甲', at: '', url: 'https://works.example/w/abcdefghij/' },
      { title: '乙', at: '', url: 'javascript:alert(1)' },
    ];
    render(<DynamicPage page={page} />);
    await waitFor(() => expect(screen.getByText('甲')).toBeTruthy());
    const links = document.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://works.example/w/abcdefghij/');
    expect(links[0].target).toBe('_blank');
    expect(links[0].rel).toBe('noopener noreferrer');
    expect(screen.getByText('javascript:alert(1)').closest('a')).toBeNull();
  });
});
