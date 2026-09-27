// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebuiPageDef } from '../../packages/plugin-webui-client/src/types.js';

// ════════════════════════════════════════════════════════════
// 声明式表格的行内图片列（render: 'image'）：单元格挂载时以整行为参数调列的 method，
// 拿回 { name, mime, base64 }。只有位图白名单里的类型在行内显示（点击放大），其余显示
// 「不可预览」且不生成任何 Blob——HTML 与 SVG 从不在 WebUI 源里渲染。表格刷新时值不变不重取；
// 对象 URL 在值变化与卸载时回收。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
/** method → 返回值（或抛出的错误；函数则以参数调用，可返回 Promise 以控制何时落定） */
let replies: Record<string, unknown> = {};

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async (_plugin: string, method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    const r = replies[method];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? await r(args) : r;
  }),
  api: vi.fn(async () => ({})),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
  proxiedMediaUrl: (s: string) => s,
}));

import { DynamicPage } from '../../packages/plugin-webui-client/src/components/DynamicPage.js';

const imagePage: WebuiPageDef = {
  key: 'review',
  label: '审核',
  plugin: 'plugin-review',
  content: [
    {
      type: 'table',
      source: 'listItems',
      columns: [
        { key: 'shot', label: '渲染图', render: 'image', method: 'readShot' },
        { key: 'step', label: '步骤' },
      ],
    },
  ],
};

/** 字节 → base64（jsdom 有 btoa） */
function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HTML_BYTES = Array.from('<script>alert(1)</script>', c => c.charCodeAt(0));
const png = { name: 'render.png', mime: 'image/png', base64: b64(PNG_BYTES) };

const rowA = { id: '<作品编号 A>', shot: '<作品编号 A>/render.png', step: '审核中' };
const rowB = { id: '<作品编号 B>', shot: '<作品编号 B>/render.png', step: '审核中' };

const createdBlobs: Blob[] = [];
const createdUrls: string[] = [];
const revokedUrls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  replies = {};
  createdBlobs.length = 0;
  createdUrls.length = 0;
  revokedUrls.length = 0;
  let n = 0;
  // jsdom 没有实现对象 URL：用替身记下每次生成的 Blob、地址与回收的地址
  URL.createObjectURL = vi.fn((blob: Blob) => {
    createdBlobs.push(blob);
    n += 1;
    const url = `blob:test/${n}`;
    createdUrls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const shotCalls = () => calls.filter(c => c.method === 'readShot');
const listCalls = () => calls.filter(c => c.method === 'listItems');

/** 等到行内缩略图出现（它在表格里，不在放大弹窗里） */
async function thumbnail(container: HTMLElement): Promise<HTMLImageElement> {
  return waitFor(() => {
    const el = container.querySelector('td img');
    expect(el).toBeTruthy();
    return el as HTMLImageElement;
  });
}

/** 触发页面刷新（与 WS 推送同一入口），表格重拉 source */
function refreshPage(): void {
  window.dispatchEvent(new CustomEvent('aalis:page-refresh', { detail: {} }));
}

describe('DynamicPage 行内图片列：显示', () => {
  it('位图（image/png）：挂载即以整行为参数调 method，行内出现 <img>（替代文字是值、最大宽 240）', async () => {
    replies.listItems = [rowA];
    replies.readShot = png;
    const { container } = render(<DynamicPage page={imagePage} />);

    const img = await thumbnail(container);
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(img.getAttribute('alt'), '值作为替代文字').toBe(rowA.shot);
    expect(img.style.maxWidth).toBe('240px');
    expect(
      shotCalls().map(c => c.args),
      '不用点击，挂载即取；整行作为参数',
    ).toEqual([rowA]);
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0].type).toBe('image/png');
    expect(createdBlobs[0].size).toBe(PNG_BYTES.length);
  });

  it('点击缩略图放大（现有弹窗）；关闭弹窗不回收缩略图还在用的地址、也不重取', async () => {
    replies.listItems = [rowA];
    replies.readShot = png;
    const { container } = render(<DynamicPage page={imagePage} />);
    const img = await thumbnail(container);
    const src = img.getAttribute('src');

    expect(container.querySelector('.dyn-detail-modal'), '点击前没有弹窗').toBeNull();
    fireEvent.click(img);
    const big = await waitFor(() => {
      const el = container.querySelector('.dyn-detail-modal img');
      expect(el).toBeTruthy();
      return el as HTMLImageElement;
    });
    expect(big.getAttribute('src')).toBe(src);

    fireEvent.click(screen.getByTitle('关闭'));
    await waitFor(() => expect(container.querySelector('.dyn-detail-modal')).toBeNull());
    expect(container.querySelector('td img')?.getAttribute('src'), '缩略图还在').toBe(src);
    expect(revokedUrls).not.toContain(src);
    expect(shotCalls()).toHaveLength(1);
  });

  it.each(['text/html', 'image/svg+xml'])('安全：%s 不出现可渲染元素，显示「不可预览」，不生成 Blob', async mime => {
    replies.listItems = [rowA];
    replies.readShot = { name: 'render.png', mime, base64: b64(HTML_BYTES) };
    const { container } = render(<DynamicPage page={imagePage} />);

    // 等取图落定（提示或图片之一出现），再断言没有可渲染元素
    await waitFor(() => expect(screen.queryByText('不可预览') ?? container.querySelector('td img')).toBeTruthy());
    expect(container.querySelector('img, iframe, object, embed'), '非位图不得出现可渲染元素').toBeNull();
    expect(screen.getByText('不可预览')).toBeTruthy();
    expect(createdBlobs, '不可预览时不生成任何 Blob').toEqual([]);
  });

  it('method 返回 {ok:false,error}：显示原因，不显示图片', async () => {
    replies.listItems = [rowA];
    replies.readShot = { ok: false, error: '渲染图不存在' };
    const { container } = render(<DynamicPage page={imagePage} />);

    await waitFor(() => expect(screen.getByText('渲染图不存在')).toBeTruthy());
    expect(container.querySelector('img')).toBeNull();
    expect(createdBlobs).toEqual([]);
  });
});

