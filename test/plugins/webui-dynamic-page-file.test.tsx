// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebuiPageDef } from '../../packages/plugin-webui-client/src/types.js';

// ════════════════════════════════════════════════════════════
// 声明式表格的文件单元格（render: 'file'）：点击时以整行为参数调列的 method，
// 拿回 { name, mime, base64 }。只有位图白名单里的类型能在 WebUI 源里预览；
// 下载一律按 application/octet-stream 生成 Blob，不论服务端回的 mime 是什么——
// HTML 与 SVG 从不在 WebUI 源里渲染。
// ════════════════════════════════════════════════════════════

const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
/** method → 返回值（或抛出的错误） */
let replies: Record<string, unknown> = {};

vi.mock('../../packages/plugin-webui-client/src/api', () => ({
  pageAction: vi.fn(async (_plugin: string, method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    const r = replies[method];
    if (r instanceof Error) throw r;
    return r;
  }),
  api: vi.fn(async () => ({})),
  errText: (err: unknown, fallback = '请求失败') => (err instanceof Error && err.message ? err.message : fallback),
  proxiedMediaUrl: (s: string) => s,
}));

import { DynamicPage } from '../../packages/plugin-webui-client/src/components/DynamicPage.js';

const row = { taskId: '<任务 id>', artifactId: '<产物 id>', file: '<产物 id>.bin' };

const filePage: WebuiPageDef = {
  key: 'paper',
  label: '白纸',
  plugin: 'plugin-paper',
  content: [
    {
      type: 'table',
      source: 'listArtifacts',
      columns: [
        { key: 'artifactId', label: '产物 id' },
        { key: 'file', label: '文件', render: 'file', method: 'readArtifact' },
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

const createdBlobs: Blob[] = [];
const revokedUrls: string[] = [];
const clickedAnchors: Array<{ href: string; download: string }> = [];

beforeEach(() => {
  calls.length = 0;
  replies = {};
  createdBlobs.length = 0;
  revokedUrls.length = 0;
  clickedAnchors.length = 0;
  let n = 0;
  // jsdom 没有实现对象 URL：用替身记下每次生成的 Blob 与回收的地址
  URL.createObjectURL = vi.fn((blob: Blob) => {
    createdBlobs.push(blob);
    n += 1;
    return `blob:test/${n}`;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchors.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithRow(): Promise<HTMLElement> {
  replies.listArtifacts = [row];
  const { container } = render(<DynamicPage page={filePage} />);
  await screen.findByText('查看');
  return container;
}

describe('DynamicPage 文件单元格：查看', () => {
  it('位图（image/png）：以整行为参数调 method，出现 <img>，src 是 blob 地址；关闭后回收地址', async () => {
    replies.readArtifact = { name: 'out.png', mime: 'image/png', base64: b64(PNG_BYTES) };
    const container = await renderWithRow();
    expect(screen.getByText(row.file), '单元格显示文件名').toBeTruthy();

    fireEvent.click(screen.getByText('查看'));
    const img = await waitFor(() => {
      const el = container.querySelector('img');
      expect(el).toBeTruthy();
      return el as HTMLImageElement;
    });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(calls.find(c => c.method === 'readArtifact')?.args, '整行作为参数').toEqual(row);
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0].type).toBe('image/png');
    expect(createdBlobs[0].size).toBe(PNG_BYTES.length);

    fireEvent.click(screen.getByTitle('关闭'));
    await waitFor(() => expect(container.querySelector('img')).toBeNull());
    expect(revokedUrls).toContain(img.getAttribute('src'));
  });

  it.each(['text/html', 'image/svg+xml'])('安全：%s 不在 WebUI 源里渲染，只提示下载', async mime => {
    replies.readArtifact = { name: 'out.html', mime, base64: b64(HTML_BYTES) };
    const container = await renderWithRow();

    fireEvent.click(screen.getByText('查看'));
    // 等到提示或图片之一出现（两条路都会在取回文件后落定），再断言没有可渲染元素
    await waitFor(() => expect(screen.queryByText('此类型只能下载') ?? container.querySelector('img')).toBeTruthy());
    expect(container.querySelector('img, iframe, object, embed'), '非位图不得出现可渲染元素').toBeNull();
    expect(screen.getByText('此类型只能下载')).toBeTruthy();
    expect(
      createdBlobs.filter(b => b.type !== 'application/octet-stream'),
      '不得生成带服务端 mime 的 Blob',
    ).toEqual([]);
  });

  it('method 返回 {ok:false,error}：显示原因，不显示图片', async () => {
    replies.readArtifact = { ok: false, error: '文件超过 25 MiB 上限' };
    const container = await renderWithRow();

    fireEvent.click(screen.getByText('查看'));
    await waitFor(() => expect(screen.getByText('文件超过 25 MiB 上限')).toBeTruthy());
    expect(container.querySelector('img')).toBeNull();
    expect(createdBlobs).toEqual([]);
  });
});

describe('DynamicPage 文件单元格：下载', () => {
  it.each([
    ['text/html', HTML_BYTES],
    ['image/svg+xml', HTML_BYTES],
    ['image/png', PNG_BYTES],
  ])('安全：服务端回 %s 时 Blob 类型恒为 application/octet-stream', async (mime, bytes) => {
    replies.readArtifact = { name: 'out.bin', mime, base64: b64(bytes) };
    await renderWithRow();

    fireEvent.click(screen.getByText('下载'));
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0].type).toBe('application/octet-stream');
    expect(createdBlobs[0].size).toBe(bytes.length);
    expect(clickedAnchors[0].href).toBe('blob:test/1');
    await waitFor(() => expect(revokedUrls, '下载后回收地址').toContain('blob:test/1'));
  });

  it('保存的文件名去掉路径分隔符', async () => {
    replies.readArtifact = { name: '../a\\b/c.html', mime: 'text/html', base64: b64(HTML_BYTES) };
    await renderWithRow();

    fireEvent.click(screen.getByText('下载'));
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(clickedAnchors[0].download).toBe('..abc.html');
  });
});
