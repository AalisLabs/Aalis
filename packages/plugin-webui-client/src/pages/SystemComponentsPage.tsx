import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '../api';

// ════════════════════════════════════════════════════════════
// 系统组件页
//
// 与插件市场的关键差异，两条都不是 UI 偏好而是安全/正确性约束：
//
// 1. **数据源是本地已装 + 根依赖表，不是 npm 检索。** npm 关键词是开放命名空间，
//    任何人都能发一个带 aalis-core 关键词的包；若走检索，它就能在这里拿到一张
//    「内核」卡片。版本按精确包名查询，故不存在冒名空间。
// 2. **只提供更新，无安装无卸载。** 这些包要么随脚手架就位（core/runtime），
//    要么作为插件依赖被 npm 自动带入（api/schema/util）——用户从不需要主动装。
//
// 更新一律**整批提交**：peer 冲突只有对整张版本映射一次预检才能发现，且重启
// 次数恒为 1（与改了多少个包无关）。逐个更新 = 重启 N 次且中间态半新半旧。
// ════════════════════════════════════════════════════════════

interface SystemComponent {
  name: string;
  version?: string;
  latest?: string;
  request?: string;
  description?: string;
  kind: 'core' | 'runtime' | 'api' | 'schema' | 'util';
}

interface UpdateResult {
  ok: boolean;
  message: string;
  conflicts?: string[];
  restarting?: boolean;
}

const KIND_LABELS: Record<SystemComponent['kind'], string> = {
  core: '内核',
  runtime: '宿主',
  api: '服务契约',
  schema: '数据规范',
  util: '工具库',
};

/** 更新内核/宿主必须全量重启——它们在 App 存在之前就被入口 import，无热换可能。 */
const NEEDS_FULL_RESTART: ReadonlyArray<SystemComponent['kind']> = ['core', 'runtime'];

export function SystemComponentsPage({ onRestart }: { onRestart?: (msg: string) => void }) {
  const [components, setComponents] = useState<SystemComponent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ components: SystemComponent[] }>('/api/system-components');
      setComponents(data.components ?? []);
    } catch {
      setComponents([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updatable = useMemo(
    () => components.filter(c => c.latest && c.version && c.latest !== c.version),
    [components],
  );

  // 勾选集合随可更新列表收敛：刷新后某项不再可更新时，不该继续留在待更新集里。
  useEffect(() => {
    setSelected(prev => {
      const names = new Set(updatable.map(c => c.name));
      const next = new Set([...prev].filter(n => names.has(n)));
      return next.size === prev.size ? prev : next;
    });
  }, [updatable]);

  const toggle = (name: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const selectedComponents = updatable.filter(c => selected.has(c.name));
  const willFullRestart = selectedComponents.some(c => NEEDS_FULL_RESTART.includes(c.kind));

  const applyUpdates = async () => {
    if (selectedComponents.length === 0 || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api<UpdateResult>('/api/marketplace/update', {
        method: 'POST',
        body: JSON.stringify({
          targets: selectedComponents.map(c => ({ name: c.name, version: c.latest })),
        }),
      });
      setResult(r);
      // 服务端已提交安装并触发重启——交给外层进入「等待重连」态，本页不再自行刷新。
      if (r.ok && r.restarting) onRestart?.(`正在应用 ${selectedComponents.length} 项更新并重启…`);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
    setBusy(false);
  };

  return (
    <div className="page-content page-system-components">
      <div className="section-label">系统组件</div>
      <p className="page-hint">
        内核、宿主与契约包。它们随脚手架就位或作为插件依赖被自动带入，因此**只能更新，不能安装或卸载**。
        列表取自本地实况与根依赖，不经 npm 关键词检索。
      </p>

      {loading && <div className="empty-hint">加载中…</div>}
      {!loading && components.length === 0 && <div className="empty-hint">未发现系统组件</div>}

      {updatable.length > 0 && (
        <div className="update-panel">
          <div className="update-panel-head">
            <span>
              可更新 {updatable.length} 项，已选 {selectedComponents.length}
            </span>
            <div className="update-panel-actions">
              <button type="button" className="btn-secondary" onClick={() => setSelected(new Set(updatable.map(c => c.name)))} disabled={busy}>
                全选
              </button>
              <button type="button" className="btn-primary" onClick={applyUpdates} disabled={busy || selectedComponents.length === 0}>
                {busy ? '正在更新…' : `更新所选（${selectedComponents.length}）`}
              </button>
            </div>
          </div>
          {willFullRestart && (
            <div className="update-panel-warn">
              <AlertTriangle size={14} /> 所选包含内核或宿主，更新后将重启整个应用；若新版本起不来会自动回滚到当前版本。
            </div>
          )}
          <div className="update-panel-note">
            所选项会**一次性提交**：先整组做依赖预检，通过后一次安装、一次重启。任一项的 peer 版本不兼容则整批不执行，且不改动任何文件。
          </div>
        </div>
      )}

      {result && (
        <div className={result.ok ? 'update-result ok' : 'update-result err'}>
          <div>{result.message}</div>
          {result.conflicts && result.conflicts.length > 0 && (
            <ul className="update-conflicts">
              {result.conflicts.map(c => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="component-list">
        {components.map(c => {
          const canUpdate = !!c.latest && !!c.version && c.latest !== c.version;
          return (
            <div key={c.name} className="component-row">
              <label className="component-pick">
                <input
                  type="checkbox"
                  checked={selected.has(c.name)}
                  onChange={() => toggle(c.name)}
                  disabled={!canUpdate || busy}
                />
              </label>
              <div className="component-main">
                <div className="component-name">
                  {c.name}
                  <span className={`component-kind kind-${c.kind}`}>{KIND_LABELS[c.kind]}</span>
                </div>
                {c.description && <div className="component-desc">{c.description}</div>}
              </div>
              <div className="component-version">
                <span>{c.version ?? '—'}</span>
                {canUpdate && (
                  <>
                    <span className="component-arrow">→</span>
                    <span className="component-latest">{c.latest}</span>
                  </>
                )}
                {!canUpdate && c.latest && <span className="component-uptodate">已是最新</span>}
                {!c.latest && <span className="component-unknown">版本未知</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="page-actions">
        <button type="button" className="btn-secondary" onClick={refresh} disabled={loading || busy}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>
    </div>
  );
}
