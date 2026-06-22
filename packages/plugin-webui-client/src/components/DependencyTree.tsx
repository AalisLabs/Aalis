// 依赖关系展示：递归渲染市场 /api/marketplace/depgraph 的依赖链路树 + 服务标注。
// 两类边：import（链路树，可传递）+ service（每节点直接标注 需/供，不深挖服务的服务）。
// present=false：install 语境=「将引入」（npm 自动拉取）；view 语境=「缺失」。

export interface DepChainNode {
  name: string;
  /** 本地是否已存在该包 */
  present: boolean;
  /** 服务标注（仅已加载插件有；util/api/未装为 undefined） */
  services?: { provides: string[]; requires: string[] };
  children: DepChainNode[];
}

export interface DepGraph {
  /** 上游：它依赖谁（import 链路树，根为目标自身） */
  upstream: DepChainNode;
  /** 下游：谁依赖它（import 链路树） */
  downstream: DepChainNode;
  /** 目标自身的服务：需要哪些（含已装提供者解析）/ 提供哪些 */
  services: { required: Array<{ service: string; providedBy: string | null }>; provides: string[] };
  /** 卸载会断服务的依赖者（与卸载 409 同口径） */
  serviceDependents: string[];
}

/** 递归渲染单个依赖节点 + 其子树。depth 控制缩进；根节点由调用方决定是否渲染（通常渲染其 children）。 */
export function DependencyTree({
  node,
  mode,
  depth = 0,
}: {
  node: DepChainNode;
  mode: 'install' | 'view';
  depth?: number;
}) {
  const req = node.services?.requires ?? [];
  const prov = node.services?.provides ?? [];
  return (
    <div className="dep-tree-node" style={depth > 0 ? { marginLeft: 14 } : undefined}>
      <div className="dep-tree-row">
        <span className="dep-tree-name">{node.name}</span>
        {!node.present && (
          <span className="dep-tree-tag dep-tag-missing">{mode === 'install' ? '将引入' : '未装'}</span>
        )}
        {req.length > 0 && <span className="dep-tree-tag dep-tag-req">需 {req.join('、')}</span>}
        {prov.length > 0 && <span className="dep-tree-tag dep-tag-prov">供 {prov.join('、')}</span>}
      </div>
      {node.children.map(c => (
        <DependencyTree key={c.name} node={c} mode={mode} depth={depth + 1} />
      ))}
    </div>
  );
}

/** 安装弹窗里的装前披露：依赖树（将引入）+ 服务需/供（含提供者解析）+ 已装依赖者。 */
export function InstallDepDisclosure({ graph }: { graph: DepGraph }) {
  const deps = graph.upstream.children; // 跳过根（=目标自身，标题已写），直接列其依赖
  const { required, provides } = graph.services;
  const downstream = graph.downstream.children.map(c => c.name);
  return (
    <div className="dep-disclosure">
      <div className="dep-section-label">依赖关系</div>
      {deps.length > 0 ? (
        deps.map(c => <DependencyTree key={c.name} node={c} mode="install" />)
      ) : (
        <div className="dep-empty">无 import 依赖</div>
      )}
      {required.length > 0 && (
        <div className="dep-line">
          需要服务：
          {required.map(r => (
            <span key={r.service} className={`dep-svc ${r.providedBy ? 'ok' : 'warn'}`}>
              {r.service}
              {r.providedBy ? `（✓ ${r.providedBy}）` : '（⚠ 无提供者）'}
            </span>
          ))}
        </div>
      )}
      {provides.length > 0 && <div className="dep-line">提供服务：{provides.join('、')}</div>}
      {downstream.length > 0 && <div className="dep-line">已装插件中依赖它的：{downstream.join('、')}</div>}
    </div>
  );
}

/** 卸载弹窗里的依赖预警：服务依赖者（将被 409 拒）+ import 依赖者链路（删后可能起不来）。返回 null 表示无依赖者。 */
export function UninstallDepWarning({ graph }: { graph: DepGraph }) {
  const importers = graph.downstream.children; // 下游链路树（传递），根=目标自身跳过
  if (importers.length === 0 && graph.serviceDependents.length === 0) return null;
  return (
    <div className="dep-uninstall-warn">
      {graph.serviceDependents.length > 0 && (
        <div className="dep-line dep-warn-block">
          ⛔ 依赖它提供的服务且无替代：{graph.serviceDependents.join('、')}
          <br />（卸载会被拒绝，请先卸载它们或装替代提供者）
        </div>
      )}
      {importers.length > 0 && (
        <div className="dep-warn-block">
          <div>⚠️ 这些已装插件 import 了它（删除后可能无法启动，需重新安装恢复）：</div>
          {importers.map(c => (
            <DependencyTree key={c.name} node={c} mode="view" />
          ))}
        </div>
      )}
    </div>
  );
}
