import type { ReactNode } from 'react';
import { isRecord, useJson } from '../rest';

// 装卸前的依赖披露（市场的 depgraph）：装之前列出会一并装上的包、要用的服务由谁提供、它提供什么；卸之前列出依赖它提供的
// 服务的插件（卸载会被拒）与引用了它的已装包（卸掉后它们可能起不来），并写明卸载删掉什么、留下什么。没查到不拦着装卸，
// 写明原因

interface ChainNode {
  name: string;
  present: boolean;
  children: ChainNode[];
}

interface DependencyGraph {
  upstream: ChainNode;
  downstream: ChainNode;
  services: { required: Array<{ service: string; providedBy: string | null }>; provides: string[] };
  serviceDependents: string[];
}

function parseGraph(body: unknown): DependencyGraph {
  if (!isRecord(body) || !isRecord(body.upstream) || !isRecord(body.downstream) || !isRecord(body.services)) {
    throw new Error('依赖图的回应不是预期的形状');
  }
  return body as unknown as DependencyGraph;
}

/** 树里挑出的包名，去重、按先后 */
function namesIn(node: ChainNode, pick: (node: ChainNode) => boolean): string[] {
  const names = node.children.flatMap(child => [...(pick(child) ? [child.name] : []), ...namesIn(child, pick)]);
  return [...new Set(names)];
}

function useGraph(name: string) {
  return useJson(`/api/marketplace/depgraph?${new URLSearchParams({ name })}`, parseGraph, 0);
}

/** 「名目：甲、乙」的一组，空的不列；children 是排在前面、自己画内容的几项 */
export function Lines({ lines, children }: { lines: Array<[string, string[]]>; children?: ReactNode }) {
  const shown = lines.filter(([, items]) => items.length > 0);
  if (shown.length === 0 && !children) return null;
  return (
    <dl className="page-info">
      {children}
      {shown.map(([label, items]) => (
        <div key={label} className="page-info-item">
          <dt>{label}</dt>
          <dd>{items.join('、')}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InstallDisclosure({ name }: { name: string }) {
  const { value: graph, error } = useGraph(name);
  if (error) return <p>依赖没查到：{error.message}</p>;
  if (!graph) return <p>正在查依赖…</p>;
  return (
    <Lines
      lines={[
        ['一并装上', namesIn(graph.upstream, node => !node.present)],
        [
          '要用的服务',
          graph.services.required.map(({ service, providedBy }) =>
            providedBy ? `${service}（由 ${providedBy} 提供）` : `${service}（没有提供者）`,
          ),
        ],
        ['提供的服务', graph.services.provides],
        ['已装的包里引用它的', namesIn(graph.downstream, () => true)],
      ]}
    />
  );
}

export function UninstallWarning({ name }: { name: string }) {
  const { value: graph, error } = useGraph(name);
  return (
    <>
      {error ? (
        <p>依赖没查到：{error.message}</p>
      ) : graph ? (
        <Lines
          lines={[
            ['依赖它提供的服务（卸载会被拒）', graph.serviceDependents],
            ['引用了它（卸掉后可能起不来）', namesIn(graph.downstream, () => true)],
          ]}
        />
      ) : (
        <p>正在查依赖…</p>
      )}
      <p>它的代码与配置会删掉，写在家目录 state/ 等处的数据留着，需要时手动清理。</p>
    </>
  );
}
