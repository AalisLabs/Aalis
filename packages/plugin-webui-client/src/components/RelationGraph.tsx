import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import cytoscape, { type Core, type ElementDefinition, type EventObject } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { api, pageAction } from '../api';
import type { WebuiGraphComponent } from '../types';

// 注册一次 fcose 布局
let _fcoseRegistered = false;
function ensureFcose(): void {
  if (_fcoseRegistered) return;
  cytoscape.use(fcose);
  _fcoseRegistered = true;
}

/**
 * 自适应 PageRank 显示：
 * - PageRank 是「概率分布」，节点越多每个节点的值越小。100 个节点时人 PR 普遍在
 *   2e-3 ~ 5e-3 量级；预计扩展到上千节点时会进一步压缩到 1e-4 ~ 1e-5。
 * - 策略：|n| < 0.01 时切换到科学计数法（toExponential(2)，如 `2.07e-3`），可随节点
 *   数量增长无极限扩展精度；否则用 toPrecision(3) + 去尾零保留直观小数。
 */
function formatPR(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 0.01) return n.toExponential(2);
  const s = n.toPrecision(3);
  if (s.includes('e') || s.includes('E')) return s;
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
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
interface PrRankInfo { kindRank: number; kindTotal: number; globalRank: number; globalTotal: number }
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
  /** 全库 PageRank 排名表（基于服务端 fullSnap，与当前可见子图无关）。 */
  globalPrRanks?: Record<string, PrRankInfo>;
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

