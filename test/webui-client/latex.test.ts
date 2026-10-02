import { describe, expect, it } from 'vitest';
import { preprocessLaTeX } from '../../packages/plugin-webui-client/src/markdown/latex.js';

// ════════════════════════════════════════════════════════════
// 公式写法的预处理：\( \) 与 \[ \] 换成 $ 定界、公式里的 | 换成 \vert；跨行的 $$ 块开闭各占一行；
// 流式输出时还没闭合的跨行 $$ 块先补上闭合；代码块与行内代码原样保留
// ════════════════════════════════════════════════════════════

describe('preprocessLaTeX', () => {
  it('\\( \\) 换成 $，\\[ \\] 换成 $$，公式里的 | 换成 \\vert', () => {
    expect(preprocessLaTeX('行内 \\(|x|\\) 与块 \\[a|b\\]')).toBe('行内 $\\vert x\\vert $ 与块 $$a\\vert b$$');
  });

  it('跨行的 $$ 块开闭各占一行、前后空行隔开；单行的 $$ 原样', () => {
    expect(preprocessLaTeX('前 $$A = \\begin{bmatrix}\n1\n\\end{bmatrix}$$ 后')).toBe(
      '前 \n\n$$\nA = \\begin{bmatrix}\n1\n\\end{bmatrix}\n$$\n\n 后',
    );
    expect(preprocessLaTeX('单行 $$x^2$$ 原样')).toBe('单行 $$x^2$$ 原样');
  });

  it('流式输出时末尾还没闭合的跨行 $$ 块补上闭合；单行的不动', () => {
    expect(preprocessLaTeX('推导：$$\\begin{aligned}\na &= b\n')).toBe(
      '推导：\n\n$$\n\\begin{aligned}\na &= b\n$$\n\n',
    );
    expect(preprocessLaTeX('价格 $$5')).toBe('价格 $$5');
  });

  it('代码块与行内代码原样保留', () => {
    const text = '```\n\\(x\\)\n```\n和 `\\[y\\]`';
    expect(preprocessLaTeX(text)).toBe(text);
  });
});
