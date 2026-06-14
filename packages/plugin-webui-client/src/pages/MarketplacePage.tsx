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
  removable?: boolean;
  keywords?: string[];
  downloads?: number;
  updated?: string;
  score?: number;
  scoreDetail?: { quality?: number; popularity?: number; maintenance?: number };
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

const SORT_LABELS: Record<SortKey, string> = {
  relevance: '相关度',
  downloads: '下载量',
  updated: '最近更新',
  score: '综合评分',
};

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

/** npm 综合评分 0~1 → 5 星字符串。 */
function stars(score?: number): string {
  if (score == null) return '';
  const full = Math.round(score * 5);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
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
  const [sort, setSort] = useState<SortKey>('relevance');

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
        setRegistry(
          (res.packages ?? []).map(p => ({ ...p, installed: p.installed || installedNames.has(p.name) })),
        );
        if (res.warning) setWarning(res.warning);
      } catch {
        showToast('无法加载插件市场');
      }
      setLoading(false);
      setSearched(true);
    },
    [plugins],
  );

  // 进入页面自动加载 + 搜索防抖：search 变化（含 mount 时空串）350ms 触发查询，
  // 无需手动点“加载市场”。防抖合并连续输入，避免每键一次请求。
  useEffect(() => {
    const t = setTimeout(() => loadRegistry(search), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [search, loadRegistry]);

  // 客户端排序（服务端已 size=100 拉全，纯前端排序无需再请求）。relevance=保留服务端顺序。
  const sorted = useMemo(() => {
    if (sort === 'relevance') return registry;
    const arr = [...registry];
    arr.sort((a, b) => {
      if (sort === 'downloads') return (b.downloads ?? 0) - (a.downloads ?? 0);
      if (sort === 'score') return (b.score ?? 0) - (a.score ?? 0);
      if (sort === 'updated') return Date.parse(b.updated ?? '0') - Date.parse(a.updated ?? '0');
      return 0;
    });
    return arr;
  }, [registry, sort]);

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

      <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        插件市场
        <input
          className="config-edit-input"
          style={{ flex: 1, maxWidth: 320 }}
          placeholder="搜索插件（名称 / 关键词）"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="config-edit-input"
          style={{ maxWidth: 130 }}
          value={sort}
          onChange={e => setSort(e.target.value as SortKey)}
          title="排序方式"
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <button className="btn-sm" onClick={() => loadRegistry(search)} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>

      {!searched && loading && (
        <div className="empty-hint" style={{ padding: 16 }}>
          正在从 npm 加载带 <code>aalis-plugin</code> 标签的插件…
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

      {sorted.map(pkg => {
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
              {pkg.insecure && (
                <span className="badge" style={{ background: '#e5484d', color: '#fff' }} title="npm 标记为不安全包，谨慎安装">
                  ⚠ 不安全
                </span>
              )}
              {pkg.author && <span className="marketplace-card-author">by {pkg.author}</span>}
              {pkg.installed && <span className="badge active">已安装</span>}
            </div>

            <div className="marketplace-card-desc">{pkg.description || '（无描述）'}</div>

            {pkg.keywords && pkg.keywords.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {pkg.keywords.slice(0, 5).map(k => (
                  <span
                    key={k}
                    style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'var(--chip-bg, #2a2a35)', opacity: 0.85 }}
                  >
                    {k}
                  </span>
                ))}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                marginTop: 6,
                fontSize: 11,
                opacity: 0.7,
                alignItems: 'center',
              }}
            >
              {pkg.downloads != null && <span title="近一月下载量">⬇ {fmtDownloads(pkg.downloads)}/月</span>}
              {pkg.updated && <span title={new Date(pkg.updated).toLocaleString()}>🕑 {timeAgo(pkg.updated)}</span>}
              {pkg.score != null && (
                <span
                  style={{ color: '#f5a623' }}
                  title={
                    pkg.scoreDetail
                      ? `质量 ${((pkg.scoreDetail.quality ?? 0) * 100).toFixed(0)}% · 人气 ${((pkg.scoreDetail.popularity ?? 0) * 100).toFixed(0)}% · 维护 ${((pkg.scoreDetail.maintenance ?? 0) * 100).toFixed(0)}%`
                      : `综合评分 ${(pkg.score * 100).toFixed(0)}%`
                  }
                >
                  {stars(pkg.score)}
                </span>
              )}
              {pkg.license && <span title="许可证">⚖ {pkg.license}</span>}
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
                  style={{ color: '#e5484d' }}
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
  );
}
