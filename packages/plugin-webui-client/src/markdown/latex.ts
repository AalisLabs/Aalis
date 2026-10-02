import { fixGfmTables } from '@aalis/util-text-normalize';

/**
 * 公式写法的预处理，让 remark-math 认得出：
 * 1. `\(...\)` 换成 `$...$`，`\[...\]` 换成 `$$...$$`（remark-math 只认 `$` 定界），公式里的 `|` 换成 `\vert`，免得被当成表格的列线；
 * 2. 跨行的 `$$...$$` 的开闭标记各占一行、前后空行隔开：模型常把整块矩阵写在一行的两个 `$$` 之间，不隔开会被当成行内公式而解析失败；
 * 3. 流式输出时末尾还没闭合的跨行 `$$` 块先补上闭合，免得整段公式源码露在外面；
 * 4. 表格分隔行的列数对不上表头时先修好（模型常见的错，与 agent 侧同一份修复；历史会话与没经 agent 的内容也要修）。
 * 代码块与行内代码原样保留
 */
export function preprocessLaTeX(content: string): string {
  const parts = fixGfmTables(content).split(/(```[\s\S]*?```|`[^`]*`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      let text = part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `$$${math.replace(/\|/g, '\\vert ')}$$`)
        .replace(/\\\((.*?)\\\)/g, (_, math: string) => `$${math.replace(/\|/g, '\\vert ')}$`)
        .replace(/\$\$([\s\S]+?)\$\$/g, (match, math: string) => (math.includes('\n') ? isolate(math) : match));
      if ((text.match(/\$\$/g) ?? []).length % 2 === 1) {
        text = text.replace(/\$\$((?:(?!\$\$)[\s\S])+)$/, (match, math: string) =>
          math.includes('\n') && trimEdges(math) ? isolate(math) : match,
        );
      }
      return text;
    })
    .join('');
}

const trimEdges = (math: string) => math.replace(/^[ \t]*\n?/, '').replace(/\n?[ \t]*$/, '');

const isolate = (math: string) => `\n\n$$\n${trimEdges(math)}\n$$\n\n`;
