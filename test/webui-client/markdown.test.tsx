// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { setLanguage } from '../../packages/plugin-webui-client/src/language.js';
import { Markdown } from '../../packages/plugin-webui-client/src/markdown/Markdown.js';

// ════════════════════════════════════════════════════════════
// Markdown：不渲染原始 HTML；图片只认媒体地址（/api/media 与存储地址），外站图片显示成链接、不发请求；链接只许 http、https、
// mailto；公式渲染不信任输入；代码块按语法色令牌高亮，剪贴板不可用时没有复制按钮；Mermaid 用严格安全级别；plain 只认段落与列表
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

const show = (text: string, plain?: boolean) => render(<Markdown text={text} plain={plain} />).container;

describe('Markdown', () => {
  it('外站图片不发请求、显示成链接；媒体地址与存储地址的图片照常显示；file: 地址不是存储地址，只写替代文字', () => {
    const view = show(
      '![追踪](https://tracker.example/p.png)\n\n![本地](/api/media?uri=data%3A%2Fa.png)\n\n![存储](workspace:/b.png)' +
        '\n\n![本机](file:///zz-placeholder/c.png)',
    );
    const images = [...view.querySelectorAll('img')].map(img => img.getAttribute('src'));
    expect(images).toEqual(['/api/media?uri=data%3A%2Fa.png', '/api/media?uri=workspace%3A%2Fb.png']);
    expect(screen.getByText('本机').tagName).toBe('SPAN');
    const link = screen.getByRole('link', { name: '追踪' });
    expect(link.getAttribute('href')).toBe('https://tracker.example/p.png');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('图片取不到时显示替代：图标加「图片取不到」，读屏名字是替代文字，不留破图', () => {
    const view = show('![周报截图](workspace:/b.png)');
    fireEvent.error(view.querySelector('img') as HTMLImageElement);
    expect(view.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: '周报截图（取不到）' }).textContent).toBe('图片取不到');
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

  it('代码块上方一条细的标题行写语言名，复制按钮也在这一行，不压住代码；没写语言、剪贴板也不可用时没有标题行', async () => {
    let view = show('```sh\nnpm test\n```\n\n```\n纯文本\n```');
    let heads = [...view.querySelectorAll('.markdown-code-head')];
    expect(heads.map(head => head.textContent)).toEqual(['sh']);
    expect(heads[0].nextElementSibling?.tagName).toBe('PRE');
    cleanup();

    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    view = show('```sh\nnpm test\n```\n\n```\n纯文本\n```');
    heads = [...view.querySelectorAll('.markdown-code-head')];
    expect(heads.map(head => [head.textContent, head.querySelectorAll('button').length])).toEqual([
      ['sh', 1],
      ['', 1],
    ]);
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

  it('英文界面：Mermaid 渲染失败的说明按英文写，原因照原样', async () => {
    setLanguage({ chain: ['en'], timeZone: 'UTC', packs: new Map() });
    onTestFinished(() => setLanguage({ chain: [], timeZone: 'UTC', packs: new Map() }));
    mermaid.parse.mockRejectedValueOnce(new Error('bad syntax'));
    show('```mermaid\ngraph ???\n```');
    expect(await screen.findByText('The diagram couldn’t be drawn: bad syntax')).toBeTruthy();
  });

  it('plain 只认段落与列表（含嵌套列表、空行分段与裸换行），其余写法按原文显示', () => {
    let view = show('第一段\n第二行\n\n第二段\n\n- 一\n  - 甲\n\n1. 一', true);
    expect([...view.querySelectorAll('.markdown > *')].map(node => node.tagName)).toEqual(['P', 'P', 'UL', 'OL']);
    expect(view.querySelector('p')?.innerHTML).toBe('第一段<br>\n第二行');
    expect(view.querySelector('ul > li > ul > li')?.textContent).toBe('甲');
    cleanup();
    for (const text of [
      '[链接](https://a.example) ![图](https://a.example/p.png)',
      '[a]: https://a.example',
      '<https://a.example> https://a.example',
      '**强调** _斜体_ ~~删除~~ `代码`',
      '\\*转义\\* &amp; $$x$$',
      '$x$ \\(y\\)',
      '行尾\\\n下一行',
      '<b>粗</b>',
      '<div>块</div>',
      '# 标题',
      '标题\n===',
      '| a | b |\n| - | - |',
      '> 引用',
      '```\n代码块\n```',
      '---',
    ]) {
      view = show(text, true);
      expect(view.querySelector('.markdown :not(p):not(br)'), text).toBeNull();
      expect(view.textContent, text).toBe(text);
      cleanup();
    }
    view = show('    缩进的一行', true);
    expect(view.querySelector('pre, code')).toBeNull();
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
