import type { ComponentPropsWithoutRef } from 'react';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Components } from 'react-markdown';
import { MermaidBlock } from './MermaidBlock';

/**
 * 模块级常量：避免每次渲染创建新数组引用，防止 ReactMarkdown 不必要地重解析。
 *
 * `remark-breaks`：把裸换行渲染成 `<br>`。CommonMark 规定单个换行只是软换行、会被合并成
 * 一段，而 LLM 输出与指令帮助文本都按「换行即换行」来写——不加这个插件，多行内容会挤成一坨。
 *
 * **不加 `rehype-raw`**（曾被记为待补项，实测是错的，两条理由各自都足够）：
 * 1. 它修不了那个症状。实测 `--type <type>` 现状渲染为 `&lt;type&gt;`（**正确显示**）；
 *    加上 rehype-raw 后变成空的自定义元素 `<type></type>`，肉眼不可见 —— 更糟。
 *    真正出问题的 `<name:string>` 是被解析成了**空链接**（autolink），与 raw HTML 无关，
 *    要治得在产出侧（`plugin-commands/src/help.ts` 现用代码块围栏规避）。
 * 2. 它是确凿的 XSS 面。本渲染器用于 ChatPanel / SessionsPage，喂进来的是 LLM 输出与用户
 *    消息（不可信）。实测 `<img src=x onerror="alert(1)">` 现状被安全转义，加上 rehype-raw
 *    后成为真实 `<img>` 并触发预加载 —— 等于对不可信内容开放任意 HTML。
 *    真要开放需同时上 `rehype-sanitize`，那是另一件事，不是「补个插件」。
 */
export const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkBreaks];
/**
 * rehype-katex 宽容配置：
 * - `strict: 'ignore'`：遇到不识别的 macro / 警告（比如 `\color{red}{x}`、中文 `\text{}`、流式 chunk 边界
 *   导致的临时不闭合）静默通过，而不是抛 ParseError；
 * - `throwOnError: false`：渲染失败时不要中断，而是回退；
 * - `errorColor: 'inherit'`：失败时不用刺眼的默认红色 `#cc0000`，沿用当前文字色，避免"红色源码裸露"；
 * - `output: 'htmlAndMathml'`：同时输出 HTML + MathML，复制粘贴体验更好。
 */
const REHYPE_KATEX_OPTIONS = {
  strict: 'ignore' as const,
  throwOnError: false,
  errorColor: 'inherit',
  output: 'htmlAndMathml' as const,
};
export const REHYPE_PLUGINS = [
  rehypeHighlight,
  // 显式 tuple 类型标注：避免 TypeScript 把 [plugin, options] 推断为 union 数组而非 PluginTuple
  [rehypeKatex, REHYPE_KATEX_OPTIONS] as [typeof rehypeKatex, typeof REHYPE_KATEX_OPTIONS],
];

function CodeRenderer({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<'code'>) {
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match?.[1];
  if (lang === 'mermaid') {
    const src = Array.isArray(children)
      ? children.join('')
      : String(children ?? '');
    return <MermaidBlock chart={src.replace(/\n$/, '')} />;
  }
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

/** 公共 ReactMarkdown components 配置（含 mermaid 代码块拦截渲染） */
export const MARKDOWN_COMPONENTS: Components = {
  code: CodeRenderer,
};
