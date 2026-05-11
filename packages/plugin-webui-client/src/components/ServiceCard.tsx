import { useState } from 'react';
import { Star, StarOff, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';
import type { ServiceInfo, ServiceProviderInfo } from '../types';

/**
 * 服务卡片
 *
 * 设计要点：
 * - 单 provider：只展示一行（不可折叠，没有偏好按钮）
 * - 多 provider：默认仅展示当前胜者一行 + "其他 N 个提供者"；点击展开全部
 * - 展开时每行可点击 Star 设为偏好；当前偏好行 Star 高亮
 * - "胜者"标识：preferred（黄色 Star） > priority（无图标，只是第一行）
 * - 含 'router' capability 的 provider 显示「聚合层」徽标
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
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const providers = info.providers;
  const winner: ServiceProviderInfo | undefined = providers[0];
  const ready = providers.length > 0;
  const multi = providers.length > 1;

  const handlePrefer = async (contextId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      // 当前 winner 且来自偏好 → 清除；否则设置为偏好
      if (info.preferred === contextId) {
        await api(`/api/services/${encodeURIComponent(name)}/prefer`, { method: 'DELETE' });
      } else {
        await api(`/api/services/${encodeURIComponent(name)}/prefer`, {
          method: 'POST',
          body: JSON.stringify({ contextId }),
        });
      }
      onPreferChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="service-slot-card">
      <div className="service-slot-header">
        <span className="service-slot-name">{name}</span>
        <span className={`badge ${ready ? 'active' : 'error'}`}>
          {ready ? (multi ? `${providers.length} 个提供者` : '就绪') : '未就绪'}
        </span>
      </div>

      {!ready ? (
        <div className="service-slot-single">
          <span className="empty-hint">无提供者</span>
        </div>
      ) : (
        <>
          {/* 当前胜者一行 */}
          <ProviderRow
            provider={winner!}
            isWinner
            isPreferred={info.preferred === winner!.contextId}
            multi={multi}
            busy={busy}
            onPrefer={multi ? () => handlePrefer(winner!.contextId) : undefined}
          />
          {/* 多 provider：展开/收起按钮 */}
          {multi && (
            <button
              type="button"
              className="service-slot-toggle"
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {expanded ? '收起' : `其他 ${providers.length - 1} 个提供者`}
            </button>
          )}
          {/* 展开后显示其余 provider */}
          {multi && expanded && (
            <div className="service-slot-rest">
              {providers.slice(1).map(p => (
                <ProviderRow
                  key={p.contextId}
                  provider={p}
                  isWinner={false}
                  isPreferred={info.preferred === p.contextId}
                  multi={multi}
                  busy={busy}
                  onPrefer={() => handlePrefer(p.contextId)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  isWinner,
  isPreferred,
  multi,
  busy,
  onPrefer,
}: {
  provider: ServiceProviderInfo;
  isWinner: boolean;
  isPreferred: boolean;
  multi: boolean;
  busy: boolean;
  onPrefer?: () => void;
}) {
  const isRouter = provider.capabilities.includes('router');
  const displayName = provider.displayName || provider.label || provider.contextId;
  return (
    <div className={`service-provider-row ${isWinner ? 'winner' : ''}`}>
      <div className="service-provider-main">
        {multi && onPrefer && (
          <button
            type="button"
            className={`service-prefer-btn ${isPreferred ? 'preferred' : ''}`}
            onClick={onPrefer}
            disabled={busy}
            title={isPreferred ? '清除偏好（恢复默认）' : '设为偏好'}
          >
            {isPreferred ? <Star size={14} fill="currentColor" /> : <StarOff size={14} />}
          </button>
        )}
        <span className="service-provider-name">{displayName}</span>
        {isRouter && <span className="service-router-badge">聚合层</span>}
        {isWinner && isPreferred && <span className="service-winner-badge preferred">偏好</span>}
        {isWinner && !isPreferred && multi && <span className="service-winner-badge default">默认</span>}
      </div>
      <div className="service-provider-meta">
        <span className="service-priority">p{provider.priority}</span>
        {provider.displayName && (
          <span className="service-slot-context-id">{provider.contextId}</span>
        )}
      </div>
      {provider.capabilities.length > 0 && (
        <div className="service-slot-caps">
          {provider.capabilities.map(c => (
            <span className="tool-chip" key={c}>{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}
