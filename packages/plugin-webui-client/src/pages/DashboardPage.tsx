import { useState, useEffect } from 'react';
import { Sparkles, Zap, AlertTriangle, Wrench, Bot, Command } from 'lucide-react';
import { api } from '../api';
import { ServiceCard } from '../components/ServiceCard';
import type { SystemStatus, PluginInfo, ServiceInfo, ToolGroupDetail } from '../types';

interface ServiceGroup {
  label: string;
  services: string[];
}

interface LLMModelEntry {
  id: string;
  capabilities: string[];
  provider: string;
  contextId: string;
}

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
  onRefreshServices?: () => void;
}) {
  const activeCount = plugins.filter(p => p.state === 'active').length;
  const errorCount = plugins.filter(p => p.state === 'error').length;
  const totalCount = plugins.length;
  const [toast, setToast] = useState<string | null>(null);
  const [toolGroups, setToolGroups] = useState<ToolGroupDetail[]>([]);
  const [serviceGroups, setServiceGroups] = useState<ServiceGroup[]>([]);
  const [llmModels, setLlmModels] = useState<LLMModelEntry[]>([]);
  const [clients, setClients] = useState<Array<{ id: string; label: string; active: boolean }>>([]);

  useEffect(() => {
    api<{ groups: ToolGroupDetail[] }>('/api/tool-groups')
      .then(d => setToolGroups(d.groups ?? []))
      .catch(() => {});
  }, [plugins]);

  useEffect(() => {
    api<{ groups: ServiceGroup[] }>('/api/service-groups')
      .then(d => setServiceGroups(d.groups ?? []))
      .catch(() => {});
  }, [plugins]);

  useEffect(() => {
    api<{ models: LLMModelEntry[] }>('/api/llm-models')
      .then(d => setLlmModels(d.models ?? []))
      .catch(() => {});
  }, [plugins]);

  useEffect(() => {
    api<{ clients: Array<{ id: string; label: string; active: boolean }> }>('/api/clients')
      .then(d => setClients(d.clients ?? []))
      .catch(() => {});
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  // 切换活跃前端（owner）：后端实时重挂 + 持久化，切完 reload 即加载新前端。
  const switchClient = async (id: string) => {
    try {
      await api('/api/clients/active', { method: 'POST', body: JSON.stringify({ id }) });
      showToast('已切换前端，正在重新加载…');
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '切换失败（需 owner 权限）');
    }
  };

  const serviceEntries = servicesData
    ? Object.entries(servicesData)
    : [];

  // 根据 /api/service-groups 返回的分组信息将服务分层
  const groupedSections = serviceGroups.map(g => ({
    label: g.label,
    entries: serviceEntries.filter(([name]) => g.services.includes(name)),
  }));

  // 如果 API 未返回分组（兼容旧后端），回退到全量显示
  const hasGroups = groupedSections.some(s => s.entries.length > 0);
  const allClaimed = new Set(serviceGroups.flatMap(g => g.services));
  const unclaimed = serviceEntries.filter(([name]) => !allClaimed.has(name));

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
          <div className="overview-card-icon"><Sparkles size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">应用名称</div>
            <div className="overview-card-value">{status?.name ?? '-'}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Zap size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">活跃插件</div>
            <div className="overview-card-value">{activeCount} / {totalCount}</div>
          </div>
        </div>
        {errorCount > 0 && (
          <div className="overview-card overview-card-error">
            <div className="overview-card-icon"><AlertTriangle size={20} /></div>
            <div className="overview-card-body">
              <div className="overview-card-label">错误插件</div>
              <div className="overview-card-value">{errorCount}</div>
            </div>
          </div>
        )}
        <div className="overview-card">
          <div className="overview-card-icon"><Wrench size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册工具</div>
            <div className="overview-card-value">{status?.tools.length ?? 0}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Command size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册指令</div>
            <div className="overview-card-value">{status?.commands?.length ?? 0}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon"><Bot size={20} /></div>
          <div className="overview-card-body">
            <div className="overview-card-label">可用模型</div>
            <div className="overview-card-value">{llmModels.length}</div>
          </div>
        </div>
      </div>

      {clients.length > 1 && (
        <>
          <div className="section-label">前端（活跃切换）</div>
          <div className="services-grid">
            {clients.map(c => (
              <div key={c.id} className="service-slot-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{c.label}</span>
                  {c.active ? (
                    <span className="badge active">活跃</span>
                  ) : (
                    <button type="button" className="btn-sm" onClick={() => switchClient(c.id)}>
                      设为活跃
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim, #888)' }}>{c.id}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {hasGroups ? (
        <>
          {groupedSections.map(section => section.entries.length > 0 && (
            <div key={section.label}>
              <div className="section-label">{section.label}</div>
              <div className="services-grid">
                {section.entries.map(([name, info]) => (
                  <ServiceCard key={name} name={name} info={info} onPreferChanged={onRefreshServices} />
                ))}
              </div>
            </div>
          ))}
          {unclaimed.length > 0 && (
            <div>
              <div className="section-label">其他</div>
              <div className="services-grid">
                {unclaimed.map(([name, info]) => (
                  <ServiceCard key={name} name={name} info={info} onPreferChanged={onRefreshServices} />
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="section-label">服务</div>
          <div className="services-grid">
            {serviceEntries.length === 0 && (
              <div className="empty-hint">加载中...</div>
            )}
            {serviceEntries.map(([name, info]) => (
              <ServiceCard key={name} name={name} info={info} onPreferChanged={onRefreshServices} />
            ))}
          </div>
        </>
      )}

      <div className="section-label">工具分组</div>
      {toolGroups.length > 0 ? (
        <div className="tool-groups-grid">
          {toolGroups.map(g => {
            // owner 与 contributingPlugins 合并去重；优先 owner 在前
            const contributors = g.contributingPlugins ?? [];
            const plugins = [g.pluginName, ...contributors.filter(p => p !== g.pluginName)];
            return (
              <div className="tool-group-card" key={g.name}>
                <div className="tool-group-header">
                  <span className="tool-group-name">{g.label}</span>
                  <span className="tool-group-count">{g.toolCount} 工具</span>
                </div>
                {g.description && <div className="tool-group-desc">{g.description}</div>}
                <div className="tool-group-meta">
                  <span className="tool-group-id">{g.name}</span>
                  <span className="tool-group-plugin" title={plugins.join(', ')}>
                    {plugins.join(' · ')}
                  </span>
                </div>
              </div>
            );
          })}
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
