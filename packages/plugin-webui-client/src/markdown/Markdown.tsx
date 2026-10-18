import 'katex/dist/katex.min.css';
import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps, type Options, type UrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CopyButton, canCopy } from '../components/CopyButton';
import { Picture } from '../components/Picture';
import { tr } from '../language';
import { isWebUrl, mediaUrl } from '../media';
import { preprocessLaTeX } from './latex';
import { Mermaid, Streaming } from './Mermaid';
import './Markdown.css';

// 模型、插件与房间成员写的文字都不可信：原始 HTML 当文字显示；图片只认媒体地址，外站图片显示成链接、不发请求；
// 链接只许 http、https 与 mailto；公式不信任输入（\href 等不生效）。裸换行照写的换行显示。
// 单个 ~ 不是删除线（常用来写「约」）；单美元不是公式的定界符，行内公式由预处理写成行内的 $$（见 latex.ts）。
// plain 只认段落与列表，其余写法在解析时关掉（micromark 的 disable），按原文显示；分隔线的检查也随之关掉，单独一行的
// `- - -` 会成为空的嵌套列表（指令回复不这样写）

const REMARK_PLUGINS: Options['remarkPlugins'] = [
  [remarkGfm, { singleTilde: false }],
  [remarkMath, { singleDollarTextMath: false }],
  remarkBreaks,
];
const PLAIN_DISABLED = [
  'attention',
  'autolink',
  'blockQuote',
  'characterEscape',
  'characterReference',
  'codeFenced',
  'codeIndented',
  'codeText',
  'definition',
  'hardBreakEscape',
  'headingAtx',
  'htmlFlow',
  'htmlText',
  'labelStartImage',
  'labelStartLink',
  'setextUnderline',
  'thematicBreak',
];
const PLAIN_REMARK_PLUGINS: Options['remarkPlugins'] = [
  function paragraphsAndLists(this: unknown) {
    // remark-parse 从处理器数据的 micromarkExtensions 取解析扩展
    const data = (this as { data(): { micromarkExtensions?: object[] } }).data();
    data.micromarkExtensions = [...(data.micromarkExtensions ?? []), { disable: { null: PLAIN_DISABLED } }];
  },
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

/** 代码块写明的语言：code 元素的 language-* 类名 */
function languageOf(code: ElementContent | undefined): string | undefined {
  if (code?.type !== 'element' || code.tagName !== 'code') return undefined;
  const name = String(code.properties.className ?? '')
    .split(/[\s,]+/)
    .find(token => token.startsWith('language-'));
  return name?.slice('language-'.length);
}

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
    if (url) return <Picture src={url} alt={alt ?? ''} />;
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
    const language = languageOf(code);
    if (language === 'mermaid') return <Mermaid chart={textOf(code).replace(/\n$/, '')} />;
    return (
      <CodeBlock text={textOf(code)} language={language}>
        {children}
      </CodeBlock>
    );
  },
};

/** 代码块：上方一条细的标题行写语言名与复制按钮，不压住代码；两样都没有时没有这一行 */
function CodeBlock({ text, language, children }: { text: string; language?: string; children: ReactNode }) {
  return (
    <div className="markdown-code">
      {(language || canCopy()) && (
        <div className="markdown-code-head">
          {language}
          <CopyButton text={text} label={tr('copyCode')} />
        </div>
      )}
      <pre>{children}</pre>
    </div>
  );
}

interface MarkdownProps {
  text: string;
  /** 这段还在输出 */
  streaming?: boolean;
  /** 只认段落与列表：转述了别人原话的文字（如指令的回复）用它，写法照原文显示 */
  plain?: boolean;
}

/** 一段 Markdown：字号与行高跟着外面 */
export const Markdown = memo(function Markdown({ text, streaming = false, plain = false }: MarkdownProps) {
  return (
    <div className="markdown">
      <Streaming.Provider value={streaming}>
        <ReactMarkdown
          remarkPlugins={plain ? PLAIN_REMARK_PLUGINS : REMARK_PLUGINS}
          rehypePlugins={plain ? [] : REHYPE_PLUGINS}
          components={COMPONENTS}
          urlTransform={urlTransform}
        >
          {plain ? text : preprocessLaTeX(text)}
        </ReactMarkdown>
      </Streaming.Provider>
    </div>
  );
});
