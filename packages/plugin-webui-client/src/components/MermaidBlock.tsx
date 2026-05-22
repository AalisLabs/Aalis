import { memo, useEffect, useRef, useState } from 'react';

type MermaidApi = {
  initialize: (opts: Record<string, unknown>) => void;
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

let counter = 0;

function MermaidBlockImpl({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string>(`mermaid-${++counter}`);

  useEffect(() => {
    let cancelled = false;
    const src = chart.trim();
    if (!src) {
      setSvg(null);
      setError(null);
      return;
    }
    loadMermaid()
      .then((m) => m.render(idRef.current, src))
      .then(({ svg }) => {
        if (cancelled) return;
        setSvg(svg);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setSvg(null);
      });
    return () => {
      cancelled = true;
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
