import { AlertTriangle, Clock, Download, Scale } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { type DepGraph, InstallDepDisclosure, UninstallDepWarning } from '../components/DependencyTree';
import type { PluginInfo } from '../types';

interface MarketPkg {
  name: string;
  description: string;
  /** npm 上的最新版。**不是**本地已装版本，那是 resolved。 */
  version: string;
  /** 本地已装版本。未装或读不到则缺省。**判可更新看 updatable，别自己比版本。** */
  resolved?: string;
  /** 根 package.json 里的原始声明（`^0.9.1` / `workspace:*` / `file:../x`）。 */
  request?: string;
  /** 本地这份从哪来（后端按根 package.json 的依赖声明判定）。展示来源徽章用。 */
  origin?: PkgOrigin;
  /** 此刻能否经市场更新。后端算（来源 + 版本序），与更新闸同一份实现。 */
  updatable?: boolean;
  author?: string;
  installed: boolean;
  official?: boolean;
  /** 组件类别（后端按类型关键词分类）：功能插件 / api 契约 / 数据规范 / 前端界面 / 工具库 / 内核 / 宿主 */
  category?: Exclude<Category, 'all'>;
  keywords?: string[];
  downloads?: number;
  updated?: string;
  score?: number;
  insecure?: boolean;
  license?: string;
  links?: { npm?: string; homepage?: string; repository?: string };
}

/** 镜像后端 PkgOrigin（`@aalis/util-dep-spec` 的 DepOrigin）。判据是根 package.json 的依赖声明，非文件路径。 */
type PkgOrigin = 'registry' | 'workspace' | 'link' | 'git' | 'alias' | 'transitive';

/** 镜像 /api/system-components 的条目（core / runtime / api / schema / util）。 */
interface SystemComponent {
  name: string;
  version?: string;
  latest?: string;
  request?: string;
  description?: string;
  kind: 'core' | 'runtime' | 'api' | 'schema' | 'util';
  updatable?: boolean;
}

/** 非 registry 来源的角标与解释——市场更新对它们无效，说明原因好过给一个按不动的按钮。 */
const ORIGIN_BADGE: Record<Exclude<PkgOrigin, 'registry'>, { label: string; hint: string }> = {
  workspace: { label: '工作区', hint: '源码在本仓库内，改代码即生效，不经市场更新' },
  link: { label: '本地链接', hint: '由 file: / link: 指向本地目录，更新请改那份源码' },
  git: { label: '外部源', hint: '由 git / URL / user-repo 简写安装，更新请改依赖声明' },
  alias: { label: '别名', hint: '由 npm: 别名指向另一个包，市场更新会拆掉别名，故不提供' },
  transitive: { label: '依赖引入', hint: '由其它包引入，版本随父包的范围，不单独更新' },
};

type SortKey = 'relevance' | 'downloads' | 'updated' | 'score';
type Source = 'all' | 'official' | 'community';
type Status = 'all' | 'installed' | 'available';
// core / runtime 不经 npm 关键词检索（关键词是开放命名空间，任何人都能发一个带
// aalis-core 关键词的包冒充内核），它们由 /api/system-components 从**本地已装 + 根依赖**
// 取得，在这里与检索结果合并——市场是更新的统一入口，用户不该为了升级内核换一个页面。
type Category = 'all' | 'plugin' | 'api' | 'schema' | 'interface' | 'util' | 'core' | 'runtime';

const SORT_LABELS: Record<SortKey, string> = {
  relevance: '默认排序',
  downloads: '下载量',
  updated: '最近更新',
  score: '综合评分',
};
const SOURCE_LABELS: Record<Source, string> = { all: '全部来源', official: '仅官方', community: '仅社区' };
const STATUS_LABELS: Record<Status, string> = { all: '全部状态', installed: '已安装', available: '未安装' };
const CATEGORY_LABELS: Record<Category, string> = {
  all: '全部类型',
  plugin: '功能插件',
  interface: '前端界面',
  core: '内核',
  runtime: '宿主',
  api: 'API 契约',
  schema: '数据规范',
  util: '工具库',
};

