import { useState, useEffect } from 'react';
import { api } from '../api';
import { ServiceCard } from '../components/ServiceCard';
import type { SystemStatus, PluginInfo, ServiceInfo, ToolGroupDetail } from '../types';

export function DashboardPage({
  status,
  connected,
  plugins,
  servicesData,
  onRefreshServices,
}: {
  status: SystemStatus | null;
  connected: boolean;
  plugins: PluginInfo[];
  servicesData: Record<string, ServiceInfo> | null;
  onRefreshServices: () => void;
}) {
  const activeCount = plugins.filter(p => p.state === 'active').length;
  const errorCount = plugins.filter(p => p.state === 'error').length;
  const totalCount = plugins.length;
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [toolGroups, setToolGroups] = useState<ToolGroupDetail[]>([]);

  useEffect(() => {
    api<{ groups: ToolGroupDetail[] }>('/api/tool-groups')
      .then(d => setToolGroups(d.groups ?? []))
      .catch(() => {});
  }, [plugins]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handlePrefer = async (serviceName: string, contextId: string) => {
    setBusy(serviceName);
    const res = await api<{ ok?: boolean; error?: string }>(
      `/api/services/${encodeURIComponent(serviceName)}/prefer`,
      { method: 'POST', body: JSON.stringify({ contextId }) },
    );
    if (res.ok) {
      showToast(`${serviceName} 已切换到 ${contextId}`);
      onRefreshServices();
    } else {
      showToast(res.error ?? '未知错误');
    }
    setBusy(null);
  };

  const serviceEntries = servicesData
    ? Object.entries(servicesData).filter(([name]) => name !== 'platform' && name !== 'app')
    : [];

  const coreServiceNames = new Set([
    'agent', 'llm', 'memory', 'tools', 'commands', 'authority',
    'embedding', 'vectorstore', 'persona', 'semantic-memory',
    'cli', 'webui-server', 'webui-client',
    'image-recognition', 'file-reader',
  ]);
  const coreServices = serviceEntries.filter(([name]) => coreServiceNames.has(name));
  const extServices = serviceEntries.filter(([name]) => !coreServiceNames.has(name));

  return (
    <div className="page-content page-dashboard">
      {toast && <div className="toast">{toast}</div>}

      <div className="section-label">概览</div>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-icon">
            <span className={`status-dot-lg ${connected ? 'online' : 'offline'}`} />
          </div>
          <div className="overview-card-body">
            <div className="overview-card-label">连接状态</div>
            <div className="overview-card-value">{connected ? '已连接' : '离线'}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">✦</div>
          <div className="overview-card-body">
            <div className="overview-card-label">应用名称</div>
            <div className="overview-card-value">{status?.name ?? '-'}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">⚡</div>
          <div className="overview-card-body">
            <div className="overview-card-label">活跃插件</div>
            <div className="overview-card-value">{activeCount} / {totalCount}</div>
          </div>
        </div>
        {errorCount > 0 && (
          <div className="overview-card overview-card-error">
            <div className="overview-card-icon">⚠️</div>
            <div className="overview-card-body">
              <div className="overview-card-label">错误插件</div>
              <div className="overview-card-value">{errorCount}</div>
            </div>
          </div>
        )}
        <div className="overview-card">
          <div className="overview-card-icon">🛠</div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册工具</div>
            <div className="overview-card-value">{status?.tools.length ?? 0}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">⌘</div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册指令</div>
            <div className="overview-card-value">{status?.commands?.length ?? 0}</div>
          </div>
        </div>
      </div>

      <div className="section-label">核心服务</div>
      <div className="services-grid">
        {coreServices.length === 0 && (
          <div className="empty-hint">加载中...</div>
        )}
        {coreServices.map(([name, info]) => (
          <ServiceCard key={name} name={name} info={info} busy={busy} onPrefer={handlePrefer} />
        ))}
      </div>

      {extServices.length > 0 && (
        <>
          <div className="section-label">扩展服务</div>
          <div className="services-grid">
            {extServices.map(([name, info]) => (
              <ServiceCard key={name} name={name} info={info} busy={busy} onPrefer={handlePrefer} />
            ))}
          </div>
        </>
      )}

      <div className="section-label">工具分组</div>
      {toolGroups.length > 0 ? (
        <div className="tool-groups-grid">
          {toolGroups.map(g => (
            <div className="tool-group-card" key={g.name}>
              <div className="tool-group-header">
                <span className="tool-group-name">{g.label}</span>
                <span className="tool-group-count">{g.toolCount} 工具</span>
              </div>
              {g.description && <div className="tool-group-desc">{g.description}</div>}
              <div className="tool-group-meta">
                <span className="tool-group-id">{g.name}</span>
                <span className="tool-group-plugin">{g.pluginName}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="tools-grid">
          {!status || status.tools.length === 0
            ? <div className="empty-hint">无工具</div>
            : status.tools.map(t => <span className="tool-chip" key={t}>{t}</span>)
          }
        </div>
      )}

      <div className="section-label">已注册指令</div>
      <div className="tools-grid">
        {!status || !status.commands || status.commands.length === 0
          ? <div className="empty-hint">无指令</div>
          : status.commands.map(c => (
            <span className="tool-chip cmd-chip" key={c.name} title={c.description}>
              /{c.name}
            </span>
          ))
        }
      </div>
    </div>
  );
}
