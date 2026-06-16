import { AlertTriangle, Clock, Download, Scale } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { PluginInfo } from '../types';

interface MarketPkg {
  name: string;
  description: string;
  version: string;
  author?: string;
  installed: boolean;
  official?: boolean;
  /** 组件类别（后端按包名分类）：功能插件 / api 契约 / 前端 */
  category?: 'plugin' | 'api' | 'client';
  removable?: boolean;
  keywords?: string[];
  downloads?: number;
  updated?: string;
  score?: number;
  insecure?: boolean;
  license?: string;
  links?: { npm?: string; homepage?: string; repository?: string };
}

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  service?: { required?: string[]; optional?: string[]; provides?: string[] };
}

type SortKey = 'relevance' | 'downloads' | 'updated' | 'score';
type Source = 'all' | 'official' | 'community';
type Status = 'all' | 'installed' | 'available';
type Category = 'all' | 'plugin' | 'api' | 'client';

const SORT_LABELS: Record<SortKey, string> = {
  relevance: '默认排序',
  downloads: '下载量',
  updated: '最近更新',
  score: '综合评分',
};
const SOURCE_LABELS: Record<Source, string> = { all: '全部来源', official: '仅官方', community: '仅社区' };
const STATUS_LABELS: Record<Status, string> = { all: '全部状态', installed: '已安装', available: '未安装' };
const CATEGORY_LABELS: Record<Category, string> = { all: '全部类型', plugin: '功能插件', api: 'API 契约', client: '前端' };

