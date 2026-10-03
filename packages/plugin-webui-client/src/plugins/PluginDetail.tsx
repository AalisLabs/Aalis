import type { FrameHostCapability, PageView } from '@aalis/api-webui';
import type { ConfigSchema } from '@aalis/schema-config';
import { useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Block } from '../components/Block';
import { Button } from '../components/Button';
import { ButtonLink } from '../components/ButtonLink';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { List, ListItem } from '../components/List';
import { Menu } from '../components/Menu';
import { Panel } from '../components/Panel';
import { StatusText } from '../components/StatusText';
import { useToast } from '../components/Toast';
import { instanceName, refOf, usePages } from '../pages/registry';
import { deleteJson, isRecord, postJson, RestError } from '../rest';
import { paths } from '../routes';
import { Main, useShell } from '../shell/Shell';
import { type PluginAction, usePluginAction } from './action';
import { ConfigForm } from './ConfigForm';
import { Lines, UninstallWarning } from './disclosure';
import { labelOf, type PluginRow, usePlugins } from './list';
import { markerOf, statusOf } from './status';
import './PluginDetail.css';

// 插件详情，由宿主拼装，自上而下：头部（包名、版本、状态与原因，启停、重载，主实例卸载、其余实例移除）、配置、依赖与贡献、
// 页面、实例。没有内容的块不出现。管理动作写进去了就看头部的状态，出错用 Toast 报；无论成败都重取插件列表

/** 插件前端申请的宿主数据能力怎么写 */
const CAPABILITIES: Record<FrameHostCapability, string> = {
  'sessions:read': '读会话树与状态',
  'turn:abort': '停止会话的回合',
};

const PLACEMENTS: Record<PageView['placement'], string> = {
  plugin: '插件页面，打开后可以固定到图标栏',
  settings: '设置里的一节',
  session: '会话面板，在会话右侧面板的「+」里打开',
};

const enc = encodeURIComponent;

/** 回执里的说明 */
const messageOf = (reply: unknown) =>
  isRecord(reply) && typeof reply.message === 'string' ? reply.message : undefined;

/** 桌面上插件区的主区：还没选插件。左栏是抽屉或收起着时，从这里打开它 */
export function PluginsHome() {
  const { reveal } = useShell();
  return (
    <Main>
      <Panel title="插件">
        <EmptyState
          title="选一个插件"
          description="左栏按子系统列出已安装的插件；要装新的插件，去市场。"
          action={<Button onClick={() => reveal('left')}>打开插件列表</Button>}
        />
      </Panel>
    </Main>
  );
}

export function PluginDetail() {
  const { instance } = useParams() as { instance: string };
  const { plugins, error, refresh } = usePlugins();
  const row = plugins?.find(plugin => plugin.instanceId === instance);
  if (row) {
    return (
      <Main>
        <Detail key={row.instanceId} row={row} />
      </Main>
    );
  }
  return (
    <Main>
      <Panel title="插件" back={paths.plugins}>
        {error ? (
          <EmptyState
            tone="danger"
            title="插件列表没取到"
            description={error.message}
            action={<Button onClick={() => void refresh()}>重试</Button>}
          />
        ) : (
          plugins && (
            <EmptyState
              title="没有这个插件"
              description={`${instance} 不在已安装的插件里，可能已经卸载或移除。`}
              action={<ButtonLink to={paths.market}>去市场</ButtonLink>}
            />
          )
        )}
      </Panel>
    </Main>
  );
}

function Detail({ row }: { row: PluginRow }) {
  const { hash } = useLocation();
  // 从市场装完跳过来时落在配置区
  useEffect(() => {
    if (hash === '#config') document.getElementById('config')?.scrollIntoView();
  }, [hash]);
  const schema = row.configSchema && Object.keys(row.configSchema).length > 0 ? row.configSchema : undefined;
  return (
    <Panel title={labelOf(row)} meta={instanceName(row.instanceId)} back={paths.plugins}>
      <div className="page-screen plugin-detail">
        <Summary row={row} />
        {schema && <ConfigSection row={row} schema={schema} />}
        <Relations row={row} />
        <Pages row={row} />
        {row.reusable && <Instances row={row} />}
      </div>
    </Panel>
  );
}