/**
 * 只有功能插件与前端界面是**用户主动装**的。
 *
 * 其余五类要么随脚手架就位（core / runtime），要么作为插件依赖被 npm 自动带入、
 * 卸载时自动剪枝（api / schema / util）——单独装一个 `-api` 包零效果（不带
 * `aalis-plugin` 关键词，加载器不收）。展示它们是为了让用户看见实例里有什么、
 * 版本多少、能否更新，不是让人去装。
 */
const INSTALLABLE_CATEGORIES: ReadonlySet<string> = new Set(['plugin', 'interface']);

/**
 * 更新接口的响应。
 *
 * `error` 与 `message` 是**两条不同来源**：路由自身的 400/503/500 分支只给 `error`
 * （无 ok/无 message），服务层的结构化失败走 HTTP 200 + `{ok:false, message}`。
 * 只读其一就会得到一个没有任何文字的红框——曾实测发生：服务未启用、超过 50 个上限、
 * npm 报错三条全部渲染成空白。
 */
interface UpdateResult {
  ok?: boolean;
  message?: string;
  error?: string;
  conflicts?: string[];
  restarting?: boolean;
}

/**
 * 一次批量更新的目标上限，与服务端 `MAX_UPDATE_TARGETS` 对齐。
 * 「全选」按此截断而非全量勾上：超限时服务端 400 整批拒绝，而那恰恰是本面板最该工作的
 * 场景（一次协调发版后一大批包同时可更新）。
 */
