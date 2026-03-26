import type { ServiceInfo } from '../types';

export function ServiceCard({ name, info, busy, onPrefer }: {
  name: string;
  info: ServiceInfo;
  busy: string | null;
  onPrefer: (name: string, contextId: string) => void;
}) {
  return (
    <div className="service-slot-card">
      <div className="service-slot-header">
        <span className="service-slot-name">{name}</span>
        <span className={`badge ${info.providers.length > 0 ? 'active' : 'error'}`}>
          {info.providers.length > 0 ? '就绪' : '未就绪'}
        </span>
      </div>
      {info.providers.length > 1 ? (
        <div className="service-slot-select-row">
          <span className="service-slot-label">活跃提供者</span>
          <select
            className="service-select"
            value={info.active ?? ''}
            disabled={busy === name}
            onChange={e => onPrefer(name, e.target.value)}
          >
            {info.providers.map(p => (
              <option key={p.contextId} value={p.contextId}>{p.contextId}</option>
            ))}
          </select>
        </div>
      ) : info.providers.length === 1 ? (
        <div className="service-slot-single">
          <span className="service-slot-label">提供者</span>
          <span className="service-slot-provider-name">{info.providers[0].contextId}</span>
        </div>
      ) : (
        <div className="service-slot-single">
          <span className="empty-hint">无提供者</span>
        </div>
      )}
      {info.providers.length > 0 && (
        <div className="service-slot-caps">
          {info.providers
            .find(p => p.contextId === info.active)
            ?.capabilities.map(c => (
              <span className="tool-chip" key={c}>{c}</span>
            ))}
        </div>
      )}
    </div>
  );
}
