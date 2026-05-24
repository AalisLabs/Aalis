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
  data: {
    id: string;
    label?: string;
    kind?: 'person' | 'event' | 'entity' | string;
    entityKind?: 'topic' | 'place' | 'thing' | 'work' | string;
    [k: string]: unknown;
  };
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

// 深色主题硬编码（与 App.css 中 --bg/--surface 对齐）
const PERSON_COLOR = '#60a5fa'; // 人物=蓝
const EVENT_COLOR = '#fb923c'; // 事件=橙
const FOCUS_COLOR = '#ef4444'; // 焦点=红
const TEXT_COLOR = '#e4e4ef';
const CANVAS_BG = '#0f0f14';
const EDGE_COLOR = '#6b7280';
const EDGE_LABEL_BG = '#1c1c28';
const ENTITY_COLORS: Record<string, string> = {
  topic: '#34d399',
  place: '#a78bfa',
  thing: '#fbbf24',
  work: '#f472b6',
};
const ENTITY_DEFAULT = '#9ca3af';
// 深度 0 表示「不限」，送给后端时映射成足够大的有限数
const UNLIMITED_DEPTH_SENTINEL = 99;

const stylesheet: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'background-color': PERSON_COLOR,
      color: TEXT_COLOR,
      'font-size': 11,
      'text-valign': 'bottom',
      'text-margin-y': 4,
      'text-outline-color': CANVAS_BG,
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
      'border-color': '#9a3412',
      width: 36,
      height: 24,
    },
  },
  {
    selector: 'node[kind = "entity"]',
    style: {
      shape: 'diamond',
      'background-color': ENTITY_DEFAULT,
      'border-color': '#374151',
      width: 30,
      height: 30,
    },
  },
  { selector: 'node[entityKind = "topic"]', style: { 'background-color': ENTITY_COLORS.topic } },
  { selector: 'node[entityKind = "place"]', style: { 'background-color': ENTITY_COLORS.place } },
  { selector: 'node[entityKind = "thing"]', style: { 'background-color': ENTITY_COLORS.thing } },
  { selector: 'node[entityKind = "work"]', style: { 'background-color': ENTITY_COLORS.work } },
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
      'line-color': EDGE_COLOR,
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 9,
      color: TEXT_COLOR,
      'text-rotation': 'autorotate' as unknown as number,
      'text-background-color': EDGE_LABEL_BG,
      'text-background-opacity': 0.85,
      'text-background-padding': 1 as unknown as string,
      'target-arrow-shape': 'triangle',
      'target-arrow-color': EDGE_COLOR,
    },
  },
  {
    selector: 'edge[kind = "person-event"]',
    style: { 'line-color': '#fbbf24', 'target-arrow-color': '#fbbf24', 'line-style': 'dashed' },
  },
  {
    selector: 'edge[kind = "person-entity"]',
    style: { 'line-color': '#34d399', 'target-arrow-color': '#34d399', 'line-style': 'dotted' },
  },
  {
    selector: 'edge[kind = "event-event"]',
    style: { 'line-color': '#f472b6', 'target-arrow-color': '#f472b6', width: 2 },
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

  // 画布高度可拖拽（持久化到 localStorage，按 source key 区分不同图）
  const heightStorageKey = `relation-graph-h:${pluginName}:${comp.source}`;
  const [graphHeight, setGraphHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 520;
    const stored = Number(window.localStorage.getItem(heightStorageKey));
    return Number.isFinite(stored) && stored >= 200 ? stored : 520;
  });
  const dragStartRef = useRef<{ y: number; h: number } | null>(null);
  const onResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStartRef.current = { y: e.clientY, h: graphHeight };
  }, [graphHeight]);
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const next = Math.max(200, Math.min(1600, dragStartRef.current.h + (e.clientY - dragStartRef.current.y)));
    setGraphHeight(next);
  }, []);
  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragStartRef.current = null;
    try {
      window.localStorage.setItem(heightStorageKey, String(graphHeight));
    } catch {
      // 忽略 quota 错误
    }
  }, [heightStorageKey, graphHeight]);
  // 拖拽后通知 cytoscape resize
  useEffect(() => {
    cyRef.current?.resize();
  }, [graphHeight]);

  // ── fetch graph ───────────────────────────────────────────
  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const args = {
        focusId,
        maxDepth: maxDepth <= 0 ? UNLIMITED_DEPTH_SENTINEL : maxDepth,
        maxBreadth,
      };
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
    const dataUrl = cy.png({ full: true, scale: 2, bg: CANVAS_BG });
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
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border-color, #2a2a42)',
    fontSize: 12,
    color: 'var(--text)',
  };
  const canvasStyle: CSSProperties = {
    width: '100%',
    height: graphHeight,
    background: CANVAS_BG,
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
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: focusId ? 1 : 0.45 }}
          title={focusId ? '从焦点节点出发的 BFS 跳数（0 = 不限）' : '深度仅在选定焦点后生效：点击节点 → 详情面板 → 「以此为焦点」'}
        >
          深度
          <input
            type="range"
            min={0}
            max={10}
            value={maxDepth}
            onChange={e => setMaxDepth(Number(e.target.value))}
            disabled={!focusId}
          />
          <input
            type="number"
            min={0}
            value={maxDepth}
            onChange={e => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) setMaxDepth(n);
            }}
            disabled={!focusId}
            style={{ width: 56, padding: '2px 4px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--surface-active)' }}
          />
          <span style={{ width: 32, color: 'var(--text-secondary)' }}>{maxDepth === 0 ? '∞' : maxDepth}</span>
        </label>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          title={
            focusId
              ? '焦点模式：每个节点向外展开的邻居数上限（按边权重降序截断）'
              : '全图模式：用作活跃节点数缩放因子（personCap ≈ breadth × 6）'
          }
        >
          宽度
          <input type="range" min={3} max={30} value={maxBreadth} onChange={e => setMaxBreadth(Number(e.target.value))} />
          <input
            type="number"
            min={1}
            value={maxBreadth}
            onChange={e => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1) setMaxBreadth(n);
            }}
            style={{ width: 56, padding: '2px 4px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--surface-active)' }}
          />
          <span style={{ width: 24, color: 'var(--text-secondary)' }}>{maxBreadth}</span>
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
              borderLeft: '1px solid var(--border-color, #2a2a42)',
              padding: 12,
              fontSize: 12,
              background: 'var(--surface)',
              color: 'var(--text)',
              overflow: 'auto',
              maxHeight: graphHeight,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong>{selectedNode.data.label ?? selectedNode.data.id}</strong>
              <button
                type="button"
                onClick={() => setSelectedNode(null)}
                style={{ background: 'none', border: 0, color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>{selectedNode.data.kind ?? '—'}</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button
                type="button"
                onClick={() => {
                  setFocusId(selectedNode.data.id);
                  setSelectedNode(null);
                }}
                style={{ padding: '4px 8px', background: 'var(--surface-hover)', color: 'var(--text)', border: '1px solid var(--surface-active)' }}
              >
                以此为焦点
              </button>
            </div>
            {detailLoading ? (
              <div style={{ color: 'var(--text-muted)' }}>加载详情中…</div>
            ) : detail ? (
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, margin: 0, color: 'var(--text)' }}>
                {JSON.stringify(detail, null, 2)}
              </pre>
            ) : (
              <div style={{ color: 'var(--text-muted)' }}>无详情（detailSource 未配置）</div>
            )}
          </aside>
        ) : null}
      </div>

      {/* 拖拽改变画布高度。改完写入 localStorage，下次保持。 */}
      <div
        role="separator"
        aria-orientation="horizontal"
        title="拖拽调整画布高度"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        style={{
          height: 8,
          cursor: 'ns-resize',
          background: 'var(--bg-secondary)',
          borderTop: '1px solid var(--border-color, #2a2a42)',
          borderBottom: '1px solid var(--border-color, #2a2a42)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            width: 40,
            height: 3,
            borderRadius: 2,
            background: 'var(--text-muted, #6b7280)',
            opacity: 0.6,
          }}
        />
      </div>

      <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
        {statsText || '—'}
      </div>
    </div>
  );
}