const MAX_UPDATE_TARGETS = 50;

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
  onRestart,
}: {
  plugins: PluginInfo[];
  onRefresh: () => void;
  /** 更新提交后进程会重启，交由外层进入「等待重连」态。 */
  onRestart?: (msg: string) => void;
}) {
  const { confirm, dialog } = useConfirm();
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
  // 默认只看功能插件（减少心智负担）；其余类别一键可切
  const [category, setCategory] = useState<Category>('plugin');
  // 批量更新：市场是更新的**统一入口**——插件与内核可能必须一起更新（插件新版要求更高的
  // core 时，peer 预检会整批拒绝），分在两个页面用户就勾不到一起。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);

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
      // 两个数据源合并：npm 关键词检索（可装组件）+ 本地已装的系统组件（core/runtime 等，
      // 它们**不进检索轴**——关键词是开放命名空间，谁都能发个带 aalis-core 的包冒充内核）。
      // 合并在前端做，后端两条路各自的信任来源不混。
      const [res, sys] = await Promise.all([
        api<{ packages: MarketPkg[]; warning?: string }>('/api/marketplace?q='),
        api<{ components: SystemComponent[] }>('/api/system-components').catch(() => ({ components: [] })),
      ]);
      const fromNpm = res.packages ?? [];
      const seen = new Set(fromNpm.map(p => p.name));
      const extra: MarketPkg[] = (sys.components ?? [])
        .filter(c => !seen.has(c.name)) // 检索已覆盖的不重复加
        .map(c => ({
          name: c.name,
          description: c.description ?? '',
          version: c.latest ?? c.version ?? '',
          resolved: c.version,
          request: c.request,
          origin: c.updatable ? 'registry' : 'transitive',
          // 系统组件的 updatable 由 /api/system-components 算好（来源 + latest 版本序），直接沿用。
          updatable: c.updatable ?? false,
          installed: true,
          official: c.name.startsWith('@aalis/'),
          category: c.kind,
        }));
      setRegistry([...fromNpm, ...extra]);
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

  /**
   * 可更新完全由服务端判定（来源是 registry + 版本严格新于本地）。
   *
   * 前端**不再自算**：曾经这里写 `p.resolved !== p.version` 再叠一个 origin 判断，与服务端的
   * 更新闸是两份实现，实测出过两类错——字符串不等把「registry 的 latest 低于本地」渲染成
   * 可更新并真的降级重启；GitHub 简写依赖出了勾选框却在提交后被闸整批否决。
   */
  const updatable = useMemo(() => registry.filter(p => p.updatable), [registry]);
  // 勾选集随可更新列表收敛：刷新后不再可更新的项不该继续留在待更新集里。
  useEffect(() => {
    setSelected(prev => {
      const names = new Set(updatable.map(p => p.name));
      const next = new Set([...prev].filter(n => names.has(n)));
      return next.size === prev.size ? prev : next;
    });
  }, [updatable]);

  const selectedTargets = updatable.filter(p => selected.has(p.name));
  const willFullRestart = selectedTargets.some(p => p.category === 'core' || p.category === 'runtime');

  const toggleSelected = (name: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const applyUpdates = async () => {
    if (selectedTargets.length === 0 || updating) return;
    setUpdating(true);
    setUpdateResult(null);
    try {
      const r = await api<UpdateResult>('/api/marketplace/update', {
        method: 'POST',
        body: JSON.stringify({ targets: selectedTargets.map(p => ({ name: p.name, version: p.version })) }),
      });
      setUpdateResult(r);
      // 服务端已提交安装并触发重启——本页不再自行刷新，交给外层进入等待重连态。
      if (r.ok && r.restarting) onRestart?.(`正在应用 ${selectedTargets.length} 项更新并重启…`);
    } catch (err) {
      setUpdateResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
    setUpdating(false);
  };

  // 合并实时安装状态 + 本地筛选（来源/状态/搜索词）+ 排序。
  const filtered = useMemo(() => {
    // 空格分词 = 多关键词 AND（如「webui interface」需同时命中）；空词跳过。
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const view = registry
      .map(p => ({ ...p, installed: p.installed || installedNames.has(p.name) }))
      .filter(p => {
        if (category !== 'all' && (p.category ?? 'plugin') !== category) return false;
        if (source === 'official' && !p.official) return false;
        if (source === 'community' && p.official) return false;
        if (status === 'installed' && !p.installed) return false;
        if (status === 'available' && p.installed) return false;
        if (terms.length) {
          const hay = `${p.name} ${p.description} ${(p.keywords ?? []).join(' ')} ${p.author ?? ''}`.toLowerCase();
          if (!terms.every(t => hay.includes(t))) return false;
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
    // 装前披露：拉依赖图（import 依赖树 + 服务需/供含提供者解析 + 已装依赖者），让 owner 知情同意。
    // 安装第三方代码 = 高危：装后该插件以你授予的能力运行。
    let graph: DepGraph | null = null;
    try {
      graph = await api<DepGraph>(`/api/marketplace/depgraph?name=${encodeURIComponent(name)}`);
    } catch {
      /* 依赖图拉取失败不阻断安装，仅少了披露 */
    }
    const src = official ? '官方插件' : '第三方社区插件';
    const ok = await confirm({
      title: `安装${src}「${name}」`,
      body: (
        <>
          {graph && <InstallDepDisclosure graph={graph} />}
          <div className="dep-note">将从 npm 安装。安装后它以你授予的能力运行（可在权限页查看依赖与权限）。请确认来源可信。</div>
        </>
      ),
      confirmLabel: '安装',
    });
    if (!ok) return;
    setInstalling(name);
    try {
      const res = await api<{ ok?: boolean; error?: string; message?: string }>('/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        // 展示服务端原话而非固定文案：它区分了「已安装并加载」与「已安装但未发现新插件」，
        // 后者恰恰是需要用户知道的失败态。旧文案还谎称「正在重启」——安装路径从不触发重启。
        showToast(res.message ?? `${name} 已安装`);
        onRefresh();
        // 市场卡片的已装态来自 /api/marketplace 的快照，onRefresh 只刷运行时插件列表：
        // 不重拉市场，装完的 interface 类包（不是运行时插件，永不进 plugins 列表）会一直显示「安装」。
        loadRegistry();
      } else {
        // error 只有路由自身的 400/503/500 分支才有；服务层的结构化失败走 message + HTTP 200。
        // 少读一个就会把「它声明为插件却未被加载」「根依赖含 workspace: 协议」这类可操作的
        // 诊断整条吞掉，用户只看到「安装失败」四个字。
        showToast(res.error ?? res.message ?? '安装失败');
      }
    } catch {
      showToast('安装失败');
    }
    setInstalling(null);
  };

  const handleUninstall = async (name: string) => {
    // 卸前披露：拉依赖图，列出真实依赖者——服务依赖者（将被 409 拒）+ import 依赖者（删后可能起不来）。
    // 取代旧的「按类别拍脑袋」静态警告（既误报又漏报）。
    let graph: DepGraph | null = null;
    try {
      graph = await api<DepGraph>(`/api/marketplace/depgraph?name=${encodeURIComponent(name)}`);
    } catch {
      /* 拉取失败退回无预警 */
    }
    const ok = await confirm({
      title: `卸载「${name}」`,
      body: (
        <>
          {graph && <UninstallDepWarning graph={graph} />}
          <div className="dep-note">将删除其代码目录并清除残留配置。不可恢复，但可从市场重新安装。</div>
        </>
      ),
      confirmLabel: '卸载',
      danger: true,
    });
    if (!ok) return;
    setInstalling(name);
    try {
      const res = await api<{ ok?: boolean; error?: string; message?: string }>('/api/marketplace/uninstall', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        showToast(res.message ?? `${name} 已卸载`);
        onRefresh();
        // 同 install：不重拉市场，registry 快照里的 installed:true 会让卡片继续显示「卸载」按钮。
        loadRegistry();
      } else {
        showToast(res.error ?? res.message ?? '卸载失败'); // 同 install：服务层失败走 message
      }
    } catch {
      showToast('卸载失败');
    }
    setInstalling(null);
  };

  return (
    <div className="page-content page-marketplace">
      {dialog}
      {toast && <div className="toast">{toast}</div>}

      <div className="section-label">
        插件市场
        {loaded && (
          <span className="market-count">
            显示 {filtered.length} / 共 {registry.length}
          </span>
        )}
      </div>

      {updatable.length > 0 && (
        <div className="update-panel">
          <div className="update-panel-head">
            <span>
              可更新 {updatable.length} 项，已选 {selectedTargets.length}
            </span>
            <div className="update-panel-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSelected(new Set(updatable.slice(0, MAX_UPDATE_TARGETS).map(p => p.name)))}
                disabled={updating}
              >
                {updatable.length > MAX_UPDATE_TARGETS ? `全选（前 ${MAX_UPDATE_TARGETS} 项）` : '全选'}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={applyUpdates}
                disabled={updating || selectedTargets.length === 0}
              >
                {updating ? '正在更新…' : `更新所选（${selectedTargets.length}）`}
              </button>
            </div>
          </div>
          {willFullRestart && (
            <div className="update-panel-warn">
              <AlertTriangle size={14} /> 所选包含内核或宿主，更新后将重启整个应用；新版本起不来会自动回滚。
            </div>
          )}
          <div className="update-panel-note">
            所选项**一次性提交**：先整组做依赖预检，通过后一次安装、一次重启。任一项的 peer
            版本不兼容则整批不执行且不改动任何文件——此时把它要求的包（如内核）一并勾选再试。
          </div>
        </div>
      )}

      {updateResult && (
        <div className={updateResult.ok ? 'update-result ok' : 'update-result err'}>
          {/* error 与 message 两条来源都要读，否则路由的 400/503/500 会渲染成空红框（见 UpdateResult 注释）。 */}
          <div>{updateResult.error ?? updateResult.message ?? '更新失败'}</div>
          {updateResult.conflicts && updateResult.conflicts.length > 0 && (
            <ul className="update-conflicts">
              {updateResult.conflicts.map(c => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      )}

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
          // 只接受 http(s) 链接做 href —— npm 搜索结果原样透传，恶意包可塞 homepage:"javascript:..."
          // (React 19 不净化 javascript: href，只 dev 警告) → owner 点卡片即 XSS。非 http(s) 退化为纯文本。
          const rawLink = pkg.links?.homepage || pkg.links?.repository || pkg.links?.npm;
          const homeLink = rawLink && /^https?:\/\//i.test(rawLink) ? rawLink : undefined;
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
              {/*
                已装时展示本地版本（resolved），未装时展示 npm 最新版。两者混同会让用户以为自己装的就是最新版。
                已装但 resolved 缺失（版本号读不到）时显示「版本未知」而**不回退到 npm latest**——
                回退正是这条注释要防的事：那会把远端版本号当成本地已装版本显示。
              */}
              <span className="marketplace-card-version">
                {pkg.installed ? (pkg.resolved ? `v${pkg.resolved}` : '版本未知') : `v${pkg.version}`}
              </span>
              <span className={`badge ${pkg.official ? 'official' : 'community'}`}>{pkg.official ? '官方' : '社区'}</span>
              {pkg.category && pkg.category !== 'plugin' && (
                <span className="badge" title="组件类别">{CATEGORY_LABELS[pkg.category]}</span>
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
              {/* 非 registry 来源先判：它们更新不了，提示原因而非「可更新」。 */}
              {pkg.installed && pkg.origin && pkg.origin !== 'registry' && (
                <span className="badge" title={ORIGIN_BADGE[pkg.origin].hint}>
                  {ORIGIN_BADGE[pkg.origin].label}
                </span>
              )}
              {pkg.installed && pkg.origin === 'registry' && pkg.resolved && pkg.version && pkg.resolved !== pkg.version && (
                // 徽章即勾选框——此前它只是个悬空提示，点不动
                <label
                  className="badge"
                  style={{ background: 'var(--warning)', color: '#1a1a1a', cursor: 'pointer' }}
                  title={`本地 v${pkg.resolved}（声明 ${pkg.request ?? '?'}），npm 最新 v${pkg.version}。勾选后用顶部「更新所选」批量提交`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(pkg.name)}
                    onChange={() => toggleSelected(pkg.name)}
                    disabled={updating}
                    style={{ marginRight: 4 }}
                  />
                  可更新 v{pkg.version}
                </label>
              )}
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
              {/* 只有功能插件与前端界面给装卸按钮——其余五类随脚手架就位或随插件自动装/剪枝，
                  单独装一个 -api 包零效果（不带 aalis-plugin 关键词，加载器不收）。
                  任一操作进行中就全禁：服务层是串行闸（一次一个），只锁当前卡片的话
                  用户点得动别的卡片，却只会撞上后端的「有操作正在进行中」。 */}
              {!INSTALLABLE_CATEGORIES.has(pkg.category ?? 'plugin') && (
                <span className="market-meta-item" title="随脚手架就位或作为插件依赖自动安装/卸载，无需也无法单独装卸">
                  随依赖管理
                </span>
              )}
              {INSTALLABLE_CATEGORIES.has(pkg.category ?? 'plugin') && !pkg.installed && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => handleInstall(pkg.name, pkg.official)}
                  disabled={installing !== null}
                  title={installing && installing !== pkg.name ? `请等待 ${installing} 处理完成` : undefined}
                >
                  {installing === pkg.name ? '安装中...' : '安装'}
                </button>
              )}
              {INSTALLABLE_CATEGORIES.has(pkg.category ?? 'plugin') && pkg.installed && (
                <button
                  className="btn btn-sm"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => handleUninstall(pkg.name)}
                  disabled={installing !== null}
                  title={
                    installing && installing !== pkg.name
                      ? `请等待 ${installing} 处理完成`
                      : '卸载插件（删包 + 清配置）'
                  }
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