function Summary({ row }: { row: PluginRow }) {
  const action = usePluginAction();
  const { busy, run } = action;
  const toast = useToast();
  const navigate = useNavigate();
  const [uninstalling, setUninstalling] = useState(false);
  const [removing, setRemoving] = useState<PluginRow>();
  const status = statusOf(row);
  const base = `/api/plugins/${enc(row.instanceId)}`;
  const locked = row.self || busy !== undefined;
  const uninstall = () =>
    run(
      '卸载',
      () => postJson('/api/marketplace/uninstall', { name: row.name }),
      reply => {
        setUninstalling(false);
        toast({ kind: 'success', text: messageOf(reply) ?? `已卸载 ${labelOf(row)}` });
        navigate(paths.plugins);
      },
    );
  return (
    <div className="plugin-summary">
      <p className="plugin-summary-meta">{row.version ? `${row.name} · 版本 ${row.version}` : row.name}</p>
      <p className="plugin-summary-status">
        <StatusText state={status.state}>{status.short}</StatusText>
        {status.reason && <span className="plugin-summary-reason">{status.reason}</span>}
      </p>
      {row.self && <p className="plugin-summary-note">这个界面由它提供，不能从界面停用或卸载。</p>}
      <div className="page-actions">
        {row.state === 'disabled' ? (
          <Button
            variant="primary"
            busy={busy === '启用'}
            disabled={busy !== undefined}
            onClick={() => run('启用', () => postJson(`${base}/enable`, {}))}
          >
            启用
          </Button>
        ) : (
          <>
            <Button
              busy={busy === '停用'}
              disabled={locked}
              onClick={() => run('停用', () => postJson(`${base}/disable`, {}))}
            >
              停用
            </Button>
            <Button
              busy={busy === '重载'}
              disabled={busy !== undefined}
              onClick={() => run('重载', () => postJson(`${base}/reload`, {}))}
            >
              重载
            </Button>
          </>
        )}
        {row.instanceId === row.name ? (
          <Button variant="text" danger disabled={locked} onClick={() => setUninstalling(true)}>
            卸载
          </Button>
        ) : (
          <Button variant="text" danger disabled={busy !== undefined} onClick={() => setRemoving(row)}>
            移除实例
          </Button>
        )}
      </div>
      <Dialog
        open={uninstalling}
        title={`卸载「${labelOf(row)}」？`}
        onClose={() => setUninstalling(false)}
        footer={
          <>
            <Button data-autofocus onClick={() => setUninstalling(false)}>
              取消
            </Button>
            <Button variant="primary" danger busy={busy === '卸载'} onClick={() => void uninstall()}>
              卸载
            </Button>
          </>
        }
      >
        <UninstallWarning name={row.name} />
      </Dialog>
      <RemoveInstanceDialog target={removing} current={row} action={action} onClose={() => setRemoving(undefined)} />
    </div>
  );
}

interface RemoveInstanceDialogProps {
  /** 要移除的实例；没有时确认框关着 */
  target?: PluginRow;
  /** 正在看的实例 */
  current: PluginRow;
  action: PluginAction;
  onClose(): void;
}

/** 移除一个后缀实例：先确认，它的配置一并从配置文件删除；移除的是正在看的实例时回到主实例 */
function RemoveInstanceDialog({ target, current, action, onClose }: RemoveInstanceDialogProps) {
  const navigate = useNavigate();
  const remove = (plugin: PluginRow) =>
    action.run(
      '移除实例',
      () => deleteJson(`/api/plugins/${enc(plugin.instanceId)}/instance`),
      () => {
        onClose();
        if (plugin.instanceId === current.instanceId) navigate(paths.plugin(current.name));
      },
    );
  return (
    <Dialog
      open={target !== undefined}
      title={`移除实例「${target ? instanceName(target.instanceId) : ''}」？`}
      onClose={onClose}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            danger
            busy={action.busy === '移除实例'}
            onClick={() => target && void remove(target)}
          >
            移除
          </Button>
        </>
      }
    >
      <p>这个实例的配置会一并从配置文件删除。</p>
    </Dialog>
  );
}

