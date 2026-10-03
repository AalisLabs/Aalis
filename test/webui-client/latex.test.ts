import { describe, expect, it } from 'vitest';
import { preprocessLaTeX } from '../../packages/plugin-webui-client/src/markdown/latex.js';

// ════════════════════════════════════════════════════════════
// 公式写法的预处理：行内公式一律写成行内的 $$（\( \) 与按成文规则认出的单美元），\[ \] 换成 $$，前两种公式里的 | 换成
// \vert；认不出的单美元原样留着；跨行的 $$ 块开闭各占一行，块里的内容不动；流式输出时还没闭合的跨行 $$ 块先补上闭合；
// 代码与链接地址原样保留
// ════════════════════════════════════════════════════════════

describe('preprocessLaTeX', () => {
  it('\\( \\) 换成行内的 $$，\\[ \\] 换成 $$，公式里的 | 换成 \\vert', () => {
    expect(preprocessLaTeX('行内 \\(|x|\\) 与块 \\[a|b\\]')).toBe('行内 $$\\vert x\\vert $$ 与块 $$a\\vert b$$');
  });

  it('单美元：开头的 $ 右边紧跟非空白、结尾的 $ 左边紧跟非空白且右边不紧跟数字或 $、同一行、中间没有未转义的 $，才是公式', () => {
    expect(preprocessLaTeX('设 $x^2$ 与 $a$。')).toBe('设 $$x^2$$ 与 $$a$$。');
    expect(preprocessLaTeX('转义的 $a \\$ b$ 照样是一个')).toBe('转义的 $$a \\$ b$$ 照样是一个');
    for (const text of [
      '$5 和 $10',
      '价格 $5,$10',
      '$ x$ 与 $x $',
      '$x$5',
      '跨行 $a\nb$',
      '转义 \\$x$',
      '一个 $ 符号',
      // 不成对的 $$ 与紧跟 $ 的结尾不当单美元的定界符
      '只有 $$b$ 一处',
      '$a$$b$',
    ]) {
      expect(preprocessLaTeX(text), text).toBe(text);
    }
    // 认不出的开头不吞掉后面真的公式
    expect(preprocessLaTeX('$5 和 $x$')).toBe('$5 和 $$x$$');
  });

  it('跨行的 $$ 块开闭各占一行、前后空行隔开，块里的单美元不动；单行的 $$ 原样', () => {
    expect(preprocessLaTeX('前 $$A = \\begin{bmatrix}\n1\n\\end{bmatrix}$$ 后')).toBe(
      '前 \n\n$$\nA = \\begin{bmatrix}\n1\n\\end{bmatrix}\n$$\n\n 后',
    );
    expect(preprocessLaTeX('$$\n\\text{当 $x>0$ 时}\n$$')).toBe('\n\n$$\n\\text{当 $x>0$ 时}\n$$\n\n');
    expect(preprocessLaTeX('单行 $$x^2$$ 原样')).toBe('单行 $$x^2$$ 原样');
  });

  it('流式输出时末尾还没闭合的跨行 $$ 块补上闭合；单行的不动', () => {
    expect(preprocessLaTeX('推导：$$\\begin{aligned}\na &= b\n')).toBe(
      '推导：\n\n$$\n\\begin{aligned}\na &= b\n$$\n\n',
    );
    expect(preprocessLaTeX('价格 $$5')).toBe('价格 $$5');
  });

  it('代码块与行内代码原样保留', () => {
    const text = '```\n\\(x\\) $y$\n```\n和 `\\[y\\]` 与 `$x$`';
    expect(preprocessLaTeX(text)).toBe(text);
  });

  it('代码围栏：``` 与 ~~~ 都算，可带缩进与引用的 >，闭合围栏要同种字符且不短于开头；流式输出时还没闭合的到文末都是代码', () => {
    for (const text of [
      '```bash\necho "$HOME/$USER"\n',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 测的就是代码里的模板串
      '```js\nconst url = `${host}:${port}`;\n',
      '~~~bash\necho "$HOME/$USER"\n~~~',
      '> ```sh\n> echo $HOME/$USER\n',
      '1. 装上\n   ```bash\n   echo $HOME/$USER\n   ```',
      '````md\n```\n$a$ 与 $b$\n',
    ]) {
      expect(preprocessLaTeX(text), text).toBe(text);
    }
    expect(preprocessLaTeX('前 $x$\n```bash\necho $HOME/$USER\n')).toBe('前 $$x$$\n```bash\necho $HOME/$USER\n');
    expect(preprocessLaTeX('~~~\n$a$\n```\n$b$\n~~~\n后 $c$')).toBe('~~~\n$a$\n```\n$b$\n~~~\n后 $$c$$');
    expect(preprocessLaTeX('> ```sh\n> echo $HOME/$USER\n> ```\n\n后 $c$')).toBe(
      '> ```sh\n> echo $HOME/$USER\n> ```\n\n后 $$c$$',
    );
    // 不在行首、或那一行还有反引号的三个反引号是行内代码，不是围栏
    expect(preprocessLaTeX('写成 ```$a$``` 与 $b$')).toBe('写成 ```$a$``` 与 $$b$$');
    expect(preprocessLaTeX('```$a$``` 与 $b$')).toBe('```$a$``` 与 $$b$$');
  });

  it('行内代码按反引号串的长度配对：长度不同的反引号串不闭合它', () => {
    expect(preprocessLaTeX('用 `` $a$ ` `` 写，再 $b$')).toBe('用 `` $a$ ` `` 写，再 $$b$$');
  });

  it('链接与图片的地址、尖括号里的链接、裸网址原样保留；链接文字里的公式照常', () => {
    for (const text of [
      '[文档](https://api.example.com/items?$filter=a&$top=10)',
      '![图](/media?$a=1&$b=2 "标题")',
      '<ftp://files.example/$a/$b>',
      '见 https://api.example.com/items?$filter=a&$top=10 与 www.example.com/?$a=1&$b=2',
    ]) {
      expect(preprocessLaTeX(text), text).toBe(text);
    }
    expect(preprocessLaTeX('[$x$](https://a.example) 后 $y$')).toBe('[$$x$$](https://a.example) 后 $$y$$');
  });
});
