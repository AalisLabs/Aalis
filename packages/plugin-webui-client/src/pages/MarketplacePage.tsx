import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { PluginInfo } from '../types';

interface MarketPkg {
  name: string;
  description: string;
  version: string;
  author?: string;
  installed: boolean;
}

export function MarketplacePage({
  plugins,
  onRefresh,
}: {
  plugins: PluginInfo[];
  onRefresh: () => void;
}) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [registry, setRegistry] = useState<MarketPkg[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const loadRegistry = useCallback(
    async (q: string) => {
      setLoading(true);
      setWarning(null);
      try {
        const res = await api<{ packages: MarketPkg[]; warning?: string }>(
          `/api/marketplace?q=${encodeURIComponent(q)}`,
        );
        const installedNames = new Set(plugins.map(p => p.name));
        setRegistry((res.packages ?? []).map(p => ({ ...p, installed: p.installed || installedNames.has(p.name) })));
        if (res.warning) setWarning(res.warning);
      } catch {
        showToast('无法加载插件市场');
      }
      setLoading(false);
      setSearched(true);
    },
    [plugins],
  );

  // 搜索防抖：仅在已首次加载后，输入变化 350ms 触发重查（避免每键一次请求）
  useEffect(() => {
    if (!searched) return;
    const t = setTimeout(() => loadRegistry(search), 350);
    return () => clearTimeout(t);
  }, [search, searched, loadRegistry]);

  const handleInstall = async (name: string) => {
    // 安装第三方代码 = 高危操作：装后该插件以你授予的能力运行。owner 二次确认知情同意。
    // 细粒度能力（依赖服务 / 工具 permissions）在装后于权限页查看（装后披露）。
    if (
      !window.confirm(
        `将从 npm 安装第三方插件「${name}」。\n\n安装后它会以你授予的能力运行（可在权限页查看其依赖与权限）。请确认来源可信。\n\n继续安装？`,
      )
    ) {
      return;
    }
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
        插件市场
        {!searched ? (
          <button className="btn-sm" onClick={() => loadRegistry('')} disabled={loading}>
            {loading ? '加载中...' : '加载市场'}
          </button>
        ) : (
          <>
            <input
              className="config-edit-input"
              style={{ flex: 1, maxWidth: 320 }}
              placeholder="搜索插件（名称 / 关键词）"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <button className="btn-sm" onClick={() => loadRegistry(search)} disabled={loading}>
              {loading ? '加载中...' : '刷新'}
            </button>
          </>
        )}
      </div>

      {!searched && (
        <div className="empty-hint" style={{ padding: 16 }}>
          点击"加载市场"从 npm 获取带 <code>aalis-plugin</code> 标签的可安装插件
        </div>
      )}

      {warning && (
        <div className="empty-hint" style={{ padding: 12, color: 'var(--warning, #ffb300)' }}>
          {warning}
        </div>
      )}

      {searched && registry.length === 0 && !loading && !warning && (
        <div className="empty-hint" style={{ padding: 16 }}>未找到匹配的插件</div>
      )}

      {registry.map(pkg => (
        <div className="marketplace-card" key={pkg.name}>
          <div className="marketplace-card-info">
            <span className="marketplace-card-name">{pkg.name}</span>
            <span className="marketplace-card-version">v{pkg.version}</span>
            {pkg.author && <span className="marketplace-card-author">by {pkg.author}</span>}
            {pkg.installed && <span className="badge active">已安装</span>}
          </div>
          <div className="marketplace-card-desc">{pkg.description || '（无描述）'}</div>
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
