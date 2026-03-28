import { useState, useEffect, useCallback } from 'react';
import { Plug, Globe } from 'lucide-react';
import { api } from '../api';
import type { PlatformInfo } from '../types';

export function PlatformPage() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ platforms: PlatformInfo[] }>('/api/platforms');
      setPlatforms(data.platforms ?? []);
    } catch {
      setPlatforms([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const totalConnections = platforms.reduce((sum, p) => sum + p.connections.length, 0);
  const onlineConnections = platforms.reduce(
    (sum, p) => sum + p.connections.filter(c => c.status === 'online').length,
    0,
  );

  return (
    <div className="page-content page-platforms">
      <div className="section-label">概览</div>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-icon"><Plug size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">适配器</div>
            <div className="overview-card-value">{platforms.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Globe size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">连接数</div>
            <div className="overview-card-value">{onlineConnections} / {totalConnections}</div>
          </div>
        </div>
      </div>

      <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        适配器列表
        <button className="btn-sm" onClick={refresh} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {platforms.length === 0 && !loading && (
        <div className="empty-hint">暂无平台适配器。请启用并配置平台适配器插件。</div>
      )}

      {platforms.map(p => (
        <div className="platform-card" key={p.contextId}>
          <div className="platform-card-header">
            <span className="platform-card-name">{p.adapterName}</span>
            <span className="platform-card-id">{p.platform}</span>
          </div>
          {p.connections.length === 0 ? (
            <div className="platform-no-connections">无活跃连接</div>
          ) : (
            <div className="platform-connections">
              {p.connections.map(conn => (
                <div className="platform-connection" key={conn.id}>
                  <span className={`platform-status-dot ${conn.status}`} />
                  <span className="platform-conn-id">{conn.selfId ?? conn.id}</span>
                  <span className={`platform-conn-status ${conn.status}`}>
                    {conn.status === 'online' ? '在线' : conn.status === 'connecting' ? '连接中' : '离线'}
                  </span>
                  {conn.detail && Object.keys(conn.detail).length > 0 && (
                    <span className="platform-conn-detail">
                      {Object.entries(conn.detail).map(([k, v]) => `${k}: ${String(v)}`).join(', ')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
