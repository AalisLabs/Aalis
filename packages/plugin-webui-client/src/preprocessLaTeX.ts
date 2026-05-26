/**
 * 预处理 LaTeX 内容，使 remark-math 能正确识别：
 * 1. 将 \(...\) 转为 $...$，\[...\] 转为 $$...$$（remark-math 仅支持 $ 分隔符）
 * 2. 在转换的数学公式内将 | 转为 \vert，避免 GFM 表格解析冲突
 * 3. 跨行的 `$$...$$` 数学块开闭标记强制独占一行（前后空行隔离）；
 *    避免 LLM 常写 `$$A = \begin{bmatrix} ... \end{bmatrix}$$` 被 remark-math 6.x
 *    误判为 inline 数学并解析失败、导致开头一段被 KaTeX 吞掉、后续行裸露源码。
 */
export function preprocessLaTeX(content: string): string {
  // 按代码块和行内代码拆分，跳过代码区域
  const parts = content.split(/(```[\s\S]*?```|`[^`]*`)/g);

  return parts.map((part, i) => {
    // 奇数索引为代码块/行内代码，保持原样
    if (i % 2 === 1) return part;

    // 将 \[...\] 转为 $$...$$（显示公式），同时转义内部的 |
    part = part.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) =>
      `$$${math.replace(/\|/g, '\\vert ')}$$`
    );

    // 将 \(...\) 转为 $...$（行内公式），同时转义内部的 |
    part = part.replace(/\\\((.*?)\\\)/g, (_, math) =>
      `$${math.replace(/\|/g, '\\vert ')}$`
    );

    // 跨行的 `$$...$$` 块：开闭标记强制独占一行 + 前后空行隔离。
    // 单行 inline `$$...$$` 保留原样（防止误伤）。
    part = part.replace(/\$\$([\s\S]+?)\$\$/g, (match, math: string) => {
      if (!math.includes('\n')) return match;
      const trimmed = math.replace(/^[ \t]*\n?/, '').replace(/\n?[ \t]*$/, '');
      return `\n\n$$\n${trimmed}\n$$\n\n`;
    });

    return part;
  }).join('');
}
