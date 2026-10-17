import type { MarketplacePackage, SystemComponent } from '@aalis/api-webui';
import { type TextRef, textClauses } from '@aalis/schema-i18n';
import { Package, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useReducer, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { FetchError, LogsLink } from '../components/FetchError';
import { IconButton } from '../components/IconButton';
import { Panel } from '../components/Panel';
import { Select } from '../components/Select';
import { useToast } from '../components/Toast';
import { listTime, lower } from '../format';
import { text, tr } from '../language';
import { getJson, isRecord, postJson } from '../rest';
import { paths } from '../routes';
import { Main } from '../shell/Shell';
import { t } from '../texts';
import { messageOf, usePluginAction } from './action';
import { UninstallWarning } from './disclosure';
import { InstallDialog } from './InstallDialog';
import { strings, useHost, usePackageManager } from './list';
import './Market.css';

// 市场：npm 上带 Aalis 类型关键词的包，加上本地已装的系统组件（内核、宿主、契约、规范、工具库，它们不经关键词检索，
// 免得有人发个同名关键词的包冒充）。插件与前端界面可以装卸，系统组件只能更新；「可更新」由服务端判定，前端不自己比版本。
// 筛选与搜索在本页做，搜索也匹配包声明提供的服务；装卸更新同一时刻只做一个（服务端一次只受理一个）。装上插件后跳到它的配置区

/** 一行：检索出的包，或并进来的系统组件（类别另有内核与宿主） */
type MarketItem = Omit<MarketplacePackage, 'category'> & {
  category: MarketplacePackage['category'] | SystemComponent['kind'];
};
type Category = MarketItem['category'];
type Origin = NonNullable<MarketItem['origin']>;

/** 只有插件与前端界面是自己装的；其余随脚手架就位，或随依赖它的插件自动装卸 */
const INSTALLABLE: ReadonlySet<Category> = new Set(['plugin', 'interface']);

const KINDS = {
  plugin: t('plugins'),
  interface: t('marketKindInterface'),
  system: t('marketKindSystem'),
  all: t('all'),
};
type Kind = keyof typeof KINDS;
const kindOf = (category: Category): Exclude<Kind, 'all'> =>
  category === 'plugin' || category === 'interface' ? category : 'system';

const STATES = { all: t('marketStateAll'), installed: t('installed'), available: t('marketStateAvailable') };
type State = keyof typeof STATES;

const choicesOf = (labels: Readonly<Record<string, TextRef>>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label: text(label) }));

/** 非 registry 来源：市场更新不了，写明原因 */
const ORIGINS: Record<Exclude<Origin, 'registry'>, TextRef> = {
  workspace: t('originWorkspace'),
  link: t('originLink'),
  git: t('originGit'),
  alias: t('originAlias'),
  transitive: t('originTransitive'),
};

const CATEGORY_NAMES: Record<Category, TextRef> = {
  plugin: t('categoryPlugin'),
  interface: t('categoryInterface'),
  api: t('categoryApi'),
  schema: t('categorySchema'),
  util: t('categoryUtil'),
  core: t('categoryCore'),
  runtime: t('categoryRuntime'),
};

/** GET /api/marketplace 的回应；「开始使用」也用它。旧版服务端的包没有 provides，按没有声明提供服务处理 */
export function parseMarket(body: unknown): { packages: MarketplacePackage[]; warning?: string } {
  if (
    !isRecord(body) ||
    !Array.isArray(body.packages) ||
    !body.packages.every(pkg => isRecord(pkg) && typeof pkg.name === 'string')
  ) {
    throw new Error(tr('marketMalformed'));
  }
  return {
    packages: body.packages.map(pkg => ({ ...pkg, provides: strings(pkg.provides) })) as MarketplacePackage[],
    warning: typeof body.warning === 'string' ? body.warning : undefined,
  };
}

