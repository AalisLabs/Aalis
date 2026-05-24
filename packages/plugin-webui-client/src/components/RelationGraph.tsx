import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
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
  focusEdge?: {
    id: string;
    kind: string;
    weight?: number;
    description?: string;
    firstSeenAt?: number;
    lastReinforcedAt?: number;
    evidence?: Array<{ quote?: string; sessionId?: string; messageIds?: string[]; extractedAt?: number }>;
    endpoints?: string[];
    relation?: string;
    role?: string;
    sentiment?: string;
    directed?: boolean;
  };
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

// --------------------------------------------------------------------------
// 边字段中英对照（仅用于 UI 显示，存储层保持英文 token）。
// 缺失映射时回退到原始 token —— 不抛错，避免后端新增枚举时 WebUI 崩溃。
// --------------------------------------------------------------------------
const EDGE_KIND_ZH: Record<string, string> = {
  'person-event': '人 → 事件',
  'person-entity': '人 → 物',
  'person-person': '人 → 人',
  'event-event': '事件 → 事件',
  'event-entity': '事件 → 物',
  'entity-entity': '物 → 物',
};
const PERSON_EVENT_ROLE_ZH: Record<string, string> = {
  initiator: '发起者',
  participant: '参与者',
  witness: '旁观者',
  target: '被指向',
  reporter: '转述者',
};
const PERSON_ENTITY_ROLE_ZH: Record<string, string> = {
  enthusiast: '深度卷入',
  participant: '参与/使用',
  owner: '拥有',
  creator: '创作者',
  critic: '行为性批评',
  visitor: '到访',
  mentioned: '仅被提及',
};
const PERSON_RELATION_ZH: Record<string, string> = {
  friend: '朋友',
  cp: 'CP',
  rival: '对手',
  mentor: '师徒',
  colleague: '同事',
  familiar: '熟人',
  antagonist: '敌对',
  admirer: '仰慕者',
  'is-alias-of': '是…的别名',
  'alt-account-of': '是…的小号',
};
const SENTIMENT_ZH: Record<string, string> = {
  positive: '积极',
  negative: '消极',
  neutral: '中性',
  mixed: '复杂',
};
const HIERARCHY_ZH: Record<string, string> = {
  superior: '高位（from 高于 to）',
  peer: '平级',
  subordinate: '低位（from 低于 to）',
  unknown: '未知',
};
/** 渲染 "中文（英文）"；中文映射缺失时仅显示英文。 */
function bilingual(en: string | undefined, map: Record<string, string>): string {
  if (!en) return '';
  const zh = map[en];
  return zh ? `${zh}（${en}）` : en;
}
/** 根据 kind 决定 role 应该走人-事件还是人-实体的中文表。 */
function roleLabel(kind: string | undefined, role: string | undefined): string {
  if (!role) return '';
  if (kind === 'person-event') return bilingual(role, PERSON_EVENT_ROLE_ZH);
  if (kind === 'person-entity') return bilingual(role, PERSON_ENTITY_ROLE_ZH);
  return role;
}

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
    style: { 'line-color': '#34d399', 'target-arrow-color': '#34d399', 'line-style': 'dashed' },
  },
  {
    selector: 'edge[kind = "event-event"]',
    style: { 'line-color': '#f472b6', 'target-arrow-color': '#f472b6', width: 2 },
  },
  {
    selector: 'edge[kind = "event-entity"]',
    style: { 'line-color': '#06b6d4', 'target-arrow-color': '#06b6d4', 'line-style': 'dashed' },
  },
  {
    selector: 'edge[kind = "entity-entity"]',
    style: { 'line-color': '#a855f7', 'target-arrow-color': '#a855f7' },
  },
  {
    selector: 'edge[kind = "person-person"]',
    style: { 'line-color': '#f87171', 'target-arrow-color': '#f87171', width: 2 },
  },
  {
    selector: 'edge[focused = "1"]',
    style: {
      'line-color': '#facc15',
      'target-arrow-color': '#facc15',
      width: 4,
      'overlay-color': '#facc15',
      'overlay-opacity': 0.25,
      'overlay-padding': 5,
      'z-index': 9999,
    },
  },
  {
    selector: 'edge.dimmed',
    style: { opacity: 0.15 },
  },
  {
    selector: 'node.dimmed',
    style: { opacity: 0.2, 'text-opacity': 0 },
  },
];

interface Props {
  comp: WebuiGraphComponent;
  pluginName: string;
  refreshTick?: number;
  /** 同页其它组件（如 stat）的刷新回调；按下「刷新」/执行 action 时一并 bump 全页，避免规模数字与图脱节 */
  onRefresh?: () => void;
}

