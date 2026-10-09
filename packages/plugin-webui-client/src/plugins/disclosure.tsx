import { isSecretRef } from '@aalis/schema-config';
import type { ReactNode } from 'react';
import { isRecord, useJson } from '../rest';
import { usePlugins } from './list';

// 装卸前的依赖披露（市场的 depgraph）：装之前列出会一并装上的包、要用的服务由谁提供、它提供什么；卸之前列出依赖它提供的
// 服务的插件（卸载会被拒）与引用了它的已装包（卸掉后它们可能起不来），并写明卸载删掉什么、留下什么：配置默认留着，
// 配置文件里有它的配置段时可以勾上一并删除。没查到不拦着装卸，写明原因

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

/** 这些配置段引用、别处再没有引用的密钥键数：删配置时随之删掉的 */
function ownedSecrets(configs: readonly Record<string, unknown>[], counts: Readonly<Record<string, number>>): number {
  const refs: Record<string, number> = {};
  const walk = (value: unknown): void => {
    if (isSecretRef(value)) refs[value.$secret] = (refs[value.$secret] ?? 0) + 1;
    else if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) Object.values(value).forEach(walk);
  };
  configs.forEach(walk);
  return Object.entries(refs).filter(([key, count]) => counts[key] === count).length;
}

interface UninstallWarningProps {
  name: string;
  /** 同时删除配置：勾了才删，每次打开都从不勾开始 */
  removeConfig: boolean;
  onRemoveConfig(removeConfig: boolean): void;
}

export function UninstallWarning({ name, removeConfig, onRemoveConfig }: UninstallWarningProps) {
  const { value: graph, error } = useGraph(name);
  const { plugins, secretRefCounts } = usePlugins();
  // 这个包各实例在配置文件里的配置段
  const configs = (plugins ?? []).filter(row => row.name === name && row.configSection).map(row => row.config);
  const secrets = ownedSecrets(configs, secretRefCounts);
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
      <p>它的代码会删掉，写在家目录 state/ 等处的数据留着，需要时手动清理。</p>
      {configs.length > 0 && (
        <>
          <p>它的配置默认留在配置文件里，重装后照原配置启动。</p>
          <label className="field-check">
            <input type="checkbox" checked={removeConfig} onChange={event => onRemoveConfig(event.target.checked)} />
            {secrets > 0 ? `同时删除配置（含 ${secrets} 个密钥）` : '同时删除配置'}
          </label>
        </>
      )}
    </>
  );
}
