import { useState } from 'react';
import { api } from '../api';
import type { PluginInfo } from '../types';

export function MarketplacePage({
  plugins,
  onRefresh,
}: {
  plugins: PluginInfo[];
  onRefresh: () => void;
}) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [registry, setRegistry] = useState<Array<{ name: string; description: string; version: string; installed: boolean }>>([]);
  const [loadingRegistry, setLoadingRegistry] = useState(false);
  const [searched, setSearched] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const loadRegistry = async () => {
    setLoadingRegistry(true);
    try {
      const res = await api<{ packages: Array<{ name: string; description: string; version: string }> }>('/api/marketplace');
      const installedNames = new Set(plugins.map(p => p.name));
      setRegistry((res.packages ?? []).map(p => ({
        ...p,
        installed: installedNames.has(p.name),
      })));
    } catch {
      showToast('无法加载插件市场');
    }
    setLoadingRegistry(false);
    setSearched(true);
  };

  const handleInstall = async (name: string) => {
    setInstalling(name);
    try {
      const res = await api<{ ok?: boolean; error?: string }>('/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        showToast(`${name} 安装成功，正在重启...`);
        onRefresh();
      } else {
        showToast(res.error ?? '安装失败');
      }
    } catch {
      showToast('安装失败');
    }
    setInstalling(null);
  };

  return (
    <div className="page-content page-marketplace">
      {toast && <div className="toast">{toast}</div>}

      <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        可用插件
        <button className="btn-sm" onClick={loadRegistry} disabled={loadingRegistry}>
          {loadingRegistry ? '加载中...' : searched ? '刷新' : '加载市场'}
        </button>
      </div>

      {!searched && (
        <div className="empty-hint" style={{ padding: 16 }}>
          点击"加载市场"获取可安装的插件列表
        </div>
      )}

      {searched && registry.length === 0 && !loadingRegistry && (
        <div className="empty-hint" style={{ padding: 16 }}>暂无可用插件</div>
      )}

      {registry.map(pkg => (
        <div className="marketplace-card" key={pkg.name}>
          <div className="marketplace-card-info">
            <span className="marketplace-card-name">{pkg.name}</span>
            <span className="marketplace-card-version">v{pkg.version}</span>
            {pkg.installed && <span className="badge active">已安装</span>}
          </div>
          <div className="marketplace-card-desc">{pkg.description}</div>
          {!pkg.installed && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleInstall(pkg.name)}
              disabled={installing === pkg.name}
            >
              {installing === pkg.name ? '安装中...' : '安装'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