export function RelationGraph({ comp, pluginName, refreshTick, onRefresh }: Props): JSX.Element {
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
  // 详情卡片折叠态：collapsed=true 时只显示一个 header 条，不挡画面；焦点高亮保持。
  // 关闭（✕）按钮仍然 = 退出焦点 + 清卡片，与之前一致。
  const [detailCollapsed, setDetailCollapsed] = useState(false);

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
          focusEdge: res.focusEdge,
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
      // 单击节点 = 设为焦点（同时显示详情），触发 fetchGraph 做服务端子图过滤
      setFocusId(String(data.id));
    });
    // 点击边 = 把焦点设为该边（后端会回传 focusEdge 详情 + 两端 1 跳邻域）
    cy.on('tap', 'edge', (e: EventObject) => {
      const edgeId = e.target.id();
      if (typeof edgeId === 'string' && edgeId) {
        setSelectedNode(null);
        setFocusId(edgeId);
      }
    });
    // 注意：故意不监听「点击空白处」清焦点，避免：
    // (1) 误点空白导致全图强制刷新丢失布局；
    // (2) 焦点态下拖拽画布时被识别为 tap 触发清焦点。
    // 清除焦点请通过工具栏「✕ 清除焦点」按钮。

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
    // 同名 person 消歧：同 displayName 出现 ≥ 2 次时，在 label 后追加 `· {platform}:…{tail}`
    // 仅 person 节点处理；不同名节点保持原 label，避免噪声。
    const personLabelCount = new Map<string, number>();
    for (const n of payload.nodes) {
      if (n.data.kind !== 'person') continue;
      const lbl = typeof n.data.label === 'string' ? n.data.label : '';
      if (!lbl) continue;
      personLabelCount.set(lbl, (personLabelCount.get(lbl) ?? 0) + 1);
    }
    const disambigLabel = (data: GraphNode['data']): string | undefined => {
      if (data.kind !== 'person') return undefined;
      const lbl = typeof data.label === 'string' ? data.label : '';
      if (!lbl) return undefined;
      if ((personLabelCount.get(lbl) ?? 0) < 2) return undefined;
      const platform = typeof data.platform === 'string' ? data.platform : '?';
      const uid = typeof data.userId === 'string' ? data.userId : '';
      const tail = uid ? `…${uid.slice(-4)}` : (typeof data.id === 'string' ? `…${data.id.slice(-4)}` : '?');
      return `${lbl} · ${platform}:${tail}`;
    };
    const elements: ElementDefinition[] = [
      ...payload.nodes.map(n => {
        const dis = disambigLabel(n.data);
        return {
          data: {
            ...n.data,
            ...(dis ? { label: dis } : {}),
            focused: focusedId && n.data.id === focusedId ? '1' : undefined,
          },
          group: 'nodes' as const,
        };
      }),
      ...payload.edges.map(e => {
        // 边 label 仅显示 role / relationType 等基础信息；description 不再拼接到 label 上
        //（避免画面拥挤；description 会在节点详情面板/边 hover tooltip 中展示）
        const baseLabel = typeof e.data.label === 'string' ? e.data.label : '';
        return {
          data: {
            ...e.data,
            label: baseLabel,
            kind: e.data.kind ?? (e.data.relationType ? 'person-person' : 'person-event'),
            focused: focusedId && e.data.id === focusedId ? '1' : undefined,
          },
          group: 'edges' as const,
        };
      }),
    ];

    cy.elements().remove();
    cy.add(elements);
    cy.layout({
      name: 'fcose',
      animate: false,
      randomize: payload.nodes.length > 20,
      // 降低节点重叠：加大排斥 + 加长理想边长 + 减小重力（不把节点都吸到中心）
      nodeRepulsion: 14000,
      idealEdgeLength: 120,
      nodeSeparation: 80,
      gravity: 0.1,
      gravityRange: 3.0,
      padding: 40,
      // 'proof' 比默认 'default' 收敛更彻底（耗时稍长，节点数 < ~200 时不明显）
      quality: 'proof',
      uniformNodeDimensions: false,
    } as cytoscape.LayoutOptions).run();
  }, [payload, focusId]);

  // 搜索高亮 / dim。规则（见 README/相关讨论）：
  //  - 空格分隔的多关键词，AND 语义（所有 token 都必须命中）；
  //  - 每个 token 不区分大小写，对 label 或 type 做子串匹配；
  //    （不参与 id —— id 多为 platform:userId，容易误命中）；
  //  - 边：任一端命中则保留，否则 dim；
  //  - 清空 / 零匹配：移除所有 dim，全图恢复可见；
  //  - 不再阻塞 composition：某些 IME 删除时不发 compositionend，
  //    若守门会把 effect 整段跳过，造成「全图卡死变灰 + 删字不扩展」。
  //    拼音中间态可能造成一瞬闪烁，但 IME 完成后会自动归位，可接受。
  //  - deps 加 payload：刷图后节点重建需重新应用 dim。
  // 搜索高亮 / dim。规则（见 README/相关讨论）：
  //  - 空格分隔的多关键词，AND 语义（所有 token 都必须命中）；
  //  - 每个 token 不区分大小写，对节点的 label / kind / entityKind / category
  //    任一字段做子串匹配；
  //    （不参与 id —— id 多为 platform:userId，容易误命中）；
  //  - 边：任一端命中则保留，否则 dim；
  //  - 清空 / 零匹配：移除所有 dim，全图恢复可见；
  //  - 不再阻塞 composition：某些 IME 删除时不发 compositionend，
  //    若守门会把 effect 整段跳过，造成「全图卡死变灰 + 删字不扩展」。
  //    拼音中间态可能造成一瞬闪烁，但 IME 完成后会自动归位，可接受。
  //  - deps 加 payload：刷图后节点重建需重新应用 dim。
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const tokens = search
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    // 先一律清除上轮的 dim，避免“残留 dim 造成全图变灰”。
    cy.elements().removeClass('dimmed');
    if (tokens.length === 0) return;
    const matched = cy.nodes().filter(n => {
      const fields = [
        String(n.data('label') ?? ''),
        String(n.data('kind') ?? ''), // person / event / entity
        String(n.data('entityKind') ?? ''), // work / place / ...
        String(n.data('category') ?? ''), // event category
      ].map(s => s.toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
    // 零匹配：保持全图可见，不 dim。
    if (matched.length === 0) return;
    const matchedIds = new Set(matched.map(n => n.id()));
    cy.nodes().forEach(n => {
      if (!matchedIds.has(n.id())) n.addClass('dimmed');
    });
    cy.edges().forEach(e => {
      const ok = matchedIds.has(e.source().id()) || matchedIds.has(e.target().id());
      if (!ok) e.addClass('dimmed');
    });
  }, [search, payload]);

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

  // ── 焦点卡片显隐 / 焦点变化 → 通知 cytoscape 重新计算视口 ──
  // 否则会出现「鼠标点击位置与画布坐标偏移」的诡异 bug（画布尺寸变了 cy 不知道）
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    // 下一帧执行，等待 DOM 已经 reflow
    const raf = requestAnimationFrame(() => {
      cy.resize();
      cy.fit(undefined, 30);
    });
    return () => cancelAnimationFrame(raf);
  }, [focusId, selectedNode]);

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
  // 触发 onRefresh（若提供）以同步刷新页面上的 stat 等组件；fallback 到本地 fetchGraph。
  const triggerRefresh = useCallback(() => {
    if (onRefresh) onRefresh();
    else fetchGraph();
  }, [onRefresh, fetchGraph]);
  const runAction = useCallback(
    async (method: string, confirmText?: string) => {
      if (confirmText && !window.confirm(confirmText)) return;
      try {
        await pageAction(pluginName, method, { focusId });
        triggerRefresh();
      } catch (e) {
        alert(`操作失败: ${(e as Error).message}`);
      }
    },
    [pluginName, focusId, triggerRefresh],
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
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
          <input
            type="text"
            placeholder="搜索 (label / kind / entityKind / category，空格分多关键词)"
            value={search}
            onChange={e => setSearch(e.target.value)}
            // compositionend 兜底：少数浏览器在 IME 结束时不再补发 onChange
            onCompositionEnd={e => setSearch((e.target as HTMLInputElement).value)}
            style={{ width: '100%', padding: '4px 24px 4px 8px' }}
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              title="清除搜索"
              style={{
                position: 'absolute',
                right: 4,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted, #888)',
                cursor: 'pointer',
                fontSize: 14,
                padding: '0 4px',
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          ) : null}
        </div>
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
          style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: focusId ? 1 : 0.45 }}
          title={focusId ? '焦点模式：每个节点向外展开的邻居数上限（按边权重降序截断；0 = 不限）' : '宽度仅在选定焦点后生效：点击图中任一节点即可设为焦点'}
        >
          宽度
          <input
            type="range"
            min={0}
            max={30}
            value={maxBreadth}
            onChange={e => setMaxBreadth(Number(e.target.value))}
            disabled={!focusId}
          />
          <input
            type="number"
            min={0}
            value={maxBreadth}
            onChange={e => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) setMaxBreadth(n);
            }}
            disabled={!focusId}
            style={{ width: 56, padding: '2px 4px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--surface-active)' }}
          />
          <span style={{ width: 32, color: 'var(--text-secondary)' }}>{maxBreadth === 0 ? '∞' : maxBreadth}</span>
        </label>
        {focusId ? (
          <button
            type="button"
            onClick={() => {
              setFocusId(undefined);
              setSelectedNode(null);
            }}
            style={{ padding: '4px 8px' }}
            title="清除焦点，返回全图视图"
          >
            ✕ 清除焦点
          </button>
        ) : null}
        <button type="button" onClick={triggerRefresh} disabled={loading} style={{ padding: '4px 8px' }}>
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
        <div style={{ position: 'relative', flex: 1 }}>
          <div ref={containerRef} style={canvasStyle} />
          {(selectedNode || (focusId && payload?.focusEdge)) ? (
            <div
              style={{
                position: 'absolute',
                top: 10,
                left: 10,
                width: detailCollapsed ? 'auto' : 360,
                maxWidth: 'calc(100% - 20px)',
                maxHeight: detailCollapsed ? undefined : graphHeight - 20,
                overflowY: detailCollapsed ? 'visible' : 'auto',
                padding: detailCollapsed ? '4px 8px' : '10px 12px',
                background: 'rgba(28, 28, 40, 0.94)',
                color: TEXT_COLOR,
                border: `1px solid ${FOCUS_COLOR}`,
                borderRadius: 6,
                fontSize: 11,
                boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                pointerEvents: 'auto',
                zIndex: 5,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 8, marginBottom: detailCollapsed ? 0 : 6 }}>
                <button
                  type="button"
                  onClick={() => setDetailCollapsed(c => !c)}
                  style={{ background: 'none', border: 0, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1, width: 16 }}
                  title={detailCollapsed ? '展开详情' : '收起详情（保留焦点）'}
                  aria-label={detailCollapsed ? '展开' : '收起'}
                >
                  {detailCollapsed ? '▸' : '▾'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFocusId(undefined);
                    setSelectedNode(null);
                    setDetailCollapsed(false);
                  }}
                  style={{ background: 'none', border: 0, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
                  title="关闭（清焦点）"
                  aria-label="关闭"
                >
                  ✕
                </button>
                <strong style={{ color: FOCUS_COLOR }}>
                  {selectedNode
                    ? `${selectedNode.data.kind ?? '节点'}：${selectedNode.data.label ?? selectedNode.data.id}`
                    : '焦点（边）'}
                </strong>
                <span style={{ marginLeft: 'auto' }}>
                  <FieldGlossary />
                </span>
              </div>
              {detailCollapsed ? null : selectedNode ? (
                <NodeDetailCard
                  node={selectedNode}
                  detail={detail}
                  loading={detailLoading}
                  hasDetailSource={Boolean(comp.detailSource)}
                  isFocus={focusId === selectedNode.data.id}
                />
              ) : payload?.focusEdge ? (() => {
                const fe = payload.focusEdge;
                const fmt = (ts?: number): string => {
                  if (!ts || !Number.isFinite(ts)) return '—';
                  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch { return String(ts); }
                };
                const nodeOf = (id: string): { label?: string; kind?: string; lastPageRank?: number } | undefined => {
                  const n = payload.nodes.find(x => x.data.id === id);
                  if (!n) return undefined;
                  const pr = n.data.lastPageRank;
                  return {
                    label: typeof n.data.label === 'string' ? n.data.label : undefined,
                    kind: typeof n.data.kind === 'string' ? n.data.kind : undefined,
                    lastPageRank: typeof pr === 'number' && Number.isFinite(pr) ? pr : undefined,
                  };
                };
                const endpoints = fe.endpoints ?? [];
                // 边综合分：weight · ((PR_from + PR_to) / 2)。淘汰阶段按此升序删（分越低越先删）。
                const endpointPRs = endpoints.map(eid => nodeOf(eid)?.lastPageRank).filter((x): x is number => typeof x === 'number');
                const avgPR = endpointPRs.length > 0 ? endpointPRs.reduce((a, b) => a + b, 0) / endpointPRs.length : undefined;
                const evictionScore = typeof fe.weight === 'number' && typeof avgPR === 'number' ? fe.weight * avgPR : undefined;
                return (
                  <>
                    <div style={{ marginBottom: 6, fontSize: 10, color: 'var(--text-secondary)' }}>
                      id={fe.id}
                    </div>
                    <div style={{ marginBottom: 6 }}>{fe.description ?? '(无描述)'}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 3, color: 'var(--text-secondary)', marginBottom: 8 }}>
                      <span>kind</span><span>{bilingual(fe.kind, EDGE_KIND_ZH)}{fe.directed === true ? ' · 有向' : fe.directed === false ? ' · 无向' : ''}</span>
                      {fe.relation ? (<><span>relation</span><span>{bilingual(fe.relation, PERSON_RELATION_ZH)}</span></>) : null}
                      {fe.role ? (<><span>role</span><span>{roleLabel(fe.kind, fe.role)}</span></>) : null}
                      {fe.sentiment ? (<><span>sentiment</span><span>{bilingual(fe.sentiment, SENTIMENT_ZH)}</span></>) : null}
                      {typeof fe.weight === 'number' ? (
                        <>
                          <span title="边按 (kind, source, target[, role/relation]) 重复合并的累计强度：0.5 起步，每次合并 +0.3 → 0.65 → 0.755 → … (clamp 1.0)。语义=被强化次数，不是重要性。" style={{ cursor: 'help' }}>合并强度</span>
                          <span>{fe.weight.toFixed(2)}</span>
                        </>
                      ) : null}
                      {typeof evictionScore === 'number' ? (
                        <>
                          <span title="边淘汰分 = 合并强度 × 端点 PR 平均。配额淘汰时按此升序删——分越低越先删。让「弱权但连接重要节点」的边受保护。" style={{ cursor: 'help' }}>边淘汰分</span>
                          <span>{evictionScore.toFixed(5)} <span style={{ opacity: 0.6 }}>= {fe.weight!.toFixed(2)} × {avgPR!.toFixed(4)}</span></span>
                        </>
                      ) : null}
                      <span>first</span><span>{fmt(fe.firstSeenAt)}</span>
                      <span>last</span><span>{fmt(fe.lastReinforcedAt)}</span>
                    </div>
                    {endpoints.length > 0 ? (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>端点</div>
                        {endpoints.map(eid => {
                          const n = nodeOf(eid);
                          const pr = typeof n?.lastPageRank === 'number' ? ` · PR ${n.lastPageRank.toFixed(4)}` : '';
                          return (
                            <div key={eid} style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)' }}>
                              {n?.label ?? eid} <span style={{ opacity: 0.6 }}>[{String(n?.kind ?? '?')}]{pr}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>证据 {fe.evidence?.length ?? 0} 条</div>
                    {(fe.evidence ?? []).map((ev, i) => (
                      <div
                        key={`${ev.messageIds?.join(',') ?? i}-${ev.extractedAt ?? i}`}
                        style={{ borderLeft: '2px solid var(--border-color, #2a2a42)', padding: '2px 6px', marginBottom: 4, color: 'var(--text-secondary)', lineHeight: 1.4 }}
                      >
                        <div>「{ev.quote ?? '(无摘录)'}」</div>
                        <div style={{ fontSize: 10, opacity: 0.7 }}>
                          {ev.extractedAt ? fmt(ev.extractedAt) : '—'}
                          {ev.sessionId ? ` · ${ev.sessionId}` : ''}
                          {ev.messageIds?.length ? ` · ${ev.messageIds.length} msg` : ''}
                        </div>
                      </div>
                    ))}
                    <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>
                      子图 节点 {payload.nodes.length} · 边 {payload.edges.length}
                    </div>
                  </>
                );
              })() : null}
            </div>
          ) : null}
        </div>
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

      {/* 图例：节点形状/颜色含义 */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          padding: '4px 10px',
          fontSize: 11,
          color: 'var(--text-secondary)',
          background: 'var(--bg-secondary)',
          borderTop: '1px solid var(--border-color, #2a2a42)',
        }}
      >
        <LegendItem shape="circle" color={PERSON_COLOR} label="人物" />
        <LegendItem shape="round-rect" color={EVENT_COLOR} label="事件" />
        <LegendItem shape="diamond" color={ENTITY_COLORS.topic} label="话题" />
        <LegendItem shape="diamond" color={ENTITY_COLORS.place} label="地点" />
        <LegendItem shape="diamond" color={ENTITY_COLORS.thing} label="事物" />
        <LegendItem shape="diamond" color={ENTITY_COLORS.work} label="作品" />
        <LegendItem shape="circle" color={FOCUS_COLOR} label="焦点" />
        <span style={{ width: 1, height: 12, background: 'var(--border-color, #2a2a42)', margin: '0 4px' }} />
        <LegendEdge color="#f87171" dashStyle="solid" label="人↔人" />
        <LegendEdge color="#34d399" dashStyle="dashed" label="人→实体" />
        <LegendEdge color="#fbbf24" dashStyle="dashed" label="人→事" />
        <LegendEdge color="#a855f7" dashStyle="solid" label="实体↔实体" />
        <LegendEdge color="#06b6d4" dashStyle="dashed" label="事→实体" />
        <LegendEdge color="#f472b6" dashStyle="solid" label="事→事" />
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>点击节点 = 设为焦点 + 显示左上详情卡片；清除焦点请点工具栏「✕ 清除焦点」按钮</span>
      </div>

      <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
        {statsText || '—'}
      </div>
    </div>
  );
}

function LegendItem({ shape, color, label }: { shape: 'circle' | 'round-rect' | 'diamond'; color: string; label: string }): JSX.Element {
  const base: CSSProperties = { width: 12, height: 12, background: color, display: 'inline-block', verticalAlign: 'middle' };
  let shapeStyle: CSSProperties;
  if (shape === 'circle') shapeStyle = { ...base, borderRadius: '50%' };
  else if (shape === 'round-rect') shapeStyle = { ...base, width: 16, height: 10, borderRadius: 3 };
  else shapeStyle = { ...base, transform: 'rotate(45deg)' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={shapeStyle} />
      {label}
    </span>
  );
}

function LegendEdge({ color, dashStyle, label }: { color: string; dashStyle: 'solid' | 'dashed' | 'dotted'; label: string }): JSX.Element {
  const borderStyle = dashStyle === 'solid' ? 'solid' : dashStyle === 'dashed' ? 'dashed' : 'dotted';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 18, height: 0, borderTop: `2px ${borderStyle} ${color}`, display: 'inline-block' }} />
      {label}
    </span>
  );
}

