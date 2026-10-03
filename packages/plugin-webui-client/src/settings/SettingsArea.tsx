import type { DeclarativePageView, PageView } from '@aalis/api-webui';
import { RotateCw } from 'lucide-react';
import { type ComponentType, type ReactNode, useReducer } from 'react';
import { Navigate, useParams } from 'react-router';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { IconButton } from '../components/IconButton';
import { List, ListItem } from '../components/List';
import { Panel } from '../components/Panel';
import { PageContent } from '../pages/PageContent';
import { PageMissing } from '../pages/PluginPage';
import { instanceName, pageName, refOf, usePages } from '../pages/registry';
import { PageScope } from '../pages/scope';
import { usePlugins } from '../plugins/list';
import { paths } from '../routes';
import { ServiceAbsent, useSessionService } from '../shell/SessionGate';
import { Left, Main, usePhone } from '../shell/Shell';
import { AppearanceSection } from './AppearanceSection';
import { SessionDefaults } from './SessionDefaults';
import { SystemSection } from './SystemSection';
import './SettingsArea.css';

// 设置：宿主的分节（会话默认、外观、系统）与插件的分节（位置为设置的页面）是同一张分节表，宿主先占好位置：会话默认在最前，
// 插件的按页面的先后排在它后面，外观与系统在最后。左栏是这张表的目录，主区按地址打开一节。会话默认要会话服务在，
// 插件的分节要它的页面登记着，外观与系统总在。桌面上 /settings 落到第一节，手机上它就是目录这一层。
// 插件列表或页面表没取到时只少依赖它的那几节，目录写明原因、可以重试

const HOST = {
  'session-defaults': { title: '会话默认', Content: SessionDefaults },
  appearance: { title: '外观', Content: AppearanceSection },
  system: { title: '系统', Content: SystemSection },
} satisfies Record<string, { title: string; Content: ComponentType }>;
type HostSettings = keyof typeof HOST;

interface SectionEntry {
  path: string;
  title: string;
  host?: HostSettings;
  page?: DeclarativePageView;
}

const isSettingsPage = (page: PageView): page is DeclarativePageView =>
  page.placement === 'settings' && page.content !== undefined;

/** 分节表；插件列表或页面表还在取时为 undefined，没取到的当作没有 */
function useSections(): SectionEntry[] | undefined {
  const { pages, pagesError } = usePages();
  const { error: pluginsError } = usePlugins();
  const sessions = useSessionService();
  if ((sessions === undefined && !pluginsError) || (pages === undefined && !pagesError)) return undefined;
  const host = (section: HostSettings): SectionEntry => ({
    path: paths.settingsSection(section),
    title: HOST[section].title,
    host: section,
  });
  return [
    ...(sessions ? [host('session-defaults')] : []),
    ...(pages ?? [])
      .filter(isSettingsPage)
      .map(page => ({ path: paths.settingsPage(refOf(page)), title: pageName(page), page })),
    host('appearance'),
    host('system'),
  ];
}

export function SettingsDirectory() {
  const sections = useSections();
  const { pagesError, retry } = usePages();
  const { error: pluginsError, refresh } = usePlugins();
  const { section, instance, pageKey } = useParams();
  const current = (entry: SectionEntry) =>
    entry.host ? entry.host === section : entry.page?.instance === instance && entry.page?.key === pageKey;
  return (
    <Left label="设置">
      <Panel title="设置" back={paths.home}>
        <div className="settings-directory">
          {pluginsError && (
            <p className="settings-note" role="alert">
              插件列表没取到：{pluginsError.message}
              <Button variant="text" onClick={() => void refresh()}>
                重试
              </Button>
            </p>
          )}
          {pagesError && (
            <p className="settings-note" role="alert">
              插件的设置页没取到：{pagesError.message}
              <Button variant="text" onClick={retry}>
                重试
              </Button>
            </p>
          )}
          {sections && (
            <List label="分节">
              {sections.map(entry => (
                <ListItem key={entry.path} to={entry.path} title={entry.title} current={current(entry)} />
              ))}
            </List>
          )}
        </div>
      </Panel>
    </Left>
  );
}

/** /settings：桌面上落到第一节；手机上这一层是目录，主区不出现 */
export function SettingsHome() {
  const sections = useSections();
  const phone = usePhone();
  if (phone || !sections) return null;
  return <Navigate to={sections[0].path} replace />;
}

function Section({
  title,
  meta,
  actions,
  children,
}: {
  title: string;
  meta?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Main>
      <Panel title={title} meta={meta} back={paths.settings} actions={actions}>
        {children}
      </Panel>
    </Main>
  );
}

const isHost = (section: string | undefined): section is HostSettings =>
  section !== undefined && Object.hasOwn(HOST, section);

/** 地址上的一节：宿主的按 :section，插件的按实例与页面 */
export function SettingsSection() {
  const { section, instance, pageKey } = useParams();
  const sessions = useSessionService();
  const { error: pluginsError, refresh } = usePlugins();
  if (instance !== undefined && pageKey !== undefined) {
    return <PluginSection key={`${instance}\n${pageKey}`} instance={instance} pageKey={pageKey} />;
  }
  if (!isHost(section)) return <Navigate to={paths.settings} replace />;
  const { title, Content } = HOST[section];
  if (section === 'session-defaults' && sessions !== true) {
    return (
      <Section title={title}>
        {sessions === false ? (
          <ServiceAbsent />
        ) : (
          pluginsError && (
            <EmptyState
              tone="danger"
              title="插件列表没取到"
              description={pluginsError.message}
              action={<Button onClick={() => void refresh()}>重试</Button>}
            />
          )
        )}
      </Section>
    );
  }
  return (
    <Section title={title}>
      <Content />
    </Section>
  );
}

/** 插件的一节：标题栏有手动刷新；页面不在页面表里（所属插件停用）时显示占位，重新登记后回来 */
function PluginSection({ instance, pageKey }: { instance: string; pageKey: string }) {
  const { pages } = usePages();
  const [reloads, reload] = useReducer((n: number) => n + 1, 0);
  const page = pages?.filter(isSettingsPage).find(view => view.instance === instance && view.key === pageKey);
  if (!page) {
    return (
      <Section title="设置">
        <PageMissing instance={instance} />
      </Section>
    );
  }
  return (
    <Section
      title={page.title}
      meta={instanceName(page.instance)}
      actions={<IconButton icon={RotateCw} label="刷新" onClick={reload} />}
    >
      <PageScope page={page} version={reloads}>
        <PageContent page={page} />
      </PageScope>
    </Section>
  );
}
