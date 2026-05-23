import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import cytoscape, { type Core, type ElementDefinition, type EventObject } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { pageAction } from '../api';
import type { WebuiGraphComponent } from '../types';

// 注册一次 fcose 布局
let _fcoseRegistered = false;
function ensureFcose(): void {
  if (_fcoseRegistered) return;
  cytoscape.use(fcose);
  _fcoseRegistered = true;
}

interface GraphNode {
  data: { id: string; label?: string; kind?: 'person' | 'event' | string; [k: string]: unknown };
}
interface GraphEdge {
  data: { id: string; source: string; target: string; label?: string; relationType?: string; [k: string]: unknown };
}
interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focusId?: string;
  stats?: Record<string, number | string>;
}

const PERSON_COLOR = '#3b82f6';
const EVENT_COLOR = '#f59e0b';
const FOCUS_COLOR = '#ef4444';

const stylesheet: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'background-color': PERSON_COLOR,
      color: '#1f2937',
      'font-size': 11,
      'text-valign': 'bottom',
      'text-margin-y': 4,
      'text-outline-color': '#fff',
      'text-outline-width': 2,
      width: 28,
      height: 28,
      'border-width': 1,
      'border-color': '#1e3a8a',
    },
  },
  {
    selector: 'node[kind = "event"]',
    style: {
      'background-color': EVENT_COLOR,
      shape: 'round-rectangle',
      'border-color': '#92400e',
      width: 36,
      height: 24,
    },
  },
  {
    selector: 'node[focused = "1"]',
    style: {
      'background-color': FOCUS_COLOR,
      'border-color': '#7f1d1d',
      'border-width': 3,
      width: 36,
      height: 36,
    },
  },
  {
    selector: 'node:selected',
    style: { 'border-width': 3, 'border-color': '#0ea5e9' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': '#9ca3af',
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 9,
      color: '#6b7280',
      'text-rotation': 'autorotate' as unknown as number,
      'text-background-color': '#fff',
      'text-background-opacity': 0.85,
      'text-background-padding': 1 as unknown as string,
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#9ca3af',
    },
  },
  {
    selector: 'edge[kind = "person-event"]',
    style: { 'line-color': '#fbbf24', 'target-arrow-color': '#fbbf24', 'line-style': 'dashed' },
  },
  {
    selector: 'edge[dimmed = "1"]',
    style: { opacity: 0.15 },
  },
  {
    selector: 'node[dimmed = "1"]',
    style: { opacity: 0.2, 'text-opacity': 0 },
  },
];

interface Props {
  comp: WebuiGraphComponent;
  pluginName: string;
  refreshTick?: number;
}