// ── 节点详情卡片：把 detailSource 返回的 person/event/entity 字段化展示 ──────
type DetailRecord = Record<string, unknown>;

function fmtTs(ts: unknown): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch { return String(ts); }
}
function pickText(d: DetailRecord, key: string): string | undefined {
  const v = d[`${key}Text`] ?? d[key];
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return fmtTs(v);
  return undefined;
}
function asStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

interface FieldGridProps { rows: Array<[string, string | number | undefined | null] | [string, string | number | undefined | null, string]>; }
function FieldGrid({ rows }: FieldGridProps): JSX.Element {
  const visible = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (visible.length === 0) return <></>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 3, color: 'var(--text-secondary)', marginBottom: 8 }}>
      {visible.map(row => {
        const [k, v, tip] = row;
        return (
          <React.Fragment key={k}>
            <span style={{ color: 'var(--text-muted)', cursor: tip ? 'help' : undefined }} title={tip}>{k}</span>
            <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{String(v)}</span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

interface EvidenceItem {
  quote?: string;
  messageIds?: string[];
  sessionId?: string;
  extractedAt?: number;
  extractedAtText?: string;
}
function EvidenceList({ list }: { list: EvidenceItem[] }): JSX.Element {
  if (!list || list.length === 0) return <></>;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>证据 {list.length} 条</div>
      {list.map((ev, i) => (
        <div
          key={`${ev.messageIds?.join(',') ?? i}-${ev.extractedAt ?? i}`}
          style={{ borderLeft: '2px solid var(--border-color, #2a2a42)', padding: '2px 6px', marginBottom: 4, color: 'var(--text-secondary)', lineHeight: 1.4 }}
        >
          <div>「{ev.quote ?? '(无摘录)'}」</div>
          <div style={{ fontSize: 10, opacity: 0.7 }}>
            {ev.extractedAtText ?? fmtTs(ev.extractedAt)}
            {ev.sessionId ? ` · ${ev.sessionId}` : ''}
            {ev.messageIds?.length ? ` · ${ev.messageIds.length} msg` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

interface NodeDetailCardProps {
  node: GraphNode;
  detail: DetailRecord | null;
  loading: boolean;
  hasDetailSource: boolean;
  isFocus: boolean;
}
/**
 * 字段含义入口：点击弹出 modal，内含三大数值指标解释 + 六类边 / 角色 / 关系
 * 的中英对照（与 docs/plugins/user-relation-graph.md 对齐）。
 *
 * 为什么走 modal 而不是 `<details>`：
 * - 内容已经从"3 行 weight/PR/边淘汰"扩到"6 类边 + 12 个角色 + 10 个关系"，
 *   塞 inline 会撑爆 320px 宽的侧边详情卡。
 * - 多个 NodeDetailCard / 边详情都引用同一个组件，modal 单实例切换更清爽。
 */
function FieldGlossary(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          background: 'none',
          border: 0,
          padding: 0,
          cursor: 'help',
          color: 'var(--text-muted)',
          fontSize: 11,
          textDecoration: 'underline dotted',
        }}
        title="字段含义说明"
      >
        ⓘ 字段含义
      </button>
      {open ? <FieldGlossaryModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function FieldGlossaryModal({ onClose }: { onClose: () => void }): JSX.Element {
  // 简易模态：固定全屏遮罩 + 居中卡片。点遮罩 / Esc / ✕ 都能关。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const row: CSSProperties = { display: 'grid', gridTemplateColumns: '120px 1fr', columnGap: 12, rowGap: 4, fontSize: 12 };
  const h: CSSProperties = { margin: '12px 0 4px', fontSize: 13, color: 'var(--text-primary, #e4e4ef)' };
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-primary, #0f0f14)',
          color: 'var(--text-primary, #e4e4ef)',
          border: '1px solid var(--border-color, #2a2a42)',
          borderRadius: 8,
          padding: '16px 20px',
          width: 'min(680px, 92vw)',
          maxHeight: '82vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          lineHeight: 1.55,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>关系图字段含义</strong>
          <button
            type="button"
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 0, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 16 }}
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>

        <div style={h}>三个数值指标</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          <div><b>合并强度</b>（weight, 0~1）：节点 / 边被重复合并的累计程度。0.5 起步，每次合并 <code>+(1-prev)·0.3</code> → 0.65 → 0.755 → 0.829 → … (clamp 1.0)。<u>语义 = 被强化次数，<b>不是</b>重要性</u>。</div>
          <div style={{ marginTop: 3 }}><b>图重要性</b>（lastPageRank）：最近一次 <code>/relation compress | maintain</code> 计算的全图 PageRank。个性化种子按 kind 加权（人 3 · 物 2 · 事 1）。越高越靠近"核心人物 · 热门事件"。未跑过压缩则为空。</div>
          <div style={{ marginTop: 3 }}><b>边淘汰分</b>（仅边详情）：<code>合并强度 × ((PR_from + PR_to) / 2)</code>。配额淘汰时按此<u>升序</u>删——分越低越先删，让"弱权但连接重要节点"的边受保护。</div>
        </div>

        <div style={h}>边 kind（六类）</div>
        <div style={row}>
          {Object.entries(EDGE_KIND_ZH).map(([en, zh]) => (
            <React.Fragment key={en}>
              <code style={{ color: 'var(--text-muted)' }}>{en}</code>
              <span>{zh}</span>
            </React.Fragment>
          ))}
        </div>

        <div style={h}>role · 人 → 事件</div>
        <div style={row}>
          {Object.entries(PERSON_EVENT_ROLE_ZH).map(([en, zh]) => (
            <React.Fragment key={en}>
              <code style={{ color: 'var(--text-muted)' }}>{en}</code>
              <span>{zh}</span>
            </React.Fragment>
          ))}
        </div>

        <div style={h}>role · 人 → 物</div>
        <div style={row}>
          {Object.entries(PERSON_ENTITY_ROLE_ZH).map(([en, zh]) => (
            <React.Fragment key={en}>
              <code style={{ color: 'var(--text-muted)' }}>{en}</code>
              <span>{zh}</span>
            </React.Fragment>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          注：单句态度声明（"我喜欢 X"）不在关系图记录，归 user-profile 画像层。
        </div>

        <div style={h}>relation · 人 → 人</div>
        <div style={row}>
          {Object.entries(PERSON_RELATION_ZH).map(([en, zh]) => (
            <React.Fragment key={en}>
              <code style={{ color: 'var(--text-muted)' }}>{en}</code>
              <span>{zh}</span>
            </React.Fragment>
          ))}
        </div>

        <div style={h}>sentiment</div>
        <div style={row}>
          {Object.entries(SENTIMENT_ZH).map(([en, zh]) => (
            <React.Fragment key={en}>
              <code style={{ color: 'var(--text-muted)' }}>{en}</code>
              <span>{zh}</span>
            </React.Fragment>
          ))}
        </div>

        <div style={h}>hierarchy（人 → 人，与 directed 正交）</div>
        <div style={row}>
          {Object.entries(HIERARCHY_ZH).map(([en, zh]) => (
            <React.Fragment key={en}>
              <code style={{ color: 'var(--text-muted)' }}>{en}</code>
              <span>{zh}</span>
            </React.Fragment>
          ))}
        </div>

        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-muted)' }}>
          完整文档：<code>docs/plugins/user-relation-graph.md</code>
        </div>
      </div>
    </div>
  );
}
function NodeDetailCard({ node, detail, loading, hasDetailSource, isFocus }: NodeDetailCardProps): JSX.Element {
  const kind = node.data.kind;
  const headerMeta = (
    <div style={{ color: 'var(--text-secondary)', marginBottom: 8, fontSize: 10 }}>
      id={node.data.id}
      {isFocus ? <span style={{ marginLeft: 6, color: FOCUS_COLOR }}>· 当前焦点</span> : null}
    </div>
  );
  if (loading) return <>{headerMeta}<div style={{ color: 'var(--text-muted)' }}>加载详情中…</div></>;
  if (!hasDetailSource) return <>{headerMeta}<div style={{ color: 'var(--text-muted)' }}>无详情（detailSource 未配置）</div></>;
  if (!detail) return <>{headerMeta}<div style={{ color: 'var(--text-muted)' }}>无数据</div></>;
  if (typeof detail.error === 'string') {
    return <>{headerMeta}<div style={{ color: '#dc2626' }}>错误: {detail.error}</div></>;
  }

  // 人物
  if (kind === 'person' && detail.person && typeof detail.person === 'object') {
    const p = detail.person as DetailRecord;
    const rows: Array<[string, string | number | undefined] | [string, string | number | undefined, string]> = [
      ['昵称', asStr(p.displayName)],
      ['平台', asStr(p.platform)],
      ['用户 ID', asStr(p.userId)],
      ['提及次数', asNum(p.mentionCount)],
      [
        '图重要性',
        typeof p.lastPageRank === 'number' ? (p.lastPageRank as number).toFixed(4) : undefined,
        '最近一次 evictByQuota 计算的全图 PageRank 分数。人/物/事 个性化种子 3:2:1；该节点越靠近「核心人物 · 热门事件」越高。未跑过压缩时为空。',
      ],
      ['首次出现', pickText(p, 'firstSeenAt')],
      ['最近出现', pickText(p, 'lastSeenAt')],
      ['最近提及', pickText(p, 'lastMentionedAt')],
      ['关联事件', asNum(detail.eventCount)],
      ['关联边数', asNum(detail.edgeCount)],
    ];
    const recent = Array.isArray(detail.recentEvents) ? (detail.recentEvents as DetailRecord[]) : [];
    const edges = Array.isArray(detail.edges) ? (detail.edges as DetailRecord[]) : [];
    return (
      <>
        {headerMeta}
        <FieldGrid rows={rows} />
        {recent.length > 0 ? (
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>近期事件 {recent.length}</div>
            {recent.slice(0, 8).map((ev, i) => (
              <div key={asStr(ev.id) ?? i} style={{ color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                · {asStr(ev.title) ?? '(无标题)'}
                {asStr(ev.category) ? <span style={{ opacity: 0.6 }}> [{asStr(ev.category)}]</span> : null}
              </div>
            ))}
          </div>
        ) : null}
        {edges.length > 0 ? (
          <div>
            <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>边 {edges.length}</div>
            {edges.slice(0, 12).map((e, i) => {
              const w = typeof e.weight === 'number' ? ` w=${(e.weight as number).toFixed(1)}` : '';
              const label = asStr(e.relationZh) ?? asStr(e.roleZh) ?? asStr(e.relationType) ?? asStr(e.role) ?? asStr(e.kind) ?? '?';
              const target = asStr(e.targetLabel) ?? asStr(e.toEntityId) ?? asStr(e.toEventId) ?? asStr(e.toPersonId) ?? '';
              return (
                <div key={asStr(e.id) ?? i} style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)' }}>
                  {label}{w} → {target}
                </div>
              );
            })}
          </div>
        ) : null}
      </>
    );
  }

  // 事件
  if (kind === 'event') {
    const rows: Array<[string, string | number | undefined] | [string, string | number | undefined, string]> = [
      ['标题', asStr(detail.title)],
      ['类别', asStr(detail.category)],
      ['摘要', asStr(detail.summary)],
      ['提及次数', asNum(detail.mentionCount)],
      [
        '合并强度',
        typeof detail.weight === 'number' ? (detail.weight as number).toFixed(2) : undefined,
        '按 title 重复合并的累计强度：0.5 起步，每次合并 +0.3 (clamp 1.0)。语义 = 被强化次数，不是重要性。',
      ],
      [
        '图重要性',
        typeof detail.lastPageRank === 'number' ? (detail.lastPageRank as number).toFixed(4) : undefined,
        '最近一次 evictByQuota 计算的全图 PageRank 分数。反映"被重要节点引用"的结构性重要性；与合并强度独立。',
      ],
      ['首次出现', pickText(detail, 'firstSeenAt')],
      ['最近强化', pickText(detail, 'lastReinforcedAt')],
      ['证据数', asNum(detail.evidenceCount)],
    ];
    const evidence = Array.isArray(detail.evidence) ? (detail.evidence as EvidenceItem[]) : [];
    return <>{headerMeta}<FieldGrid rows={rows} /><EvidenceList list={evidence} /></>;
  }

  // 实体
  if (kind === 'entity') {
    const aliases = Array.isArray(detail.aliases) ? (detail.aliases as unknown[]).filter(x => typeof x === 'string').join(' / ') : undefined;
    const rows: Array<[string, string | number | undefined] | [string, string | number | undefined, string]> = [
      ['名称', asStr(detail.name)],
      ['类型', asStr(detail.entityKind)],
      ['别名', aliases || undefined],
      ['摘要', asStr(detail.summary)],
      [
        '合并强度',
        typeof detail.weight === 'number' ? (detail.weight as number).toFixed(2) : undefined,
        '按 (kind, name) 重复合并的累计强度：0.5 起步，每次合并 +0.3 (clamp 1.0)。语义 = 被强化次数，不是重要性。',
      ],
      [
        '图重要性',
        typeof detail.lastPageRank === 'number' ? (detail.lastPageRank as number).toFixed(4) : undefined,
        '最近一次 evictByQuota 计算的全图 PageRank 分数。多人共同指向的实体一般分数更高。',
      ],
      ['首次出现', pickText(detail, 'firstSeenAt')],
      ['最近强化', pickText(detail, 'lastReinforcedAt')],
      ['证据数', asNum(detail.evidenceCount)],
    ];
    const evidence = Array.isArray(detail.evidence) ? (detail.evidence as EvidenceItem[]) : [];
    return <>{headerMeta}<FieldGrid rows={rows} /><EvidenceList list={evidence} /></>;
  }

  // 兜底
  return (
    <>
      {headerMeta}
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, margin: 0, color: 'var(--text)' }}>
        {JSON.stringify(detail, null, 2)}
      </pre>
    </>
  );
}
