import { useState } from 'react';
import { api } from '../api';
import type { ServiceInfo } from '../types';

/**
 * 服务卡片
 *
 * 设计要点（恢复 dev 分支的简洁交互）：
 * - 单 provider：只展示一行
 * - 多 provider：用 <select> 直接切换偏好；当前值 = preferred ?? providers[0]
 * - 用户偏好时显示「偏好」徽标 + 「恢复默认」按钮
 * - 解析顺序：preferred > priority > 注册顺序
 */
export function ServiceCard({
  name,
  info,
  onPreferChanged,
}: {
  name: string;
  info: ServiceInfo;
  onPreferChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const providers = info.providers;
  const ready = providers.length > 0;
  const multi = providers.length > 1;
  // 当前有效 contextId：preferred 优先，否则 providers[0]（已按 priority 排序）
  const activeId = info.preferred ?? providers[0]?.contextId ?? '';
  const active = providers.find(p => p.contextId === activeId);

  const setPrefer = async (contextId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/services/${encodeURIComponent(name)}/prefer`, {
        method: 'POST',
        body: JSON.stringify({ contextId }),
      });
      onPreferChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const clearPrefer = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/services/${encodeURIComponent(name)}/prefer`, { method: 'DELETE' });
      onPreferChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="service-slot-card">
      <div className="service-slot-header">
        <span className="service-slot-name">{name}</span>
        <div className="service-slot-header-badges">
          {info.preferred && <span className="service-winner-badge preferred">偏好</span>}
          <span className={`badge ${ready ? 'active' : 'error'}`}>
            {ready ? (multi ? `${providers.length} 个提供者` : '就绪') : '未就绪'}
          </span>
        </div>
      </div>

      {!ready ? (
        <div className="service-slot-single">
          <span className="empty-hint">无提供者</span>
        </div>
      ) : multi ? (
        <div className="service-slot-select-row">
          <span className="service-slot-label">活跃提供者</span>
          <select
            className="service-select"
            value={activeId}
            disabled={busy}
            onChange={e => setPrefer(e.target.value)}
          >
            {providers.map(p => {
              const mainName = p.displayName || p.label || p.contextId;
              const text =
                mainName !== p.contextId
                  ? `${mainName} · p${p.priority} (${p.contextId})`
                  : `${p.contextId} · p${p.priority}`;
              return (
                <option key={p.contextId} value={p.contextId}>
                  {text}
                </option>
              );
            })}
          </select>
          {info.preferred && (
            <button
              type="button"
              className="service-clear-prefer"
              onClick={clearPrefer}
              disabled={busy}
              title="清除偏好，恢复 priority 默认顺序"
            >
              恢复默认
            </button>
          )}
        </div>
      ) : (
        <div className="service-slot-single">
          <span className="service-slot-label">提供者</span>
          <span className="service-slot-provider-name">
            {active?.displayName || active?.label || active?.contextId}
            {(active?.displayName || active?.label) && (
              <span className="service-slot-context-id"> {active?.contextId}</span>
            )}
          </span>
        </div>
      )}

      {active && active.capabilities.length > 0 && (
        <div className="service-slot-caps">
          {active.capabilities.map(c => (
            <span className="tool-chip" key={c}>
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
