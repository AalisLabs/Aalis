import type { PlatformStatus } from '@aalis/api-webui';
import { RotateCw } from 'lucide-react';
import { useReducer } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { Block } from '../components/Block';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { IconButton } from '../components/IconButton';
import { List, ListItem } from '../components/List';
import { Panel } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { withInstance } from '../pages/registry';
import { isRecord, useJson } from '../rest';
import { paths, routes } from '../routes';
import { Main } from '../shell/Shell';
import { AttentionList, FetchError } from './AttentionList';
import { useAttention } from './attention';
import { Logs } from './Logs';
import './Health.css';

// 运行状况：概况（「需要处理」的全部与各适配器的连接）与日志两个标签，标签由地址决定。
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
  return (
    <Block title="需要处理">
      {items && (items.length > 0 ? <AttentionList items={items} /> : <p className="page-empty">没有需要处理的事</p>)}
      {error &&
        (items ? (
          <FetchError error={error} retry={retry} stale />
        ) : (
          <EmptyState
            tone="danger"
            title="「需要处理」没取到"
            description={error.message}
            action={<Button onClick={retry}>重试</Button>}
          />
        ))}
    </Block>
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
  if (!platforms) {
    return (
      error && (
        <Block title="平台连接">
          <EmptyState
            tone="danger"
            title="平台连接没取到"
            description={error.message}
            action={<Button onClick={refresh}>重试</Button>}
          />
        </Block>
      )
    );
  }
  if (platforms.length === 0 && !error) return null;
  return (
    <Block title="平台连接">
      {platforms.length > 0 && (
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
      {error && <FetchError error={error} retry={refresh} stale />}
    </Block>
  );
}

/** 连接上的账号：昵称后面括着 id，只有一样时写那一样 */
function accountOf({ selfId, selfNickname }: Connection): string | undefined {
  if (selfNickname && selfId) return `${selfNickname}（${selfId}）`;
  return selfNickname || selfId;
}
