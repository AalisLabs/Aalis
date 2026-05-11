import type { ServiceInfo } from '../types';

export function ServiceCard({ name, info }: {
  name: string;
  info: ServiceInfo;
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
        <div className="service-slot-single">
          <span className="service-slot-label">提供者 ({info.providers.length})</span>
          <div className="service-slot-providers">
            {info.providers.map(p => {
              const mainName = p.displayName || p.contextId;
              return (
                <span className="service-slot-provider-name" key={p.contextId}>
                  {mainName}
                  {p.displayName && (
                    <span className="service-slot-context-id"> {p.contextId}</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      ) : info.providers.length === 1 ? (
        <div className="service-slot-single">
          <span className="service-slot-label">提供者</span>
          <span className="service-slot-provider-name">
            {info.providers[0].displayName || info.providers[0].contextId}
            {info.providers[0].displayName && (
              <span className="service-slot-context-id"> {info.providers[0].contextId}</span>
            )}
          </span>
        </div>
      ) : (
        <div className="service-slot-single">
          <span className="empty-hint">无提供者</span>
        </div>
      )}
      {info.providers.length > 0 && (
        <div className="service-slot-caps">
          {info.providers[0].capabilities.map(c => (
            <span className="tool-chip" key={c}>{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}