export function RelationGraph({ comp, pluginName, refreshTick }: Props): JSX.Element {
  ensureFcose();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);

  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [focusId, setFocusId] = useState<string | undefined>();
  const [maxDepth, setMaxDepth] = useState<number>(comp.defaultMaxDepth ?? 2);
  const [maxBreadth, setMaxBreadth] = useState<number>(comp.defaultMaxBreadth ?? 10);
  const [search, setSearch] = useState('');

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ── fetch graph ───────────────────────────────────────────
  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const args = { focusId, maxDepth, maxBreadth };
      const res = await pageAction<GraphPayload>(pluginName, comp.source, args);
      if (!res) {
        setPayload({ nodes: [], edges: [] });
      } else {
        setPayload({
          nodes: Array.isArray(res.nodes) ? res.nodes : [],
          edges: Array.isArray(res.edges) ? res.edges : [],
          focusId: res.focusId,
          stats: res.stats,
        });
      }
    } catch (e) {
      setError((e as Error).message || String(e));
      setPayload({ nodes: [], edges: [] });
    } finally {
      setLoading(false);
    }
  }, [pluginName, comp.source, focusId, maxDepth, maxBreadth]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph, refreshTick]);

  // 自动刷新
  useEffect(() => {
    if (!comp.refresh || comp.refresh <= 0) return;
    const t = setInterval(fetchGraph, comp.refresh);
    return () => clearInterval(t);
  }, [comp.refresh, fetchGraph]);

  // ── cytoscape lifecycle ───────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: stylesheet,
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.2,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (e: EventObject) => {
      const data = e.target.data() as GraphNode['data'];
      setSelectedNode({ data });
    });
    cy.on('tap', (e: EventObject) => {
      if (e.target === cy) setSelectedNode(null);
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // 应用 payload
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !payload) return;

    const focusedId = payload.focusId ?? focusId;
    const elements: ElementDefinition[] = [
      ...payload.nodes.map(n => ({
        data: { ...n.data, focused: focusedId && n.data.id === focusedId ? '1' : undefined },
        group: 'nodes' as const,
      })),
      ...payload.edges.map(e => ({
        data: { ...e.data, kind: e.data.kind ?? (e.data.relationType ? 'person-person' : 'person-event') },
        group: 'edges' as const,
      })),
    ];

    cy.elements().remove();
    cy.add(elements);
    cy.layout({
      name: 'fcose',
      animate: false,
      randomize: payload.nodes.length > 20,
      nodeRepulsion: 6000,
      idealEdgeLength: 80,
      gravity: 0.25,
      padding: 30,
    } as cytoscape.LayoutOptions).run();
  }, [payload, focusId]);

  // 搜索高亮：dim 不匹配
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const term = search.trim().toLowerCase();
    if (!term) {
      cy.nodes().removeData('dimmed');
      cy.edges().removeData('dimmed');
      return;
    }
    const matched = cy.nodes().filter(n => {
      const label = String(n.data('label') ?? '').toLowerCase();
      const id = String(n.data('id') ?? '').toLowerCase();
      return label.includes(term) || id.includes(term);
    });
    const matchedIds = new Set(matched.map(n => n.id()));
    cy.nodes().forEach(n => n.data('dimmed', matchedIds.has(n.id()) ? undefined : '1'));
    cy.edges().forEach(e => {
      const ok = matchedIds.has(e.source().id()) || matchedIds.has(e.target().id());
      e.data('dimmed', ok ? undefined : '1');
    });
  }, [search]);

  // ── detail drawer ─────────────────────────────────────────
  useEffect(() => {
    if (!selectedNode || !comp.detailSource) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    pageAction<Record<string, unknown>>(pluginName, comp.detailSource, {
      nodeId: selectedNode.data.id,
      kind: selectedNode.data.kind,
    })
      .then(r => setDetail(r ?? null))
      .catch(e => setDetail({ error: (e as Error).message }))
      .finally(() => setDetailLoading(false));
  }, [selectedNode, pluginName, comp.detailSource]);

  // ── 导出 PNG ──────────────────────────────────────────────
  const exportPng = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const dataUrl = cy.png({ full: true, scale: 2, bg: '#ffffff' });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `relation-graph-${Date.now()}.png`;
    a.click();
  }, []);

  // ── 操作按钮 ──────────────────────────────────────────────
  const runAction = useCallback(
    async (method: string, confirmText?: string) => {
      if (confirmText && !window.confirm(confirmText)) return;
      try {
        await pageAction(pluginName, method, { focusId });
        fetchGraph();
      } catch (e) {
        alert(`操作失败: ${(e as Error).message}`);
      }
    },
    [pluginName, focusId, fetchGraph],
  );

  // ── UI ────────────────────────────────────────────────────
  const stats = payload?.stats ?? {};
  const statsText = useMemo(() => {
    const parts: string[] = [];
    if (payload) parts.push(`节点 ${payload.nodes.length}`, `边 ${payload.edges.length}`);
    for (const [k, v] of Object.entries(stats)) parts.push(`${k}=${v}`);
    return parts.join(' · ');
  }, [payload, stats]);

  const toolbarStyle: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    padding: '8px 10px',
    background: 'var(--bg-secondary, #f8fafc)',
    borderBottom: '1px solid var(--border-color, #e5e7eb)',
    fontSize: 12,
  };
  const canvasStyle: CSSProperties = {
    width: '100%',
    height: 520,
    background: '#ffffff',
    position: 'relative',
  };

  return (
    <div className="relation-graph-wrap" style={{ border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 6, overflow: 'hidden' }}>
      {comp.label ? <div style={{ padding: '8px 12px', fontWeight: 600 }}>{comp.label}</div> : null}

      <div style={toolbarStyle}>
        <input
          type="text"
          placeholder="搜索节点 (姓名/事件标题)"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 200px', minWidth: 160, padding: '4px 8px' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          深度
          <input type="range" min={1} max={5} value={maxDepth} onChange={e => setMaxDepth(Number(e.target.value))} />
          <span style={{ width: 16 }}>{maxDepth}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          宽度
          <input type="range" min={3} max={30} value={maxBreadth} onChange={e => setMaxBreadth(Number(e.target.value))} />
          <span style={{ width: 24 }}>{maxBreadth}</span>
        </label>
        {focusId ? (
          <button type="button" onClick={() => setFocusId(undefined)} style={{ padding: '4px 8px' }}>
            ← 返回全图
          </button>
        ) : null}
        <button type="button" onClick={fetchGraph} disabled={loading} style={{ padding: '4px 8px' }}>
          {loading ? '加载中…' : '刷新'}
        </button>
        <button type="button" onClick={exportPng} style={{ padding: '4px 8px' }}>
          导出 PNG
        </button>
        {(comp.actions ?? []).map(a => (
          <button
            key={a.method}
            type="button"
            onClick={() => runAction(a.method, a.confirm)}
            style={{ padding: '4px 8px', color: a.danger ? '#dc2626' : undefined }}
          >
            {a.label}
          </button>
        ))}
      </div>

      {error ? (
        <div style={{ padding: 8, color: '#dc2626', fontSize: 12 }}>错误: {error}</div>
      ) : null}

      <div style={{ display: 'flex' }}>
        <div ref={containerRef} style={canvasStyle} />
        {selectedNode ? (
          <aside
            style={{
              width: 280,
              borderLeft: '1px solid var(--border-color, #e5e7eb)',
              padding: 12,
              fontSize: 12,
              background: 'var(--bg-secondary, #f8fafc)',
              overflow: 'auto',
              maxHeight: 520,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong>{selectedNode.data.label ?? selectedNode.data.id}</strong>
              <button type="button" onClick={() => setSelectedNode(null)} style={{ background: 'none', border: 0, cursor: 'pointer' }}>
                ✕
              </button>
            </div>
            <div style={{ color: '#6b7280', marginBottom: 6 }}>{selectedNode.data.kind ?? '—'}</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button
                type="button"
                onClick={() => {
                  setFocusId(selectedNode.data.id);
                  setSelectedNode(null);
                }}
                style={{ padding: '4px 8px' }}
              >
                以此为焦点
              </button>
            </div>
            {detailLoading ? (
              <div style={{ color: '#9ca3af' }}>加载详情中…</div>
            ) : detail ? (
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, margin: 0 }}>
                {JSON.stringify(detail, null, 2)}
              </pre>
            ) : (
              <div style={{ color: '#9ca3af' }}>无详情（detailSource 未配置）</div>
            )}
          </aside>
        ) : null}
      </div>

      <div style={{ padding: '4px 10px', fontSize: 11, color: '#6b7280', background: 'var(--bg-secondary, #f8fafc)' }}>
        {statsText || '—'}
      </div>
    </div>
  );
}
