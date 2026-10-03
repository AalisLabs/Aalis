import 'katex/dist/katex.min.css';
import { Check, Copy } from 'lucide-react';
import { memo, type ReactNode, useEffect, useState } from 'react';
import ReactMarkdown, { type Components, type ExtraProps, type Options, type UrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { IconButton } from '../components/IconButton';
import { isWebUrl, mediaUrl } from '../media';
import { preprocessLaTeX } from './latex';
import { Mermaid, Streaming } from './Mermaid';
import './Markdown.css';

// 模型、插件与房间成员写的文字都不可信：原始 HTML 当文字显示；图片只认媒体地址，外站图片显示成链接、不发请求；
// 链接只许 http、https 与 mailto；公式不信任输入（\href 等不生效）。裸换行照写的换行显示。
// 单个 ~ 不是删除线（常用来写「约」）；单美元不是公式的定界符，行内公式由预处理写成行内的 $$（见 latex.ts）

const REMARK_PLUGINS: Options['remarkPlugins'] = [
  [remarkGfm, { singleTilde: false }],
  [remarkMath, { singleDollarTextMath: false }],
  remarkBreaks,
];
const REHYPE_PLUGINS: Options['rehypePlugins'] = [
  [rehypeHighlight, { plainText: ['mermaid'] }],
  [
    rehypeKatex,
    { strict: 'ignore', throwOnError: false, errorColor: 'inherit', output: 'htmlAndMathml', trust: false },
  ],
];

type Element = NonNullable<ExtraProps['node']>;
type ElementContent = Element['children'][number];

const urlTransform: UrlTransform = (url, key) => (key !== 'href' || /^(https?|mailto):/i.test(url) ? url : '');

function textOf(node: ElementContent | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  return node.type === 'element' ? node.children.map(textOf).join('') : '';
}

const isMermaid = (code: ElementContent | undefined): code is Element =>
  code?.type === 'element' &&
  code.tagName === 'code' &&
  String(code.properties.className ?? '')
    .split(/[\s,]+/)
    .includes('language-mermaid');

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} {...(isWebUrl(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? mediaUrl(src) : undefined;
    if (url) return <img src={url} alt={alt ?? ''} loading="lazy" />;
    if (typeof src === 'string' && isWebUrl(src)) {
      return (
        <a href={src} target="_blank" rel="noopener noreferrer">
          {alt || src}
        </a>
      );
    }
    return <span>{alt}</span>;
  },
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (isMermaid(code)) return <Mermaid chart={textOf(code).replace(/\n$/, '')} />;
    return <CodeBlock text={textOf(code)}>{children}</CodeBlock>;
  },
};

const canCopy = () => window.isSecureContext && navigator.clipboard !== undefined;

const COPY_LABELS = { idle: '复制代码', copied: '已复制', failed: '没能复制' } as const;
const COPY_RESET_MS = 2_000;

function CodeBlock({ text, children }: { text: string; children: ReactNode }) {
  const [copy, setCopy] = useState<keyof typeof COPY_LABELS>('idle');

  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), COPY_RESET_MS);
    return () => clearTimeout(timer);
  }, [copy]);

  return (
    <div className="markdown-code">
      <pre>{children}</pre>
      {canCopy() && (
        <IconButton
          icon={copy === 'copied' ? Check : Copy}
          label={COPY_LABELS[copy]}
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => setCopy('copied'),
              () => setCopy('failed'),
            )
          }
        />
      )}
    </div>
  );
}

/** 一段 Markdown：字号与行高跟着外面；streaming 是这段还在输出 */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      <Streaming.Provider value={streaming}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={COMPONENTS}
          urlTransform={urlTransform}
        >
          {preprocessLaTeX(text)}
        </ReactMarkdown>
      </Streaming.Provider>
    </div>
  );
});