// 节点大小：按 pageRankScale（0~1，前端在构建 elements 时计算）线性映射到
//   person:  20 → 56 px
//   event:   24×16 → 64×40 px（宽高比固定 3:2）
//   entity:  22 → 60 px
// 边粗细：按 weightScale（0~1）线性映射到 1 → 6 px
// 这样 PageRank 越高的「关键人/物/事」节点越大、合并越强的边越粗，一眼看出权重。
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
      // 默认 person 尺寸（被下方 kind 选择器覆写）；mapData fallback：缺 pageRankScale 时取 0 → 最小值
      width: 'mapData(pageRankScale, 0, 1, 20, 56)' as unknown as number,
      height: 'mapData(pageRankScale, 0, 1, 20, 56)' as unknown as number,
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
      width: 'mapData(pageRankScale, 0, 1, 24, 64)' as unknown as number,
      height: 'mapData(pageRankScale, 0, 1, 16, 40)' as unknown as number,
    },
  },
  {
    selector: 'node[kind = "entity"]',
    style: {
      shape: 'diamond',
      'background-color': ENTITY_DEFAULT,
      'border-color': '#374151',
      width: 'mapData(pageRankScale, 0, 1, 22, 60)' as unknown as number,
      height: 'mapData(pageRankScale, 0, 1, 22, 60)' as unknown as number,
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
      // 边粗细按合并强度 weight 线性放大：弱关系 1px，强关系 6px
      width: 'mapData(weightScale, 0, 1, 1, 6)' as unknown as number,
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
    style: { 'line-color': '#f472b6', 'target-arrow-color': '#f472b6' },
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
    style: { 'line-color': '#f87171', 'target-arrow-color': '#f87171' },
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

/**
 * 内置样式 + 页面声明的自定义类别样式（nodeKinds/edgeKinds，后写覆盖内置）。
 *
 * 声明了 nodeKinds 的页面（如权限图）使用自己的 kind 语义，不冒用
 * 人物关系图的 person/event/entity 三类。
 */
function buildStylesheet(
  nodeKinds?: WebuiGraphComponent['nodeKinds'],
  edgeKinds?: WebuiGraphComponent['edgeKinds'],
): cytoscape.StylesheetJson {
  if (!nodeKinds?.length && !edgeKinds?.length) return stylesheet;
  const extra: cytoscape.StylesheetJson = [];
  for (const k of nodeKinds ?? []) {
    const style: Record<string, unknown> = {};
    if (k.color) {
      style['background-color'] = k.color;
      style['border-color'] = k.color;
    }
    if (k.shape) {
      style.shape = k.shape === 'circle' ? 'ellipse' : k.shape === 'round-rect' ? 'round-rectangle' : 'diamond';
    }
    extra.push({ selector: `node[kind = "${k.kind}"]`, style } as cytoscape.StylesheetJson[number]);
  }
  for (const e of edgeKinds ?? []) {
    const style: Record<string, unknown> = {};
    if (e.color) {
      style['line-color'] = e.color;
      style['target-arrow-color'] = e.color;
    }
    if (e.dashed) style['line-style'] = 'dashed';
    extra.push({ selector: `edge[kind = "${e.kind}"]`, style } as cytoscape.StylesheetJson[number]);
  }
  return [...stylesheet, ...extra];
}

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
  // 上一次 layout effect 使用的 payload 引用：用于判断本次重跑是「数据变化」还是「仅 spacing 变化」
  const lastLayoutPayloadRef = useRef<GraphPayload | null>(null);

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

  // hover tooltip：鼠标悬停节点 / 边时浮出，显示更完整的标题 / 摘要 / 所属会话等。
  // canvas 没有原生 title，所以用容器内 absolute 定位的 div 渲染。
  const [hoverTip, setHoverTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  // 布局密度（≈ fcose idealEdgeLength px），影响节点排布稀疏程度。
  //   优先级：localStorage（本机用户偏好） > 服务端 webui-server.relationGraphDefaultSpacing > 内置 120
  //   规则：UI 滑动时只更新 draft（即时显示数字），松手才 commit 到 spacing 触发 layout 重跑（动画过渡）
  //         同时把 commit 值写回 localStorage 作下次默认。
  const SPACING_STORAGE_KEY = 'aalis.relgraph.spacing';
  const SPACING_MIN = 60;
  // slider 上限；数字框不受此限制，允许手动输入任意正数。
  // commit 只作 min-clamp + 上限 SPACING_HARD_MAX 的安全护栏（避免 1e9 这种超大值冻死 layout）。
  const SPACING_SLIDER_MAX = 1000;
  const SPACING_HARD_MAX = 5000;
  const SPACING_FALLBACK = 120;
  const readSpacingFromStorage = (): number | undefined => {
    if (typeof window === 'undefined') return undefined;
    const raw = window.localStorage.getItem(SPACING_STORAGE_KEY);
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= SPACING_MIN && n <= SPACING_HARD_MAX ? n : undefined;
  };
  const [spacing, setSpacing] = useState<number>(() => readSpacingFromStorage() ?? SPACING_FALLBACK);
  const [spacingDraft, setSpacingDraft] = useState<number>(spacing);
  // 仅当用户没有本地覆盖时，才在拿到服务端默认值后采纳之
  useEffect(() => {
    if (readSpacingFromStorage() !== undefined) return;
    let cancelled = false;
    api<{ config?: { relationGraphDefaultSpacing?: number } }>(
      '/api/plugins/@aalis/plugin-webui-server/config',
    )
      .then(d => {
        if (cancelled) return;
        const v = Number(d?.config?.relationGraphDefaultSpacing);
        if (Number.isFinite(v) && v >= SPACING_MIN && v <= SPACING_HARD_MAX) {
          setSpacing(v);
          setSpacingDraft(v);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const commitSpacing = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    const v = Math.max(SPACING_MIN, Math.min(SPACING_HARD_MAX, Math.round(next)));
    setSpacing(v);
    setSpacingDraft(v);
    try {
      window.localStorage.setItem(SPACING_STORAGE_KEY, String(v));
    } catch {
      // 忽略 quota
    }
  }, []);

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
          // 全库 PR 排名表（服务端基于 fullSnap 计算）；漏了会让 NodeDetailCard 永久走"全库排名暂缺"兜底。
          globalPrRanks: res.globalPrRanks,
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
      style: buildStylesheet(comp.nodeKinds, comp.edgeKinds),
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

    // hover tooltip：节点/边的更完整信息（canvas 无原生 title，自己渲染）
    const buildTipLines = (data: Record<string, unknown>, isEdge: boolean): string[] => {
      const lines: string[] = [];
      const get = (k: string): string => {
        const v = data[k];
        return v == null ? '' : String(v);
      };
      if (isEdge) {
        const label = get('label');
        const role = get('role');
        const rel = get('relationType');
        if (label) lines.push(label);
        else if (role) lines.push(role);
        else if (rel) lines.push(rel);
        const desc = get('description');
        if (desc) lines.push(desc);
        const w = data.weight;
        if (typeof w === 'number') lines.push(`合并强度 ${w.toFixed(2)}`);
      } else {
        const kind = get('kind');
        const title = get('title') || get('name') || get('displayName') || get('label');
        if (title) lines.push(title);
        const cat = get('category') || get('entityKind');
        if (cat) lines.push(`类型：${cat}`);
        if (kind === 'event') {
          const scope = get('sessionScope');
          if (scope) lines.push(`会话：${scope}`);
        }
        const summary = get('summary');
        if (summary) lines.push(summary);
      }
      return lines;
    };
    const updateTipFromEvent = (e: EventObject, isEdge: boolean) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const data = e.target.data() as Record<string, unknown>;
      const lines = buildTipLines(data, isEdge);
      if (lines.length === 0 || !rect) return;
      const px = e.renderedPosition?.x ?? 0;
      const py = e.renderedPosition?.y ?? 0;
      setHoverTip({ x: px + 12, y: py + 12, lines });
    };
    cy.on('mouseover', 'node', e => updateTipFromEvent(e, false));
    cy.on('mouseover', 'edge', e => updateTipFromEvent(e, true));
    cy.on('mouseout', 'node', () => setHoverTip(null));
    cy.on('mouseout', 'edge', () => setHoverTip(null));
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

    // ─── 计算 pageRankScale ∈ [0,1]（按 kind 内的相对位置）──────────────────────
    // 用百分位排名而非线性归一化，避免极端值（个别 hub 的 PR 比中位高几个数量级）
    // 把绝大多数节点压缩到 0 附近。
    //   pageRankScale = 0 → 该 kind 内 PR 最低 / 缺失；映射到最小尺寸
    //   pageRankScale = 1 → 该 kind 内 PR 最高；映射到最大尺寸
    // 缺失 lastPageRank 视为 0（新节点）。
    const prByKind = new Map<string, Map<string, number>>();
    for (const n of payload.nodes) {
      const kind = String(n.data.kind ?? 'person');
      const pr = typeof n.data.lastPageRank === 'number' ? n.data.lastPageRank : 0;
      let m = prByKind.get(kind);
      if (!m) {
        m = new Map();
        prByKind.set(kind, m);
      }
      m.set(String(n.data.id), pr);
    }
    const prScaleByNodeId = new Map<string, number>();
    for (const [, m] of prByKind) {
      const sorted = [...m.entries()].sort((a, b) => a[1] - b[1]);
      const N = sorted.length;
      for (let i = 0; i < N; i++) {
        const scale = N > 1 ? i / (N - 1) : 0.5;
        prScaleByNodeId.set(sorted[i][0], scale);
      }
    }

    // ─── 计算 weightScale ∈ [0,1]（全图边按 weight 百分位）─────────────────────
    const weightScaleByEdgeId = new Map<string, number>();
    {
      const arr = payload.edges
        .map(e => ({ id: e.data.id, w: typeof e.data.weight === 'number' ? e.data.weight : 0 }))
        .sort((a, b) => a.w - b.w);
      const N = arr.length;
      for (let i = 0; i < N; i++) {
        weightScaleByEdgeId.set(arr[i].id, N > 1 ? i / (N - 1) : 0.5);
      }
    }

    const elements: ElementDefinition[] = [
      ...payload.nodes.map(n => {
        const dis = disambigLabel(n.data);
        const pageRankScale = prScaleByNodeId.get(String(n.data.id)) ?? 0;
        return {
          data: {
            ...n.data,
            ...(dis ? { label: dis } : {}),
            pageRankScale,
            focused: focusedId && n.data.id === focusedId ? '1' : undefined,
          },
          group: 'nodes' as const,
        };
      }),
      ...payload.edges.map(e => {
        // 边 label 仅显示 role / relationType 等基础信息；description 不再拼接到 label 上
        //（避免画面拥挤；description 会在节点详情面板/边 hover tooltip 中展示）
        const baseLabel = typeof e.data.label === 'string' ? e.data.label : '';
        const weightScale = weightScaleByEdgeId.get(e.data.id) ?? 0;
        return {
          data: {
            ...e.data,
            label: baseLabel,
            kind: e.data.kind ?? (e.data.relationType ? 'person-person' : 'person-event'),
            weightScale,
            focused: focusedId && e.data.id === focusedId ? '1' : undefined,
          },
          group: 'edges' as const,
        };
      }),
    ];

    // 仅 spacing 变化（payload 引用未变）时启用动画，让现有节点平滑滑到新位置；
    // payload 变化时不开动画，避免抖动。
    const isSpacingOnly = lastLayoutPayloadRef.current === payload;
    lastLayoutPayloadRef.current = payload;
    if (!isSpacingOnly) {
      cy.elements().remove();
      cy.add(elements);
    }
    cy.layout({
      name: 'fcose',
      animate: isSpacingOnly,
      animationDuration: 400,
      randomize: !isSpacingOnly && payload.nodes.length > 20,
      // 节点稀疏度由 spacing 线性驱动：
      //   idealEdgeLength = spacing
      //   nodeRepulsion   ≈ spacing * 117（120 -> 14000，对齐原默认）
      //   nodeSeparation  ≈ spacing * 0.67（120 -> 80）
      // 这样一根 slider 同时拉动三者，避免互相打架。
      //
      // 「重力分簇」：nodeRepulsion 改为函数式 —— 高 PR 节点斥力倍增（×1 ~ ×4），
      // 让重要 hub 互相推远、低 PR 卫星节点贴近它们，从而把图天然分成
      // 「以关键人/物/事为中心」的几个簇，便于一眼看出重点分布。
      // idealEdgeLength 也按边的 weightScale 缩短：合并强度越高的边越短，
      // 强联系的两端会靠得更近，弱联系会被拉远 → 进一步强化分簇感。
      nodeRepulsion: ((node: cytoscape.NodeSingular) => {
        const base = Math.round(spacing * 117);
        const s = Number(node.data('pageRankScale')) || 0;
        return Math.round(base * (1 + 3 * s));
      }) as unknown as number,
      idealEdgeLength: ((edge: cytoscape.EdgeSingular) => {
        const ws = Number(edge.data('weightScale')) || 0;
        // 强边短（spacing * 0.6），弱边长（spacing * 1.4）
        return Math.round(spacing * (1.4 - 0.8 * ws));
      }) as unknown as number,
      nodeSeparation: Math.round(spacing * 0.67),
      gravity: 0.1,
      gravityRange: 3.0,
      padding: 40,
      // 'proof' 比默认 'default' 收敛更彻底（耗时稍长，节点数 < ~200 时不明显）
      quality: 'proof',
      uniformNodeDimensions: false,
    } as cytoscape.LayoutOptions).run();
  }, [payload, focusId, spacing]);

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
        String(n.data('title') ?? ''), // 事件完整标题
        String(n.data('name') ?? ''), // 实体完整名
        String(n.data('displayName') ?? ''), // person 显示名
        String(n.data('summary') ?? ''), // 摘要（事件/实体）
        String(n.data('sessionScope') ?? ''), // 会话归属
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
    if (!cy || cy.elements().length === 0) return;
    // cy.png() 使用 drawElements 直接渲染到临时 canvas，而不是从屏幕 canvas 复制，
    // 因此 scale 会叠加 pxRatio（Retina 设备为 ×2），导致导出 canvas 尺寸翻倍。
    // 通过 maxWidth 传入任意值可令 specdMaxDims=true，从而跳过 pxRatio 乘法，
    // 使导出 scale 保持在 ×2 而非 ×4，避免大图超出浏览器 canvas 面积限制（尤其 Safari）。
    const dataUrl = cy.png({ full: true, scale: 2, bg: CANVAS_BG, maxWidth: Infinity });
    if (!dataUrl || dataUrl === 'data:,') return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `relation-graph-${Date.now()}.png`;
    // Firefox / Safari 需要 <a> 附加到 DOM 才能触发 download 属性的文件保存行为；
    // 不附加时 Safari 会直接在标签页打开 data URL 而非下载。
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
    if (!payload) return '';
    const labelMap: Record<string, string> = { persons: '人物', events: '事件', entities: '实体' };
    const viewParts = [`节点 ${payload.nodes.length}`, `边 ${payload.edges.length}`];
    const dbParts: string[] = [];
    for (const [k, v] of Object.entries(stats)) {
      if (k === 'edges') continue; // edges 与视图边重复，跳过
      dbParts.push(`${labelMap[k] ?? k} ${v}`);
    }
    const dbStr = dbParts.length ? `全库: ${dbParts.join(' · ')}` : '';
    return [...viewParts, ...(dbStr ? [dbStr] : [])].join('  |  ');
  }, [payload, stats]);

  /**
   * 子图 PR 排名查询表：仅基于当前可见 payload.nodes 计算（视图相对位置）。
   * 用户从某个 focusId+depth+breadth 进来时，子图节点可能远少于全库。
   * 与 `globalPrRanksByNodeId`（来自 payload.globalPrRanks，全库口径）配对展示。
   * 缺失 lastPageRank 的节点不入榜（未跑过 evictByQuota）。
   */
  const subgraphPrRanks = useMemo(() => {
    const m = new Map<string, PrRankInfo>();
    if (!payload) return m;
    type Entry = { id: string; kind: string; pr: number };
    const entries: Entry[] = [];
    for (const n of payload.nodes) {
      const pr = n.data.lastPageRank;
      if (typeof pr !== 'number' || !Number.isFinite(pr)) continue;
      entries.push({ id: String(n.data.id), kind: String(n.data.kind ?? 'person'), pr });
    }
    const globalSorted = [...entries].sort((a, b) => b.pr - a.pr);
    const globalTotal = globalSorted.length;
    const globalRankById = new Map<string, number>();
    for (let i = 0; i < globalSorted.length; i++) globalRankById.set(globalSorted[i].id, i + 1);
    const byKind = new Map<string, Entry[]>();
    for (const e of entries) {
      if (!byKind.has(e.kind)) byKind.set(e.kind, []);
      byKind.get(e.kind)!.push(e);
    }
    for (const [, arr] of byKind) {
      arr.sort((a, b) => b.pr - a.pr);
      for (let i = 0; i < arr.length; i++) {
        m.set(arr[i].id, {
          kindRank: i + 1,
          kindTotal: arr.length,
          globalRank: globalRankById.get(arr[i].id) ?? 0,
          globalTotal,
        });
      }
    }
    return m;
  }, [payload]);
  /** 全库 PR 排名查询表：直接读 payload.globalPrRanks（服务端 fullSnap 算好）。 */
  const globalPrRanksByNodeId = useMemo(() => {
    const m = new Map<string, PrRankInfo>();
    if (!payload?.globalPrRanks) return m;
    for (const [id, info] of Object.entries(payload.globalPrRanks)) m.set(id, info);
    return m;
  }, [payload]);

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
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          title={`布局密度（≈ 理想边长 px）。当前 ${spacingDraft}。\nslider 范围 ${SPACING_MIN}–${SPACING_SLIDER_MAX}；数字框可手动输入更大值（上限 ${SPACING_HARD_MAX}）。\n松开鼠标 / Enter / 失焦后才重排（动画过渡），同时写入本地存储。`}
        >
          密度
          <input
            type="range"
            min={SPACING_MIN}
            max={SPACING_SLIDER_MAX}
            step={5}
            value={Math.min(spacingDraft, SPACING_SLIDER_MAX)}
            onChange={e => setSpacingDraft(Number(e.target.value))}
            onMouseUp={e => commitSpacing(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={e => commitSpacing(Number((e.target as HTMLInputElement).value))}
            onKeyUp={e => commitSpacing(Number((e.target as HTMLInputElement).value))}
          />
          <input
            type="number"
            min={SPACING_MIN}
            // 有意不设 max：允许手动输入 1000 以上的任意值；commit 时才 clamp 到 SPACING_HARD_MAX。
            value={spacingDraft}
            onChange={e => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setSpacingDraft(n);
            }}
            onBlur={e => commitSpacing(Number((e.target as HTMLInputElement).value))}
            onKeyDown={e => {
              if (e.key === 'Enter') commitSpacing(Number((e.target as HTMLInputElement).value));
            }}
            style={{ width: 64, padding: '2px 4px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--surface-active)' }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            try {
              window.localStorage.removeItem(SPACING_STORAGE_KEY);
            } catch {
              // ignore
            }
            commitSpacing(SPACING_FALLBACK);
          }}
          title="重置密度为默认值（同时清除本地覆盖）"
          style={{ padding: '2px 6px', fontSize: 11 }}
        >
          ↺
        </button>
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
          {hoverTip ? (
            <div
              style={{
                position: 'absolute',
                left: Math.min(hoverTip.x, 600),
                top: hoverTip.y,
                maxWidth: 320,
                padding: '6px 8px',
                background: 'rgba(28, 28, 40, 0.96)',
                color: TEXT_COLOR,
                border: '1px solid rgba(120,140,200,0.5)',
                borderRadius: 4,
                fontSize: 11,
                lineHeight: 1.5,
                pointerEvents: 'none',
                zIndex: 6,
                boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {hoverTip.lines.map((line, i) => (
                <div key={i} style={i === 0 ? { fontWeight: 600 } : { color: 'var(--text-muted)' }}>{line}</div>
              ))}
            </div>
          ) : null}
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
                  prRank={{
                    sub: subgraphPrRanks.get(String(selectedNode.data.id)),
                    global: globalPrRanksByNodeId.get(String(selectedNode.data.id)),
                  }}
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
                          <span title="边按 (kind, source, target[, role/relation]) 重复合并的累计强度：0.5 起步，每次合并 +(1−prev)·delta（默认 delta=0.1，由 LLM/工具调用传入）→ 0.55 → 0.595 → 0.636 → … (clamp 1.0)。语义=被强化次数，不是重要性。" style={{ cursor: 'help' }}>合并强度</span>
                          <span>{fe.weight.toFixed(2)}</span>
                        </>
                      ) : null}
                      {typeof evictionScore === 'number' ? (
                        <>
                          <span title="边淘汰分 = 合并强度 × 端点 PR 平均。配额淘汰时按此升序删——分越低越先删。让「弱权但连接重要节点」的边受保护。" style={{ cursor: 'help' }}>边淘汰分</span>
                          <span>{evictionScore.toFixed(5)} <span style={{ opacity: 0.6 }}>= {fe.weight!.toFixed(2)} × {formatPR(avgPR!)}</span></span>
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
                          const sub = subgraphPrRanks.get(eid);
                          const glb = globalPrRanksByNodeId.get(eid);
                          const hasPR = typeof n?.lastPageRank === 'number';
                          return (
                            <div key={eid} style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)', marginBottom: 3 }}>
                              <div>
                                {n?.label ?? eid} <span style={{ opacity: 0.6 }}>[{String(n?.kind ?? '?')}]{hasPR ? ` · PR ${formatPR(n!.lastPageRank!)}` : ''}</span>
                              </div>
                              {hasPR && sub ? (
                                <div style={{ opacity: 0.6, paddingLeft: 8 }}>子图 #{sub.kindRank}/{sub.kindTotal} 同类 · #{sub.globalRank}/{sub.globalTotal} 全部</div>
                              ) : null}
                              {hasPR && glb ? (
                                <div style={{ opacity: 0.6, paddingLeft: 8 }}>全库 #{glb.kindRank}/{glb.kindTotal} 同类 · #{glb.globalRank}/{glb.globalTotal} 全部</div>
                              ) : null}
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
        {comp.nodeKinds?.length ? (
          <>
            {comp.nodeKinds.map(k => (
              <LegendItem key={k.kind} shape={k.shape ?? 'circle'} color={k.color ?? PERSON_COLOR} label={k.label} />
            ))}
            <LegendItem shape="circle" color={FOCUS_COLOR} label="焦点" />
            {comp.edgeKinds?.length ? (
              <span style={{ width: 1, height: 12, background: 'var(--border-color, #2a2a42)', margin: '0 4px' }} />
            ) : null}
            {(comp.edgeKinds ?? []).map(e => (
              <LegendEdge key={e.kind} color={e.color ?? '#6b7280'} dashStyle={e.dashed ? 'dashed' : 'solid'} label={e.label} />
            ))}
          </>
        ) : (
          <>
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
          </>
        )}
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

type FieldValue = string | number | undefined | null | React.ReactNode;
interface FieldGridProps { rows: Array<[string, FieldValue] | [string, FieldValue, string]>; }
function FieldGrid({ rows }: FieldGridProps): JSX.Element {
  const visible = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (visible.length === 0) return <></>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 3, color: 'var(--text-secondary)', marginBottom: 8 }}>
      {visible.map(row => {
        const [k, v, tip] = row;
        const rendered = (typeof v === 'string' || typeof v === 'number') ? String(v) : v;
        return (
          <React.Fragment key={k}>
            <span style={{ color: 'var(--text-muted)', cursor: tip ? 'help' : undefined }} title={tip}>{k}</span>
            <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{rendered}</span>
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
  /** PR 排名信息：子图 / 全库两组，缺失时只显示其中一组或仅 PR 数值。 */
  prRank?: {
    sub?: { kindRank: number; kindTotal: number; globalRank: number; globalTotal: number };
    global?: { kindRank: number; kindTotal: number; globalRank: number; globalTotal: number };
  };
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
  // 用 React Portal 渲染到 document.body，绕开任何父容器的 transform / overflow:hidden / contain
  // 形成的 stacking context（这是之前「顶部 / 右侧被遮挡 + 调不出」的根因）。
  // 同时顶部提供「查看完整文档」外链提示，避免某些环境下 modal 仍被裁剪。
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
  // README 路径：优先服务器静态托管（如果部署有），否则 fallback 到仓库相对路径提示。
  const docPath = '/docs/plugins/user-relation-graph.md';
  const body = (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 9999,
        display: 'flex',
        // 顶部对齐 + 外层可滚：当内容高于可视区时，
        // 避免 alignItems:center 把顶部挤出视口造成「最上面几行看不见」。
        alignItems: 'flex-start',
        justifyContent: 'center',
        overflowY: 'auto',
        padding: '4vh 16px',
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
          // 不再限高 + 内部滚动；改为随内容自然高，由外层 overlay 负责滚动。
          // 这样顶部始终从 padding 处起，不会被裁。
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
          <div><b>合并强度</b>（weight, 0~1）：节点 / 边被重复合并的累计程度。0.5 起步，每次合并 <code>+(1−prev)·delta</code>（默认 delta=0.1，可由 LLM/工具调用传入；person 别名合并是直接 <code>+0.3</code> 的特殊情况）→ 0.55 → 0.595 → 0.636 → … (clamp 1.0)。<u>语义 = 被强化次数，<b>不是</b>重要性</u>。</div>
          <div style={{ marginTop: 3 }}><b>图重要性</b>（lastPageRank）：最近一次 <code>/relation compress | maintain</code> 计算的全图 PageRank。个性化种子按 kind 加权（人 2 · 物 1.5 · 事 1，可配置）。越高越靠近"核心人物 · 热门事件"。未跑过压缩则为空。注：节点越多，每个 PR 值越小（PR 是归一化概率分布，总和为 1），UI 在 |n| &lt; 0.01 时切换科学计数法（如 <code>2.07e-3</code>），否则保留 3 位有效数字小数；同时附「子图同类/全部 + 全库同类/全部」四档排名（子图=当前 focusId/depth/breadth 限定的可见视图；全库=fullSnap 全体节点）便于判读位置。</div>
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
          完整文档：
          <a
            href={docPath}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--text-link, #8ab4f8)', marginLeft: 4 }}
            title="在新标签页打开文档"
          >
            docs/plugins/user-relation-graph.md ↗
          </a>
        </div>
      </div>
    </div>
  );
  // Portal 到 document.body：避免父容器 transform / overflow:hidden / contain 形成的 stacking context 裁剪 modal。
  if (typeof document === 'undefined') return body;
  return createPortal(body, document.body);
}
function NodeDetailCard({ node, detail, loading, hasDetailSource, isFocus, prRank }: NodeDetailCardProps): JSX.Element {
  const kind = node.data.kind;
  /**
   * PR 数值 + 两组排名：顶行数值，下面 4 行排名（子图同类 / 子图全部 / 全库同类 / 全库全部）。
   * 子图排名 ≈ 当前可见视图内的相对位置（受 focusId/depth/breadth 限定）；全库排名 = fullSnap 全体节点位置。
   * 未跑过 evictByQuota 的节点 lastPageRank 为空 → 返回提示行（— · 未跑过压缩），让用户知道是"还没算"而不是"加载失败"。
   * 兜底：lastPageRank 存在但 globalPrRanks 缺失（旧服务端 / 服务未重启）→ 显示"全库排名暂缺，请重启 aalis 服务"提示行。
   */
  const formatPRWithRank = (pr: number | undefined): React.ReactNode => {
    if (typeof pr !== 'number' || !Number.isFinite(pr)) {
      return (
        <span style={{ opacity: 0.6 }}>
          — <span style={{ fontSize: 10 }}>（未跑过压缩，下次 evictByQuota 时计算）</span>
        </span>
      );
    }
    const base = formatPR(pr);
    const sub = prRank?.sub;
    const glb = prRank?.global;
    if (!sub && !glb) return base;
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 1 }}>
        <span>{base}</span>
        {sub ? (
          <>
            <span style={{ opacity: 0.75 }}>子图 #{sub.kindRank}/{sub.kindTotal} 同类</span>
            <span style={{ opacity: 0.75 }}>子图 #{sub.globalRank}/{sub.globalTotal} 全部</span>
          </>
        ) : null}
        {glb ? (
          <>
            <span style={{ opacity: 0.75 }}>全库 #{glb.kindRank}/{glb.kindTotal} 同类</span>
            <span style={{ opacity: 0.75 }}>全库 #{glb.globalRank}/{glb.globalTotal} 全部</span>
          </>
        ) : (
          <span style={{ opacity: 0.6, fontSize: 10 }}>（全库排名暂缺：服务端未返回 globalPrRanks，可能需重启 aalis）</span>
        )}
      </span>
    );
  };
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
    const rows: Array<[string, FieldValue] | [string, FieldValue, string]> = [
      ['昵称', asStr(p.displayName)],
      ['平台', asStr(p.platform)],
      ['用户 ID', asStr(p.userId)],
      ['提及次数', asNum(p.mentionCount)],
      [
        '图重要性',
        formatPRWithRank(typeof p.lastPageRank === 'number' ? (p.lastPageRank as number) : undefined),
        '最近一次 evictByQuota 计算的全图 PageRank 分数。人/物/事 个性化种子 2:1.5:1（默认，可配置）；该节点越靠近「核心人物 · 热门事件」越高。下方附「子图同类/全部 + 全库同类/全部」四档排名便于判读位置。未跑过压缩时为空。',
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
    const rows: Array<[string, FieldValue] | [string, FieldValue, string]> = [
      ['标题', asStr(detail.title)],
      ['类别', asStr(detail.category)],
      ['摘要', asStr(detail.summary)],
      ['提及次数', asNum(detail.mentionCount)],
      [
        '合并强度',
        typeof detail.weight === 'number' ? (detail.weight as number).toFixed(2) : undefined,
        '按 title 重复合并的累计强度：0.5 起步，每次合并 +(1−prev)·delta（默认 delta=0.1）。语义 = 被强化次数，不是重要性。',
      ],
      [
        '图重要性',
        formatPRWithRank(typeof detail.lastPageRank === 'number' ? (detail.lastPageRank as number) : undefined),
        '最近一次 evictByQuota 计算的全图 PageRank 分数。反映"被重要节点引用"的结构性重要性；与合并强度独立。下方附「子图同类/全部 + 全库同类/全部」四档排名便于判读位置。',
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
    const rows: Array<[string, FieldValue] | [string, FieldValue, string]> = [
      ['名称', asStr(detail.name)],
      ['类型', asStr(detail.entityKind)],
      ['别名', aliases || undefined],
      ['摘要', asStr(detail.summary)],
      [
        '合并强度',
        typeof detail.weight === 'number' ? (detail.weight as number).toFixed(2) : undefined,
        '按 (kind, name) 重复合并的累计强度：0.5 起步，每次合并 +(1−prev)·delta（默认 delta=0.1）。语义 = 被强化次数，不是重要性。',
      ],
      [
        '图重要性',
        formatPRWithRank(typeof detail.lastPageRank === 'number' ? (detail.lastPageRank as number) : undefined),
        '最近一次 evictByQuota 计算的全图 PageRank 分数。多人共同指向的实体一般分数更高。下方附「子图同类/全部 + 全库同类/全部」四档排名便于判读位置。',
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
