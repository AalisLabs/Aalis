import type { ComponentPropsWithoutRef } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Components } from 'react-markdown';
import { MermaidBlock } from './MermaidBlock';

/** 模块级常量：避免每次渲染创建新数组引用，防止 ReactMarkdown 不必要地重解析 */
export const REMARK_PLUGINS = [remarkGfm, remarkMath];
export const REHYPE_PLUGINS = [rehypeHighlight, rehypeKatex];

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
