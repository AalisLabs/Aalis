import type { SessionSummary } from '@aalis/api-session-protocol';
import type { PlatformStatus } from '@aalis/api-webui';
import { RotateCw } from 'lucide-react';
import { useReducer } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { RunningBelow, StopButton } from '../background/Background';
import { Block } from '../components/Block';
import { FetchError } from '../components/FetchError';
import { IconButton } from '../components/IconButton';
import { List, ListItem } from '../components/List';
import { Panel } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { useSessionClient, useSessionless } from '../connection';
import { withInstance } from '../pages/registry';
import { SESSION_PROTOCOL, useHost, useProvider } from '../plugins/list';
import { isRecord, useJson } from '../rest';
import { paths, routes } from '../routes';
import { useSessionList } from '../sessions/live-list';
import { BackgroundStatus } from '../sessions/status';
import { Main } from '../shell/Shell';
import { AttentionList } from './AttentionList';
import { useAttention } from './attention';
import { Logs } from './Logs';
import './Health.css';

// 运行状况：概况（「需要处理」的全部、正在运行的后台工作与各适配器的连接）与日志两个标签，标签由地址决定。
// 正在运行的按会话列出（归档的也列），每个会话下按会话树列出在跑的子会话与后台任务，都能停；会话服务不在时不出现。
// 平台连接没有变化事件，打开时取一次，配手动刷新

const TABS = [
  { key: 'overview', title: '概况' },
  { key: 'logs', title: '日志' },
];

export function HealthPage() {
  const tab = useMatch(routes.healthLogs) ? 'logs' : 'overview';
  const navigate = useNavigate();
  const [platformsVersion, refreshPlatforms] = useReducer((n: number) => n + 1, 0);
  return (
    <Main>
      <Panel title="运行状况" back={paths.home}>
        <Tabs
          label="运行状况"
          items={TABS}
          value={tab}
          onChange={key => {
            if (key !== tab) navigate(key === 'logs' ? paths.healthLogs() : paths.health, { replace: true });
          }}
          trailing={
            tab === 'overview' && <IconButton icon={RotateCw} label="刷新平台连接" onClick={refreshPlatforms} />
          }
        >
          {tab === 'logs' ? (
            <Logs />
          ) : (
            <div className="page-screen health-overview">
              <Attention />
              <Running />
              <Platforms version={platformsVersion} refresh={refreshPlatforms} />
            </div>
          )}
        </Tabs>
      </Panel>
    </Main>
  );
}

function Attention() {
  const { items, error, retry } = useAttention();
  const host = useHost();
  return (
    <Block title="需要处理">
      {items && (items.length > 0 ? <AttentionList items={items} /> : <p className="page-empty">没有需要处理的事</p>)}
      {error && (
        <FetchError what="「需要处理」" error={error} retry={retry} stale={items !== undefined} source={host} />
      )}
    </Block>
  );
}

/** 有后台工作的根会话；没有、会话服务不在时不出现 */
function Running() {
  const sessionless = useSessionless();
  const list = useSessionList({ background: true });
  const sessions = useProvider(SESSION_PROTOCOL);
  if (sessionless || (!list.error && !list.sessions?.length)) return null;
  return (
    <Block title="正在运行">
      {list.error && (
        <FetchError
          what="正在运行的会话"
          error={list.error}
          retry={list.retry}
          stale={list.sessions !== undefined}
          source={sessions}
        />
      )}
      {list.sessions && list.sessions.length > 0 && (
        <List label="正在运行">
          {list.sessions.map(session => (
            <RunningSession key={session.id} session={session} />
          ))}
        </List>
      )}
    </Block>
  );
}

/** 一个有后台工作的会话：链到它的「后台」标签，行尾停它下面的全部后台工作 */
function RunningSession({ session }: { session: SessionSummary }) {
  const client = useSessionClient();
  return (
    <ListItem
      to={paths.session(session.id, 'background')}
      title={session.title}
      detail={<BackgroundStatus count={session.background} />}
      meta={session.archived && '已归档'}
      action={
        <StopButton
          label={`全部停止「${session.title}」`}
          stop={() => client.request('background/stopAll', { sessionId: session.id })}
        />
      }
    >
      <RunningBelow session={session} />
    </ListItem>
  );
}

type Connection = PlatformStatus['connections'][number];

const STATUS_TEXT: Record<Connection['status'], string> = {
  online: '在线',
  offline: '离线',
  connecting: '连接中',
};

function parsePlatforms(body: unknown): PlatformStatus[] {
  const rows = isRecord(body) && Array.isArray(body.platforms) ? body.platforms : undefined;
  const valid = rows?.every(
    row =>
      isRecord(row) &&
      typeof row.adapterName === 'string' &&
      typeof row.contextId === 'string' &&
      Array.isArray(row.connections) &&
      row.connections.every(
        c => isRecord(c) && typeof c.id === 'string' && Object.hasOwn(STATUS_TEXT, String(c.status)),
      ),
  );
  if (!rows || !valid) throw new Error('平台连接的回应不是预期的形状');
  return rows as PlatformStatus[];
}

/** 没有适配器时不出现 */
function Platforms({ version, refresh }: { version: number; refresh(): void }) {
  const { value: platforms, error } = useJson('/api/platforms', parsePlatforms, version);
  const host = useHost();
  if ((!platforms || platforms.length === 0) && !error) return null;
  return (
    <Block title="平台连接">
      {platforms && platforms.length > 0 && (
        <List label="平台连接">
          {platforms.flatMap(({ adapterName, contextId, connections }) => {
            const row = (key: string, connection?: Connection) => (
              <ListItem
                key={key}
                to={paths.plugin(contextId)}
                title={withInstance(adapterName, contextId)}
                detail={connection && accountOf(connection)}
                meta={connection ? STATUS_TEXT[connection.status] : '没有连接'}
                marker={connection?.status === 'offline' ? 'error' : undefined}
              />
            );
            return connections.length === 0
              ? [row(contextId)]
              : connections.map(connection => row(`${contextId}/${connection.id}`, connection));
          })}
        </List>
      )}
      {error && (
        <FetchError what="平台连接" error={error} retry={refresh} stale={platforms !== undefined} source={host} />
      )}
    </Block>
  );
}

/** 连接上的账号：昵称后面括着 id，只有一样时写那一样 */
function accountOf({ selfId, selfNickname }: Connection): string | undefined {
  if (selfNickname && selfId) return `${selfNickname}（${selfId}）`;
  return selfNickname || selfId;
}