/** 1234 → 1.2k；1200000 → 1.2M */
function fmtDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** ISO 时间 → 相对中文（“3 天前”）。 */
function timeAgo(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, (Date.now() - t) / 1000);
  const units: Array<[number, string]> = [
    [31536000, '年'],
    [2592000, '个月'],
    [86400, '天'],
    [3600, '小时'],
    [60, '分钟'],
  ];
  for (const [s, label] of units) {
    if (sec >= s) return `${Math.floor(sec / s)} ${label}前`;
  }
  return '刚刚';
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
  const [loaded, setLoaded] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('relevance');
  const [source, setSource] = useState<Source>('all');
  const [status, setStatus] = useState<Status>('all');
  // 默认只看功能插件（减少心智负担）；api 契约 / 前端 一键可切
  const [category, setCategory] = useState<Category>('plugin');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  // 一次性拉全 aalis-plugin 目录（npm keyword 检索，size=100）。搜索/筛选/排序全在
  // 前端做（同 koishi：拉一次索引、本地即时过滤），不再每次按键打 npm，既能真正筛选
  // 又更跟手。安装状态在渲染期按当前 plugins 实时合并，故本函数不依赖 plugins。
  const loadRegistry = useCallback(async () => {
    setLoading(true);
    setWarning(null);
    try {
      const res = await api<{ packages: MarketPkg[]; warning?: string }>('/api/marketplace?q=');
      setRegistry(res.packages ?? []);
      if (res.warning) setWarning(res.warning);
    } catch {
      showToast('无法加载插件市场');
    }
    setLoading(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    loadRegistry();
  }, [loadRegistry]);

  const installedNames = useMemo(() => new Set(plugins.map(p => p.name)), [plugins]);

  // 合并实时安装状态 + 本地筛选（来源/状态/搜索词）+ 排序。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const view = registry
      .map(p => ({ ...p, installed: p.installed || installedNames.has(p.name) }))
      .filter(p => {
        if (category !== 'all' && (p.category ?? 'plugin') !== category) return false;
        if (source === 'official' && !p.official) return false;
        if (source === 'community' && p.official) return false;
        if (status === 'installed' && !p.installed) return false;
        if (status === 'available' && p.installed) return false;
        if (q) {
          const hay = `${p.name} ${p.description} ${(p.keywords ?? []).join(' ')} ${p.author ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    if (sort === 'relevance') return view;
    return view.sort((a, b) => {
      if (sort === 'downloads') return (b.downloads ?? 0) - (a.downloads ?? 0);
      if (sort === 'score') return (b.score ?? 0) - (a.score ?? 0);
      if (sort === 'updated') return Date.parse(b.updated ?? '0') - Date.parse(a.updated ?? '0');
      return 0;
    });
  }, [registry, installedNames, search, sort, source, status, category]);

  const handleInstall = async (name: string, official?: boolean) => {
    // 装前披露：先拉 manifest（aalis.service：需要/提供哪些服务），让 owner 知情同意。
    // 安装第三方代码 = 高危：装后该插件以你授予的能力运行。
    let svcLine = '';
    try {
      const { manifest } = await api<{ manifest: PluginManifest | null }>(
        `/api/marketplace/manifest?name=${encodeURIComponent(name)}`,
      );
      const s = manifest?.service;
      if (s) {
        const parts: string[] = [];
        if (s.required?.length) parts.push(`需要服务: ${s.required.join(', ')}`);
        if (s.optional?.length) parts.push(`可选服务: ${s.optional.join(', ')}`);
        if (s.provides?.length) parts.push(`提供服务: ${s.provides.join(', ')}`);
        if (parts.length) svcLine = `\n\n该插件声明：\n${parts.join('\n')}`;
      }
    } catch {
      /* manifest 拉取失败不阻断安装，仅少了披露 */
    }
    const src = official ? '官方插件' : '第三方社区插件';
    if (
      !window.confirm(
        `将从 npm 安装${src}「${name}」。${svcLine}\n\n安装后它会以你授予的能力运行（可在权限页查看其依赖与权限）。请确认来源可信。\n\n继续安装？`,
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

  const handleUninstall = async (name: string) => {
    if (
      !window.confirm(
        `确定卸载「${name}」？\n\n将删除其代码目录并清除残留配置。不可恢复，但可从市场重新安装。\n\n继续卸载？`,
      )
    ) {
      return;
    }
    setInstalling(name);
    try {
      const res = await api<{ ok?: boolean; error?: string; message?: string }>('/api/marketplace/uninstall', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        showToast(res.message ?? `${name} 已卸载`);
        onRefresh();
      } else {
        showToast(res.error ?? '卸载失败');
      }
    } catch {
      showToast('卸载失败');
    }
    setInstalling(null);
  };

  return (
    <div className="page-content page-marketplace">
      {toast && <div className="toast">{toast}</div>}

      <div className="section-label">
        插件市场
        {loaded && (
          <span className="market-count">
            显示 {filtered.length} / 共 {registry.length}
          </span>
        )}
      </div>

      <div className="market-filter-row">
        <input
          className="config-edit-input"
          style={{ flex: 1, minWidth: 180 }}
          placeholder="搜索插件（名称 / 描述 / 关键词 / 作者）"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="config-edit-input"
          value={category}
          onChange={e => setCategory(e.target.value as Category)}
          title="组件类型"
        >
          {(Object.keys(CATEGORY_LABELS) as Category[]).map(k => (
            <option key={k} value={k}>
              {CATEGORY_LABELS[k]}
            </option>
          ))}
        </select>
        <select className="config-edit-input" value={source} onChange={e => setSource(e.target.value as Source)}>
          {(Object.keys(SOURCE_LABELS) as Source[]).map(k => (
            <option key={k} value={k}>
              {SOURCE_LABELS[k]}
            </option>
          ))}
        </select>
        <select className="config-edit-input" value={status} onChange={e => setStatus(e.target.value as Status)}>
          {(Object.keys(STATUS_LABELS) as Status[]).map(k => (
            <option key={k} value={k}>
              {STATUS_LABELS[k]}
            </option>
          ))}
        </select>
        <select className="config-edit-input" value={sort} onChange={e => setSort(e.target.value as SortKey)} title="排序">
          {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <button className="btn-sm" onClick={() => loadRegistry()} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>

      {!loaded && loading && (
        <div className="empty-hint" style={{ padding: 16 }}>
          正在从 npm 加载带 <code>aalis-plugin</code> 标签的插件…
        </div>
      )}

      {warning && (
        <div className="empty-hint" style={{ padding: 12, color: 'var(--warning, #ffb300)' }}>
          {warning}
        </div>
      )}

      {loaded && filtered.length === 0 && !loading && !warning && (
        <div className="empty-hint" style={{ padding: 16 }}>
          {registry.length === 0 ? '未找到任何插件' : '无匹配项 —— 试试调整搜索词或筛选条件'}
        </div>
      )}

      <div className="marketplace-grid">
        {filtered.map(pkg => {
          const homeLink = pkg.links?.homepage || pkg.links?.repository || pkg.links?.npm;
          return (
            <div className="marketplace-card" key={pkg.name}>
            <div className="marketplace-card-info">
              {homeLink ? (
                <a className="marketplace-card-name" href={homeLink} target="_blank" rel="noreferrer">
                  {pkg.name}
                </a>
              ) : (
                <span className="marketplace-card-name">{pkg.name}</span>
              )}
              <span className="marketplace-card-version">v{pkg.version}</span>
              <span className={`badge ${pkg.official ? 'official' : 'community'}`}>{pkg.official ? '官方' : '社区'}</span>
              {pkg.category && pkg.category !== 'plugin' && (
                <span className="badge" title="组件类别">{pkg.category === 'api' ? 'API 契约' : '前端'}</span>
              )}
              {pkg.insecure && (
                <span
                  className="badge"
                  style={{ background: 'var(--danger)', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  title="npm 标记为不安全包，谨慎安装"
                >
                  <AlertTriangle size={11} /> 不安全
                </span>
              )}
              {pkg.author && <span className="marketplace-card-author">by {pkg.author}</span>}
              {pkg.installed && <span className="badge active">已安装</span>}
            </div>

            <div className="marketplace-card-desc">{pkg.description || '（无描述）'}</div>

            {pkg.keywords && pkg.keywords.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {pkg.keywords.slice(0, 6).map(k => (
                  <button type="button" key={k} className="market-kw" title={`按 “${k}” 筛选`} onClick={() => setSearch(k)}>
                    {k}
                  </button>
                ))}
              </div>
            )}

            <div className="market-meta">
              {pkg.downloads != null && (
                <span className="market-meta-item" title="近一月下载量">
                  <Download size={12} /> {fmtDownloads(pkg.downloads)}/月
                </span>
              )}
              {pkg.updated && (
                <span className="market-meta-item" title={new Date(pkg.updated).toLocaleString()}>
                  <Clock size={12} /> {timeAgo(pkg.updated)}
                </span>
              )}
              {pkg.license && (
                <span className="market-meta-item" title="许可证">
                  <Scale size={12} /> {pkg.license}
                </span>
              )}
            </div>

            <div style={{ marginTop: 8 }}>
              {!pkg.installed && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => handleInstall(pkg.name, pkg.official)}
                  disabled={installing === pkg.name}
                >
                  {installing === pkg.name ? '安装中...' : '安装'}
                </button>
              )}
              {pkg.installed && pkg.removable && (
                <button
                  className="btn btn-sm"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => handleUninstall(pkg.name)}
                  disabled={installing === pkg.name}
                  title="卸载插件（删包 + 清配置）"
                >
                  {installing === pkg.name ? '处理中...' : '卸载'}
                </button>
              )}
            </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
