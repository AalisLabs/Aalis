import { fixGfmTables } from '@aalis/util-text-normalize';

/**
 * 代码：行首（可带缩进与引用的 >）的 ``` 或 ~~~ 围栏，到同种字符、不短于它、后面只有空白的闭合围栏，流式输出时还没闭合的
 * 到文末；``` 围栏的那一行不能再有反引号（否则是行内代码）。行内代码按反引号串的长度配对。
 * 缩进四格的代码块不认：在这一层与列表里缩进的续行分不开
 */
const CODE = new RegExp(
  [
    String.raw`(?<=^|\n)[ \t>]*(?<ticks>\`{3,})[^\`\n]*(?=\n|$)(?:[\s\S]*?\n[ \t>]*\k<ticks>\`*[^\S\n]*(?=\n|$)|[\s\S]*)`,
    String.raw`(?<=^|\n)[ \t>]*(?<tildes>~{3,}).*(?:[\s\S]*?\n[ \t>]*\k<tildes>~*[^\S\n]*(?=\n|$)|[\s\S]*)`,
    String.raw`(?<!\`)(?<span>\`+)(?!\`)[\s\S]*?(?<!\`)\k<span>(?!\`)`,
  ].join('|'),
  'g',
);

/** 单美元公式里紧挨定界符的一个字：非空白、不是 $，或一个转义 */
const EDGE = String.raw`(?:[^\s$\\]|\\\S)`;
/** 单美元公式中间的一个字：同一行、不是未转义的 $ */
const INNER = String.raw`(?:[^$\\\n]|\\.)`;

/**
 * 从左往右逐段认，认出的一段整段处理、不再拆开（$$ 块里的 $ 不当单美元）。依次是 \[...\]、\(...\)、成对的 $$、
 * 流式输出时末尾还没闭合的跨行 $$ 块、不成对的一串 $ 与转义、链接与图片的地址、尖括号里的链接、裸网址（这几样原样留着，
 * 不当单美元的定界符）、单美元公式
 */
const MATH = new RegExp(
  [
    String.raw`\\\[(?<bracket>[\s\S]*?)\\\]`,
    String.raw`\\\((?<paren>.*?)\\\)`,
    String.raw`\$\$(?<block>[\s\S]+?)\$\$`,
    String.raw`\$\$(?<open>(?:(?!\$\$)[\s\S])*\n(?:(?!\$\$)[\s\S])*)$`,
    String.raw`\$\$+|\\[\s\S]`,
    String.raw`\]\([^)\s]*(?:\s+"[^"]*")?\)`,
    String.raw`<[a-zA-Z][\w+.-]*:[^\s<>]*>`,
    String.raw`(?:https?://|www\.)[^\s<]*`,
    String.raw`\$(?<single>${EDGE}(?:${INNER}*${EDGE})?)\$(?![\d$])`,
  ].join('|'),
  'g',
);

/**
 * 公式写法的预处理，让 remark-math 认得出。remark-math 不认单美元（免得两处金额之间成了公式），行内公式一律写成行内的 $$：
 * 1. `\(...\)` 换成行内的 `$$...$$`，`\[...\]` 换成 `$$...$$`，这两种公式里的 `|` 换成 `\vert`，免得被当成表格的列线；
 * 2. 单美元按成文规则认：开头的 `$` 右边紧跟非空白，结尾的 `$` 左边紧跟非空白、右边不紧跟数字或 `$`（免得和相邻的 `$`
 *    连成 `$$`），同一行，中间没有未转义的 `$`。认出的换成行内的 `$$...$$`，认不出的原样按字面显示（如「$5 和 $10」）；
 * 3. 跨行的 `$$...$$` 的开闭标记各占一行、前后空行隔开：模型常把整块矩阵写在一行的两个 `$$` 之间，不隔开会被当成行内公式而解析失败；
 * 4. 流式输出时末尾还没闭合的跨行 `$$` 块先补上闭合，免得整段公式源码露在外面；
 * 5. 表格分隔行的列数对不上表头时先修好（模型常见的错，与 agent 侧同一份修复；历史会话与没经 agent 的内容也要修）。
 * 代码与链接地址原样保留
 */
export function preprocessLaTeX(content: string): string {
  const text = fixGfmTables(content);
  let out = '';
  let from = 0;
  for (const code of text.matchAll(CODE)) {
    out += rewrite(text.slice(from, code.index)) + code[0];
    from = code.index + code[0].length;
  }
  return out + rewrite(text.slice(from));
}

/** 代码之外的一段按 MATH 逐段改写 */
const rewrite = (text: string) =>
  text.replace(MATH, (match, ...args) => {
    const { bracket, paren, block, open, single } = args.at(-1) as Record<string, string | undefined>;
    if (bracket !== undefined) return display(bracket.replace(/\|/g, '\\vert '));
    if (paren !== undefined) return `$$${paren.replace(/\|/g, '\\vert ')}$$`;
    if (block !== undefined) return display(block);
    if (open !== undefined) return trimEdges(open) ? isolate(open) : match;
    return single === undefined ? match : `$$${single}$$`;
  });

const trimEdges = (math: string) => math.replace(/^[ \t]*\n?/, '').replace(/\n?[ \t]*$/, '');

const isolate = (math: string) => `\n\n$$\n${trimEdges(math)}\n$$\n\n`;

/** $$ 公式：跨行的隔成块，单行的照写 */
const display = (math: string) => (math.includes('\n') ? isolate(math) : `$$${math}$$`);