/** 本地已装的系统组件，并进检索结果（检索已有的不再加）；取不到时只少这一部分，写明原因 */
async function systemComponents(signal: AbortSignal): Promise<{ packages: MarketItem[]; warning?: string }> {
  try {
    const body = await getJson('/api/system-components', signal);
    const components = (isRecord(body) && Array.isArray(body.components)
      ? body.components.filter(isRecord)
      : []) as unknown as SystemComponent[];
    return {
      packages: components.map(component => ({
        name: component.name,
        description: component.description ?? '',
        version: component.latest ?? '',
        resolved: component.version,
        origin: component.origin,
        updatable: component.updatable,
        installed: true,
        official: component.name.startsWith('@aalis/'),
        category: component.kind,
        provides: [],
      })),
      warning: isRecord(body) && typeof body.warning === 'string' ? body.warning : undefined,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { packages: [], warning: tr('systemComponentsFailed', { error: (error as Error).message }) };
  }
}

async function loadMarket(signal: AbortSignal) {
  const [market, system] = await Promise.all([
    getJson('/api/marketplace?q=', signal).then(parseMarket),
    systemComponents(signal),
  ]);
  const listed = new Set(market.packages.map(pkg => pkg.name));
  return {
    packages: [...market.packages, ...system.packages.filter(pkg => !listed.has(pkg.name))],
    warnings: [market.warning, system.warning].filter((text): text is string => text !== undefined),
  };
}

/** 1234 → 1.2k */
const downloads = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1_000
      ? `${(count / 1_000).toFixed(1)}k`
      : `${count}`;

/** 只认 http、https 的链接：检索结果原样透传，恶意包可以塞 javascript: 地址 */
const safeLink = (pkg: MarketItem) => {
  const link = pkg.links?.homepage ?? pkg.links?.repository ?? pkg.links?.npm;
  return link && /^https?:\/\//i.test(link) ? link : undefined;
};

export function Market() {
  const [version, reload] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<{ packages?: MarketItem[]; warnings: string[]; error?: Error }>({
    warnings: [],
  });
  const [loading, setLoading] = useState(true);
  const action = usePluginAction();
  const host = useHost();
  const packageManager = usePackageManager();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('plugin');
  const [status, setStatus] = useState<State>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [updating, setUpdating] = useState(false);
  const busy = action.busy ?? (updating ? 'update' : undefined);
  const [installing, setInstalling] = useState<MarketItem>();
  /** 卸载确认框开着时是要卸的包与框里的选择 */
  const [uninstalling, setUninstalling] = useState<{ pkg: MarketItem; removeConfig: boolean }>();
  const [update, setUpdate] = useState<{ ok: boolean; message: string; conflicts: string[] }>();
  const searchId = useId();

  // version 是刷新的次数，变了就重取
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadMarket(controller.signal).then(
      ({ packages, warnings }) => {
        setState({ packages, warnings });
        setLoading(false);
      },
      (error: Error) => {
        if (controller.signal.aborted) return;
        setState(current => ({ ...current, error }));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [version]);

  const packages = state.packages ?? [];
  const updatable = packages.filter(pkg => pkg.updatable);
  const chosen = updatable.filter(pkg => selected.has(pkg.name));
  const terms = lower(query.trim()).split(/\s+/).filter(Boolean);
  const shown = packages.filter(pkg => {
    if (kind !== 'all' && kindOf(pkg.category) !== kind) return false;
    if (status === 'installed' && !pkg.installed) return false;
    if (status === 'available' && pkg.installed) return false;
    const haystack = lower([pkg.name, pkg.description, pkg.author ?? '', ...pkg.provides].join(' '));
    return terms.every(term => haystack.includes(term));
  });

  // 装卸做完连同市场一起重取
  const uninstall = async ({ pkg, removeConfig }: NonNullable<typeof uninstalling>) => {
    await action.run(
      `uninstall:${pkg.name}`,
      tr('uninstallPackage', { name: pkg.name }),
      () => postJson('/api/marketplace/uninstall', { name: pkg.name, removeConfig }),
      reply => {
        setUninstalling(undefined);
        toast({ kind: 'success', text: messageOf(reply) ?? tr('uninstalled', { name: pkg.name }) });
      },
      packageManager,
    );
    reload();
  };

  // 更新的结果写在更新条上：没过预检时逐条列出冲突。成功后应用会重启，页面随管理连接重连重新加载
  const applyUpdates = async () => {
    setUpdating(true);
    setUpdate(undefined);
    try {
      const reply = await postJson('/api/marketplace/update', {
        targets: chosen.map(pkg => ({ name: pkg.name, version: pkg.version })),
      });
      const body = isRecord(reply) ? reply : {};
      const ok = body.ok === true;
      setUpdate({
        ok,
        message: typeof body.message === 'string' ? body.message : tr(ok ? 'updateSubmitted' : 'updateFailed'),
        conflicts: Array.isArray(body.conflicts) ? body.conflicts.filter(item => typeof item === 'string') : [],
      });
    } catch (err) {
      setUpdate({ ok: false, message: (err as Error).message, conflicts: [] });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Main>
      <Panel
        title={tr('market')}
        back={paths.plugins}
        actions={<IconButton icon={RotateCw} label={tr('refresh')} disabled={loading} onClick={reload} />}
        banner={state.warnings.length > 0 ? text(textClauses(state.warnings)) : undefined}
      >
        <div className="page-screen market">
          <div className="market-filters">
            <label htmlFor={searchId} className="visually-hidden">
              {tr('search')}
            </label>
            <input
              id={searchId}
              type="search"
              value={query}
              placeholder={tr('marketSearchPlaceholder')}
              onChange={event => setQuery(event.target.value)}
            />
            <Select
              aria-label={tr('type')}
              value={kind}
              options={choicesOf(KINDS)}
              onChange={value => setKind(value as Kind)}
            />
            <Select
              aria-label={tr('status')}
              value={status}
              options={choicesOf(STATES)}
              onChange={value => setStatus(value as State)}
            />
          </div>
          {updatable.length > 0 && (
            <div className="market-updates">
              <p className="market-updates-text">
                {tr('marketUpdatable', { updatable: updatable.length, chosen: chosen.length })}
              </p>
              <Button
                variant="text"
                disabled={busy !== undefined}
                onClick={() => setSelected(new Set(updatable.map(pkg => pkg.name)))}
              >
                {tr('selectAll')}
              </Button>
              <Button
                variant="primary"
                busy={busy === 'update'}
                disabled={chosen.length === 0 || busy !== undefined}
                onClick={() => void applyUpdates()}
              >
                {tr('updateSelected', { count: chosen.length })}
              </Button>
              <p className="market-updates-note">
                {tr(
                  chosen.some(pkg => pkg.category === 'core' || pkg.category === 'runtime')
                    ? 'marketUpdateCoreNote'
                    : 'marketUpdateNote',
                )}
              </p>
              {update && (
                <div
                  className="market-updates-result"
                  role={update.ok ? 'status' : 'alert'}
                  data-ok={update.ok || undefined}
                >
                  <p>{update.message}</p>
                  {!update.ok && packageManager && <LogsLink source={packageManager} />}
                  {update.conflicts.length > 0 && (
                    <ul>
                      {update.conflicts.map(conflict => (
                        <li key={conflict}>{conflict}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
          {state.error ? (
            <FetchError what={tr('market')} error={state.error} retry={reload} source={host} />
          ) : (
            state.packages &&
            (shown.length === 0 ? (
              <EmptyState
                title={tr(packages.length === 0 ? 'marketEmpty' : 'marketNoMatch')}
                description={terms.length > 0 ? tr('marketSearchHint') : undefined}
                action={
                  packages.length > 0 && (
                    <Button
                      variant="text"
                      onClick={() => {
                        setQuery('');
                        setKind('all');
                        setStatus('all');
                      }}
                    >
                      {tr('clearFilters')}
                    </Button>
                  )
                }
              />
            ) : (
              <ul className="market-list" aria-label={tr('packages')}>
                {shown.map(pkg => (
                  <MarketEntry
                    key={pkg.name}
                    pkg={pkg}
                    busy={busy}
                    selected={selected.has(pkg.name)}
                    onSelect={on =>
                      setSelected(current => {
                        const next = new Set(current);
                        if (on) next.add(pkg.name);
                        else next.delete(pkg.name);
                        return next;
                      })
                    }
                    onAsk={install => (install ? setInstalling(pkg) : setUninstalling({ pkg, removeConfig: false }))}
                  />
                ))}
              </ul>
            ))
          )}
        </div>
      </Panel>
      <InstallDialog pkg={installing} action={action} onClose={() => setInstalling(undefined)} onSettled={reload} />
      <Dialog
        open={uninstalling !== undefined}
        title={uninstalling ? tr('uninstallConfirm', { name: uninstalling.pkg.name }) : ''}
        size="form"
        onClose={() => setUninstalling(undefined)}
        footer={
          uninstalling && (
            <>
              <Button data-autofocus onClick={() => setUninstalling(undefined)}>
                {tr('cancel')}
              </Button>
              <Button variant="primary" danger busy={busy !== undefined} onClick={() => void uninstall(uninstalling)}>
                {tr('uninstall')}
              </Button>
            </>
          )
        }
      >
        {uninstalling && (
          <UninstallWarning
            name={uninstalling.pkg.name}
            removeConfig={uninstalling.removeConfig}
            onRemoveConfig={removeConfig => setUninstalling({ ...uninstalling, removeConfig })}
          />
        )}
      </Dialog>
    </Main>
  );
}

interface MarketEntryProps {
  pkg: MarketItem;
  busy?: string;
  selected: boolean;
  onSelect(selected: boolean): void;
  onAsk(install: boolean): void;
}

function MarketEntry({ pkg, busy, selected, onSelect, onAsk }: MarketEntryProps) {
  const link = safeLink(pkg);
  const shownVersion = pkg.installed ? pkg.resolved : pkg.version;
  // 更新时间是安装源原样给的串，认不出时不写
  const updated = Date.parse(pkg.updated ?? '');
  const meta = [
    pkg.author,
    pkg.downloads !== undefined && tr('downloadsPerMonth', { count: downloads(pkg.downloads) }),
    Number.isFinite(updated) && tr('updatedAt', { time: listTime(updated) }),
    pkg.license,
  ].filter(Boolean);
  return (
    <li className="market-entry">
      <Package aria-hidden className="market-entry-icon" />
      <div className="market-entry-body">
        <p className="market-entry-title">
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer">
              {pkg.name}
            </a>
          ) : (
            <span>{pkg.name}</span>
          )}
          <span className="market-entry-version">{shownVersion ? `v${shownVersion}` : tr('versionUnknown')}</span>
          <Badge>{tr(pkg.official ? 'official' : 'community')}</Badge>
          {pkg.category !== 'plugin' && <Badge>{text(CATEGORY_NAMES[pkg.category])}</Badge>}
          {pkg.installed && <Badge>{tr('installed')}</Badge>}
          {pkg.installed && pkg.origin && pkg.origin !== 'registry' && <Badge>{text(ORIGINS[pkg.origin])}</Badge>}
        </p>
        {pkg.insecure && (
          <p className="market-entry-warning">
            <TriangleAlert aria-hidden />
            {tr('marketInsecure')}
          </p>
        )}
        {pkg.description && <p className="market-entry-description">{pkg.description}</p>}
        {pkg.provides.length > 0 && (
          <p className="market-entry-meta">{tr('providesList', { services: pkg.provides })}</p>
        )}
        {meta.length > 0 && <p className="market-entry-meta">{meta.join(' · ')}</p>}
        <div className="market-entry-actions">
          {pkg.updatable && (
            <label className="field-check">
              <input
                type="checkbox"
                checked={selected}
                disabled={busy !== undefined}
                onChange={event => onSelect(event.target.checked)}
              />
              {tr('updateTo', { version: pkg.version })}
            </label>
          )}
          {!INSTALLABLE.has(pkg.category) ? (
            <span className="market-entry-meta">{tr('managedByDependencies')}</span>
          ) : pkg.installed ? (
            <Button variant="text" danger disabled={busy !== undefined} onClick={() => onAsk(false)}>
              {tr('uninstall')}
            </Button>
          ) : (
            <Button disabled={busy !== undefined} onClick={() => onAsk(true)}>
              {tr('install')}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