describe('DynamicPage 行内图片列：刷新与释放', () => {
  it('刷新时值不变不重取：行的其它字段变了，图沿用、地址不回收', async () => {
    replies.listItems = [rowA];
    replies.readShot = png;
    const { container } = render(<DynamicPage page={imagePage} />);
    const src = (await thumbnail(container)).getAttribute('src');

    replies.listItems = [{ ...rowA, step: '待裁决' }];
    refreshPage();
    // 新行已渲染进表格（其它字段变了），才能说明「值不变」这一次确实经过了重渲染
    await screen.findByText('待裁决');
    expect(listCalls()).toHaveLength(2);
    expect(shotCalls(), '值不变不重取').toHaveLength(1);
    expect(container.querySelector('td img')?.getAttribute('src')).toBe(src);
    expect(revokedUrls).toEqual([]);
  });

  it('刷新后同一格的值变了：以新行重取，回收旧地址；新图取回之前不拿旧图配新值', async () => {
    replies.listItems = [rowA];
    let settleB!: (v: unknown) => void;
    replies.readShot = (args: Record<string, unknown>) =>
      args.id === rowB.id
        ? new Promise(resolve => {
            settleB = resolve;
          })
        : png;
    const { container } = render(<DynamicPage page={imagePage} />);
    const oldSrc = (await thumbnail(container)).getAttribute('src');

    // 记下表格里出现过的每一种「替代文字 + 地址」组合：React 先提交新属性、后跑 effect，
    // 中间那一帧若把旧图配上新值的替代文字，这里能看到
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      for (const img of container.querySelectorAll('td img'))
        seen.add(`${img.getAttribute('alt')} ${img.getAttribute('src')}`);
    });
    observer.observe(container, { subtree: true, childList: true, attributes: true });

    replies.listItems = [rowB];
    refreshPage();
    await waitFor(() => expect(shotCalls()).toHaveLength(2));
    expect(shotCalls()[1].args, '以新行为参数重取').toEqual(rowB);
    expect(container.querySelector('td img'), '新图取回之前不显示旧图').toBeNull();
    expect(revokedUrls).toEqual([oldSrc]);

    settleB(png);
    await waitFor(() => expect(container.querySelector('td img')?.getAttribute('alt')).toBe(rowB.shot));
    observer.disconnect();
    const newSrc = container.querySelector('td img')?.getAttribute('src');
    expect(newSrc).not.toBe(oldSrc);
    expect([...seen], '新值的替代文字从未配过旧图').not.toContain(`${rowB.shot} ${oldSrc}`);
    expect(revokedUrls).toEqual([oldSrc]);
  });

  it('卸载时回收对象 URL', async () => {
    replies.listItems = [rowA];
    replies.readShot = png;
    const { container, unmount } = render(<DynamicPage page={imagePage} />);
    const src = (await thumbnail(container)).getAttribute('src');
    expect(revokedUrls).toEqual([]);

    unmount();
    expect(revokedUrls).toEqual([src]);
  });

  it('取图途中卸载：落定后不留下未回收的对象 URL', async () => {
    replies.listItems = [rowA];
    let settle!: (v: unknown) => void;
    replies.readShot = () =>
      new Promise(resolve => {
        settle = resolve;
      });
    const { unmount } = render(<DynamicPage page={imagePage} />);
    await waitFor(() => expect(shotCalls()).toHaveLength(1));

    unmount();
    settle(png);
    await new Promise(r => setTimeout(r, 0));
    expect(
      createdUrls.filter(u => !revokedUrls.includes(u)),
      '卸载后生成的地址也要回收（或干脆不生成）',
    ).toEqual([]);
  });
});
