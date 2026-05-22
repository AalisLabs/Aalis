import { memo, useEffect, useRef, useState } from 'react';

type MermaidApi = {
  initialize: (opts: Record<string, unknown>) => void;
  parse: (src: string, opts?: { suppressErrors?: boolean }) => Promise<unknown>;
  render: (id: string, src: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = (mod as unknown as { default: MermaidApi }).default;
      const isDark =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'default',
        securityLevel: 'loose',
        fontFamily: 'inherit',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/** mermaid.render 失败时会在 <body> 末尾遗留临时 DOM（id 为我们传入的 id，
 * 或形如 `d${id}` 的兄弟节点，内含 "Syntax error in text" 大字 SVG）。
 * 主动清理掉，避免在页面底部出现错误图。 */
function cleanupMermaidArtifacts(id: string) {
  if (typeof document === 'undefined') return;
  for (const sel of [`#${id}`, `#d${id}`, `#${id}-temp`]) {
    document.querySelectorAll(sel).forEach((el) => el.remove());
  }
}

let counter = 0;

function MermaidBlockImpl({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string>(`mermaid-${++counter}`);

  useEffect(() => {
    let cancelled = false;
    const id = idRef.current;
    const src = chart.trim();
    if (!src) {
      setSvg(null);
      setError(null);
      return;
    }
    loadMermaid()
      .then(async (m) => {
        // 先 parse 预校验：parse 不写入 DOM，能在错误时直接抛出，
        // 避免 render 在 body 末尾留下残留错误 SVG。
        await m.parse(src);
        return m.render(id, src);
      })
      .then(({ svg }) => {
        if (cancelled) return;
        setSvg(svg);
        setError(null);
      })
      .catch((e: unknown) => {
        // 双保险：parse 漏过的、或 render 中途失败时，主动清理残留节点。
        cleanupMermaidArtifacts(id);
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setSvg(null);
      });
    return () => {
      cancelled = true;
      cleanupMermaidArtifacts(id);
    };
  }, [chart]);

  if (error) {
    return (
      <div className="mermaid-block mermaid-block-error">
        <div className="mermaid-error-banner">⚠ Mermaid 渲染失败：{error}</div>
        <pre>
          <code className="language-mermaid">{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <pre className="mermaid-block mermaid-block-loading">
        <code className="language-mermaid">{chart}</code>
      </pre>
    );
  }

  return (
    <div
      className="mermaid-block"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid 输出可信 SVG（securityLevel='loose' 仍由 mermaid 自身做 sanitize）
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export const MermaidBlock = memo(MermaidBlockImpl);
