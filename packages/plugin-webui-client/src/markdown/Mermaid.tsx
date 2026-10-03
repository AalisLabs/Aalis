import { createContext, memo, useContext, useEffect, useState, useSyncExternalStore } from 'react';

// Mermaid 图：用到时才加载。图的源码来自模型与工具输出，不可信，用严格安全级别（内置的净化、不绑定点击回调）；
// 颜色每次渲染时从当前主题的令牌取，换主题后重画。所在的消息还在输出时源码没写完，只显示源码，输出完再画

/** 所在的消息正在输出 */
export const Streaming = createContext(false);

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(source: string): Promise<unknown>;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let loading: Promise<MermaidApi> | undefined;
const load = () => {
  loading ??= import('mermaid').then(module => module.default as unknown as MermaidApi);
  return loading;
};

/** 图里的颜色 → 取值的令牌 */
const THEME_TOKENS = {
  background: '--color-bg',
  primaryColor: '--color-surface-raised',
  primaryTextColor: '--color-text',
  primaryBorderColor: '--color-border-control',
  secondaryColor: '--color-bg-side',
  tertiaryColor: '--color-bg',
  lineColor: '--color-text-2',
  textColor: '--color-text',
  noteBkgColor: '--color-bg-side',
  noteTextColor: '--color-text',
};

function themeVariables() {
  const style = getComputedStyle(document.documentElement);
  const variables: Record<string, string | boolean> = { darkMode: style.colorScheme === 'dark' };
  for (const [name, token] of Object.entries(THEME_TOKENS)) {
    const value = style.getPropertyValue(token).trim();
    if (value) variables[name] = value;
  }
  return variables;
}

/** 当前主题：<html data-theme> 或写在它内联样式上的令牌（导入与插件提供的主题）变了就重画 */
function useTheme(): string {
  return useSyncExternalStore(
    listener => {
      const observer = new MutationObserver(listener);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
      return () => observer.disconnect();
    },
    () => `${document.documentElement.getAttribute('data-theme')}|${document.documentElement.getAttribute('style')}`,
  );
}

let counter = 0;

/** 渲染失败时 Mermaid 挂在 body 下的临时节点 */
function removeLeftovers(id: string): void {
  for (const leftover of document.querySelectorAll(`body > #${id}, body > #d${id}`)) leftover.remove();
}

export const Mermaid = memo(function Mermaid({ chart }: { chart: string }) {
  const theme = useTheme();
  const streaming = useContext(Streaming);
  const [result, setResult] = useState<{ svg: string } | { error: string }>();

  useEffect(() => {
    if (streaming) return;
    let stale = false;
    const id = `mermaid-${++counter}`;
    load()
      .then(async mermaid => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: themeVariables(),
          fontFamily: 'inherit',
        });
        await mermaid.parse(chart);
        return mermaid.render(id, chart);
      })
      .then(
        ({ svg }) => {
          if (!stale) setResult({ svg });
        },
        (error: unknown) => {
          removeLeftovers(id);
          if (!stale) setResult({ error: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      stale = true;
    };
  }, [chart, theme, streaming]);

  if (result && 'svg' in result) {
    // Mermaid 在严格安全级别下经内置的净化输出 SVG
    return <div className="markdown-mermaid" dangerouslySetInnerHTML={{ __html: result.svg }} />;
  }
  return (
    <div className="markdown-mermaid">
      {result && <p className="markdown-mermaid-error">图没能画出来：{result.error}</p>}
      <pre>
        <code>{chart}</code>
      </pre>
    </div>
  );
});