function ConfigSection({ row, schema }: { row: PluginRow; schema: ConfigSchema }) {
  const { refresh } = usePlugins();
  const [result, setResult] = useState<string>();
  // 写进配置文件之后换上新的表单：重取的配置一样（无改动）时也换
  const [generation, setGeneration] = useState(0);
  return (
    <section id="config" className="page-block">
      <ConfigForm
        key={`${generation}:${JSON.stringify(row.config)}`}
        row={row}
        schema={schema}
        result={result}
        onSaved={async message => {
          await refresh();
          setResult(message);
          setGeneration(n => n + 1);
        }}
      />
    </section>
  );
}

/** 依赖与贡献：要的服务就绪没有（缺的服务有已装没启用的提供者时可以一键启用），它提供的服务、工具、指令与扩展 */
function Relations({ row }: { row: PluginRow }) {
  const { plugins } = usePlugins();
  const { busy, run } = usePluginAction();
  const providersOf = (service: string) => (plugins ?? []).filter(plugin => plugin.provides.includes(service));
  const names = (rows: PluginRow[]) => rows.map(labelOf).join('、');
  // 宿主自己提供的服务（不在任何插件的 provides 里、此刻也不缺）不列
  const needs = row.requiredServices.flatMap(service => {
    const by = providersOf(service);
    if (row.missing.includes(service)) return [{ service, missing: true, by }];
    return by.length > 0 ? [{ service, missing: false, by }] : [];
  });
  const optional = row.optionalServices.flatMap(service => {
    const by = providersOf(service);
    return by.length > 0 ? [`${service}（${names(by)}${by.some(p => p.state === 'active') ? '' : '，没在运行'}）`] : [];
  });
  const lines: Array<[string, string[]]> = [
    ['可选依赖', optional],
    ['提供的服务', row.provides],
    ['工具', row.tools],
    ['指令', row.commands.map(name => `/${name}`)],
    ['扩展的事件', row.extends?.events ?? []],
    ['扩展的钩子', row.extends?.hooks ?? []],
  ];
  if (needs.length === 0 && lines.every(([, items]) => items.length === 0)) return null;
  return (
    <Block title="依赖与贡献">
      <Lines lines={lines}>
        {needs.length > 0 && (
          <div className="page-info-item">
            <dt>依赖</dt>
            <dd>
              <ul className="plugin-needs">
                {needs.map(({ service, missing, by }) => (
                  <li key={service}>
                    {missing ? (
                      <>
                        <StatusText state="attention">{`${service}：缺`}</StatusText>
                        {by
                          .filter(plugin => plugin.state === 'disabled' || plugin.state === 'error')
                          .map(plugin => {
                            const suffix = instanceName(plugin.instanceId);
                            return (
                              <Button
                                key={plugin.instanceId}
                                busy={busy === plugin.instanceId}
                                disabled={busy !== undefined}
                                onClick={() =>
                                  run(plugin.instanceId, () =>
                                    postJson(`/api/plugins/${enc(plugin.instanceId)}/enable`, {}),
                                  )
                                }
                              >
                                {`启用${labelOf(plugin)}${suffix ? ` · ${suffix}` : ''}`}
                              </Button>
                            );
                          })}
                      </>
                    ) : (
                      `${service}（${names(by)}）`
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </Lines>
    </Block>
  );
}

/** 这个插件登记的全部页面与位置；插件前端另写它申请的宿主数据能力 */
function Pages({ row }: { row: PluginRow }) {
  const { pages } = usePages();
  const own = (pages ?? []).filter(page => page.instance === row.instanceId);
  if (own.length === 0) return null;
  return (
    <Block title="页面">
      <ul className="plugin-pages">
        {own.map(page => {
          const to =
            page.placement === 'plugin'
              ? paths.page(refOf(page))
              : page.placement === 'settings'
                ? paths.settingsPage(refOf(page))
                : undefined;
          const host = page.frame?.host ?? [];
          return (
            <li key={page.key}>
              {to ? <Link to={to}>{page.title}</Link> : <span>{page.title}</span>}
              <span className="plugin-page-detail">
                {PLACEMENTS[page.placement]}
                {page.frame &&
                  (host.length > 0
                    ? `；插件前端，申请宿主数据：${host.map(capability => CAPABILITIES[capability]).join('、')}`
                    : '；插件前端，不申请宿主数据')}
              </span>
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

/** 多开的插件：列出全部实例，新建与移除（主实例不能移除） */
function Instances({ row }: { row: PluginRow }) {
  const { plugins } = usePlugins();
  const action = usePluginAction();
  const { busy, run } = action;
  const toast = useToast();
  const navigate = useNavigate();
  const inputId = useId();
  const [suffix, setSuffix] = useState('');
  const [problem, setProblem] = useState<string>();
  const [removing, setRemoving] = useState<PluginRow>();
  const instances = (plugins ?? [])
    .filter(plugin => plugin.name === row.name)
    .sort((a, b) =>
      a.instanceId === a.name ? -1 : b.instanceId === b.name ? 1 : a.instanceId.localeCompare(b.instanceId),
    );

  const create = () => {
    setProblem(undefined);
    void run(
      '新建实例',
      async () => {
        try {
          return await postJson(`/api/plugins/${enc(row.name)}/instances`, { suffix: suffix.trim() });
        } catch (err) {
          // 写法不对、已存在这类可以就地改正的写在输入框下，其余（实例已登记、只是没写进文件）照常报
          if (err instanceof RestError && err.status === 400) {
            setProblem(err.message);
            return undefined;
          }
          throw err;
        }
      },
      reply => {
        if (!isRecord(reply) || typeof reply.instanceId !== 'string') return;
        toast({
          kind: 'success',
          text: typeof reply.message === 'string' ? reply.message : `已新建 ${reply.instanceId}`,
        });
        setSuffix('');
        navigate(paths.plugin(reply.instanceId));
      },
    );
  };

  return (
    <Block title="实例">
      <List label="实例">
        {instances.map(plugin => {
          const name = instanceName(plugin.instanceId);
          const status = statusOf(plugin);
          return (
            <ListItem
              key={plugin.instanceId}
              to={paths.plugin(plugin.instanceId)}
              title={name ?? '主实例'}
              meta={status.state && status.short}
              marker={markerOf(status)}
              current={plugin.instanceId === row.instanceId}
              menu={
                name !== undefined && (
                  <Menu label="更多" items={[{ label: '移除', danger: true, onSelect: () => setRemoving(plugin) }]} />
                )
              }
            />
          );
        })}
      </List>
      <form
        className="plugin-instance-form"
        onSubmit={event => {
          event.preventDefault();
          create();
        }}
      >
        <label htmlFor={inputId}>新实例的名字</label>
        <div className="plugin-instance-input">
          <input
            id={inputId}
            value={suffix}
            placeholder="字母、数字、下划线或连字符"
            aria-invalid={problem ? true : undefined}
            onChange={event => setSuffix(event.target.value)}
          />
          <Button type="submit" busy={busy === '新建实例'} disabled={!suffix.trim() || busy !== undefined}>
            新建实例
          </Button>
        </div>
        {problem && <p className="field-problem">{problem}</p>}
      </form>
      <RemoveInstanceDialog target={removing} current={row} action={action} onClose={() => setRemoving(undefined)} />
    </Block>
  );
}
