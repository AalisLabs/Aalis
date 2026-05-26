import type { ComponentPropsWithoutRef } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Components } from 'react-markdown';
import { MermaidBlock } from './MermaidBlock';

/** 模块级常量：避免每次渲染创建新数组引用，防止 ReactMarkdown 不必要地重解析 */
export const REMARK_PLUGINS = [remarkGfm, remarkMath];
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
export const REHYPE_PLUGINS = [rehypeHighlight, [rehypeKatex, REHYPE_KATEX_OPTIONS]];

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
