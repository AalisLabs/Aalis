// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '../../packages/plugin-webui-client/src/markdown/Markdown.js';

// ════════════════════════════════════════════════════════════
// Markdown：不渲染原始 HTML；图片只认媒体地址（/api/media 与存储地址），外站图片显示成链接、不发请求；链接只许 http、https、
// mailto；公式渲染不信任输入；代码块按语法色令牌高亮，剪贴板不可用时没有复制按钮；Mermaid 用严格安全级别
// ════════════════════════════════════════════════════════════

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async () => true),
  render: vi.fn(async () => ({ svg: '<svg data-testid="chart"><text>图</text></svg>' })),
}));
vi.mock('../../packages/plugin-webui-client/node_modules/mermaid', () => ({ default: mermaid }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const show = (text: string) => render(<Markdown text={text} />).container;

describe('Markdown', () => {
  it('外站图片不发请求、显示成链接；媒体地址与存储地址的图片照常显示', () => {
    const view = show(
      '![追踪](https://tracker.example/p.png)\n\n![本地](/api/media?uri=data%3A%2Fa.png)\n\n![存储](workspace:/b.png)',
    );
    const images = [...view.querySelectorAll('img')].map(img => img.getAttribute('src'));
    expect(images).toEqual(['/api/media?uri=data%3A%2Fa.png', '/api/media?uri=workspace%3A%2Fb.png']);
    const link = screen.getByRole('link', { name: '追踪' });
    expect(link.getAttribute('href')).toBe('https://tracker.example/p.png');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('链接只许 http、https 与 mailto，外链在新标签页打开', () => {
    show('[a](https://a.example) [b](mailto:x@a.example) [c](javascript:alert(1)) [d](file:///etc/passwd)');
    expect(screen.getByRole('link', { name: 'a' }).getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'b' }).getAttribute('href')).toBe('mailto:x@a.example');
    expect(screen.queryByRole('link', { name: 'c' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'd' })).toBeNull();
    expect(screen.getByText('c')).toBeTruthy();
  });

  it('原始 HTML 不渲染', () => {
    const view = show('<img src=x onerror="alert(1)"> <b>粗</b>');
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('b')).toBeNull();
    expect(view.textContent).toContain('<b>粗</b>');
  });

  it('公式照常渲染，不信任输入：\\href 不变成链接', () => {
    const view = show('$$\nE = mc^2\n$$\n\n$\\href{https://a.example}{x}$');
    expect(view.querySelector('.katex')).not.toBeNull();
    expect(view.querySelector('a[href="https://a.example"]')).toBeNull();
  });

  it('单个 ~ 不是删除线，~~删除~~ 照常', () => {
    let view = show('大约 ~5 分钟，~ 约等于');
    expect(view.querySelector('del')).toBeNull();
    expect(view.textContent).toBe('大约 ~5 分钟，~ 约等于');
    cleanup();
    view = show('~~删除~~');
    expect(view.querySelector('del')?.textContent).toBe('删除');
  });

  it('美元金额不变形；$x^2$、\\(x\\) 与单行的 $$x$$ 是行内公式，跨行的 $$ 块是块公式；行内代码里的 $x$ 原样', () => {
    for (const text of ['$5 和 $10', '价格 $5,$10']) {
      const view = show(text);
      expect(view.querySelector('.katex'), text).toBeNull();
      expect(view.textContent).toBe(text);
      cleanup();
    }
    let view = show('设 $x^2$ 与 \\(y\\) 与 $$z$$');
    expect(view.querySelectorAll('.katex')).toHaveLength(3);
    expect(view.querySelector('.katex-display')).toBeNull();
    cleanup();
    view = show('$$\nE = mc^2\n$$');
    expect(view.querySelector('.katex-display')).not.toBeNull();
    cleanup();
    view = show('写成 `$x$`');
    expect(view.querySelector('.katex')).toBeNull();
    expect(view.querySelector('code')?.textContent).toBe('$x$');
  });

  it('代码块按语法色高亮；剪贴板不可用时没有复制按钮，可用时有', async () => {
    const code = '```js\nconst a = 1;\n```';
    let view = show(code);
    expect(view.querySelector('.hljs-keyword')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '复制代码' })).toBeNull();
    cleanup();

    const writeText = vi.fn(async () => {});
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    view = show(code);
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
    expect(writeText).toHaveBeenCalledWith('const a = 1;\n');
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy();
  });

  it('Mermaid 用严格安全级别，颜色取自主题令牌，渲染出的图挂进页面；渲染失败时显示原文与原因', async () => {
    show('```mermaid\ngraph TD; A-->B\n```');
    expect(await screen.findByTestId('chart')).toBeTruthy();
    const [config] = mermaid.initialize.mock.calls.at(-1) as [Record<string, unknown>];
    expect(config).toMatchObject({ securityLevel: 'strict', theme: 'base' });
    expect(config.themeVariables).toBeTypeOf('object');
    cleanup();

    mermaid.parse.mockRejectedValueOnce(new Error('语法不对'));
    show('```mermaid\ngraph ???\n```');
    expect(await screen.findByText(/语法不对/)).toBeTruthy();
    expect(screen.getByText('graph ???')).toBeTruthy();
  });

  it('正在输出时 Mermaid 只显示源码、不解析：半截的图不闪错误；输出完才画', async () => {
    mermaid.parse.mockClear();
    mermaid.parse.mockRejectedValue(new Error('半截的图'));
    const { rerender } = render(<Markdown text={'```mermaid\ngraph TD; A-->'} streaming />);
    rerender(<Markdown text={'```mermaid\ngraph TD; A-->B\n```'} streaming />);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mermaid.parse).not.toHaveBeenCalled();
    expect(screen.queryByText(/图没能画出来/)).toBeNull();
    expect(screen.getByText('graph TD; A-->B')).toBeTruthy();

    mermaid.parse.mockResolvedValue(true);
    rerender(<Markdown text={'```mermaid\ngraph TD; A-->B\n```'} />);
    expect(await screen.findByTestId('chart')).toBeTruthy();
  });
});
