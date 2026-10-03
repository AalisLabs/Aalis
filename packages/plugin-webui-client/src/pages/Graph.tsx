import type { GraphData, GraphKind } from '@aalis/api-webui';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { type ZoomBehavior, zoom, zoomIdentity } from 'd3-zoom';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import { IconButton } from '../components/IconButton';

// 关系图：力导向排一次就定住，不做动画；节点与边按类别取 --color-chart-1 到 -6，没有类别的用中性色。滚轮、双指与拖动缩放平移，
// 角上另有放大、缩小与复位。带详情时节点是按钮，选中的节点写进地址

/** 布局的理想边长，插件没给时用它 */
const DEFAULT_SPACING = 120;
const RADIUS = 8;
const LABEL_SIZE = 12;
/** 视野的最小宽度，按边长算 */
const MIN_VIEW = 4;
/** 迭代次数随节点数减少，大图也在一瞬间排完 */
const ticksFor = (nodes: number) => Math.max(50, Math.min(300, Math.ceil(30_000 / Math.max(1, nodes))));

interface Placed extends SimulationNodeDatum {
  id: string;
  label: string;
  kind?: string;
  x: number;
  y: number;
}

function place(data: GraphData, spacing: number) {
  // 不给起始位置：d3 按固定的螺旋排开，每次排出来一样
  const nodes = data.nodes.map(node => ({ ...node }) as Placed);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const links = data.edges.map(edge => ({ source: edge.source, target: edge.target }));
  const ticks = ticksFor(nodes.length);
  forceSimulation(nodes)
    .force(
      'link',
      forceLink<Placed, (typeof links)[number]>(links)
        .id(node => node.id)
        .distance(spacing),
    )
    .force('charge', forceManyBody().strength(-spacing))
    .force('collide', forceCollide(spacing / 4))
    .force('x', forceX().strength(0.05))
    .force('y', forceY().strength(0.05))
    .alphaDecay(1 - 0.001 ** (1 / ticks))
    .stop()
    .tick(ticks);
  // 视野至少是几个边长见方，节点少的图不被放大到字号失真
  const xs = nodes.map(node => node.x);
  const ys = nodes.map(node => node.y);
  const width = Math.max(Math.max(...xs) - Math.min(...xs) + spacing, MIN_VIEW * spacing);
  const height = Math.max(Math.max(...ys) - Math.min(...ys) + spacing, (MIN_VIEW * spacing * 3) / 5);
  const box = {
    x: (Math.max(...xs) + Math.min(...xs) - width) / 2,
    y: (Math.max(...ys) + Math.min(...ys) - height) / 2,
    width,
    height,
  };
  // 两点之间可以有几条边，边没有自己的 id，按先后编号
  const edges = data.edges.map((edge, index) => ({
    ...edge,
    id: String(index),
    from: byId.get(edge.source) as Placed,
    to: byId.get(edge.target) as Placed,
  }));
  return { nodes, edges, box };
}

interface GraphProps {
  data: GraphData;
  nodeKinds: readonly GraphKind[];
  edgeKinds: readonly GraphKind[];
  spacing?: number;
  selected?: string;
  /** 带详情时选中一个节点 */
  onSelect?(id: string): void;
}

export function Graph({ data, nodeKinds, edgeKinds, spacing = DEFAULT_SPACING, selected, onSelect }: GraphProps) {
  const { nodes, edges, box } = useMemo(() => place(data, spacing), [data, spacing]);
  const svg = useRef<SVGSVGElement>(null);
  const layer = useRef<SVGGElement>(null);
  const behavior = useRef<ZoomBehavior<SVGSVGElement, unknown>>(undefined);
  const toneOf = (kinds: readonly GraphKind[], kind?: string) => kinds.find(known => known.kind === kind)?.tone;

  useEffect(() => {
    const target = select(svg.current as SVGSVGElement);
    const zooming = zoom<SVGSVGElement, unknown>()
      .extent([
        [box.x, box.y],
        [box.x + box.width, box.y + box.height],
      ])
      .scaleExtent([0.25, 8])
      .on('zoom', event => layer.current?.setAttribute('transform', event.transform.toString()));
    target.call(zooming).call(zooming.transform, zoomIdentity);
    behavior.current = zooming;
    return () => {
      target.on('.zoom', null);
    };
  }, [box]);

  const zoomBy = (factor: number) => behavior.current?.scaleBy(select(svg.current as SVGSVGElement), factor);
  const reset = () => behavior.current?.transform(select(svg.current as SVGSVGElement), zoomIdentity);
  const onKeyDown = (event: KeyboardEvent, id: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect?.(id);
  };
  // 图例只列这张图里有的类别；边的类别画成线，与同色的节点类别分得开
  const present = (kinds: readonly GraphKind[], items: ReadonlyArray<{ kind?: string }>) =>
    kinds.filter(known => items.some(item => item.kind === known.kind));
  const legend = [
    ...present(nodeKinds, data.nodes).map(kind => ({ kind, edge: false })),
    ...present(edgeKinds, data.edges).map(kind => ({ kind, edge: true })),
  ];

  return (
    <div className="page-graph">
      {legend.length > 0 && (
        <ul className="page-graph-legend" aria-label="图例">
          {legend.map(({ kind, edge }) => (
            <li key={`${edge ? 'edge' : 'node'}:${kind.kind}`}>
              <span className="page-graph-swatch" data-tone={kind.tone} data-edge={edge || undefined} aria-hidden />
              {kind.label}
            </li>
          ))}
        </ul>
      )}
      <div className="page-graph-view">
        <svg ref={svg} viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} aria-label="关系图">
          <g ref={layer}>
            {edges.map(edge => (
              <line
                key={edge.id}
                className="page-graph-edge"
                data-tone={toneOf(edgeKinds, edge.kind)}
                x1={edge.from.x}
                y1={edge.from.y}
                x2={edge.to.x}
                y2={edge.to.y}
                strokeWidth={1.5}
              >
                {edge.label && <title>{edge.label}</title>}
              </line>
            ))}
            {nodes.map(node => (
              <g
                key={node.id}
                className="page-graph-node"
                data-tone={toneOf(nodeKinds, node.kind)}
                transform={`translate(${node.x} ${node.y})`}
                {...(onSelect
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      'aria-pressed': node.id === selected,
                      onClick: () => onSelect(node.id),
                      onKeyDown: (event: KeyboardEvent) => onKeyDown(event, node.id),
                    }
                  : {})}
              >
                <circle r={RADIUS} strokeWidth={2} />
                <text y={RADIUS + LABEL_SIZE + 2} fontSize={LABEL_SIZE} textAnchor="middle">
                  {node.label}
                </text>
              </g>
            ))}
          </g>
        </svg>
        <div className="page-graph-zoom">
          <IconButton icon={ZoomIn} label="放大" onClick={() => zoomBy(1.5)} />
          <IconButton icon={ZoomOut} label="缩小" onClick={() => zoomBy(1 / 1.5)} />
          <IconButton icon={Maximize} label="复位" onClick={reset} />
        </div>
      </div>
    </div>
  );
}
