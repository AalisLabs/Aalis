import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Button } from '../components/Button';
import { ButtonLink } from '../components/ButtonLink';
import { Dialog } from '../components/Dialog';
import { FetchError } from '../components/FetchError';
import { Panel } from '../components/Panel';
import { Table, type TableColumn } from '../components/Table';
import { useFeatures } from '../connection';
import { listTime } from '../format';
import { tr } from '../language';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import type { SessionSummary } from '../protocol/session-client';
import { groupFromParams, inGroup, paths, type RoomGroupAddress } from '../routes';
import { LayerRows } from '../settings/LayerRows';
import { useLayers } from '../settings/layers';
import { SessionGate, SessionsFetchError } from '../shell/SessionGate';
import { Main } from '../shell/Shell';
import { useSessionActions } from './actions';
import { useSessionList } from './live-list';
import { SessionStatus, STATUS_ORDER, statusOf } from './status';
import './RoomsPage.css';

// 房间表：一组房间（一个适配器实例，或还没记下实例的一个平台）一次取全，筛选、排序、搜索与分页都在客户端。
// 类型与状态的筛选写进地址；类型是平台自定的类型名，按本组出现过的原样列出。批量动作只有归档与删除。
// 每行的「场所设置」在页内打开这一行所在窗口的设置（与「会话默认」同一套行）；统一设置一个平台或一种类型在设置的
// 「会话默认」，表格下面一句话指过去。会话设置服务不在（功能位 settings 为假）时这两处都没有

const statusField = () => ({
  key: 'status',
  label: tr('status'),
  options: [
    { value: 'attention', label: tr('needsAttention') },
    { value: 'error', label: tr('error') },
    { value: 'running', label: tr('running') },
  ],
  matches: (s: SessionSummary, value: string) => s[value as 'attention' | 'error' | 'running'],
});

/** 类型的筛选：本组出现过的类型名，原样写 */
function typeField(sessions: readonly SessionSummary[]) {
  const types = [...new Set(sessions.flatMap(s => (s.chat ? [s.chat.type] : [])))].sort();
  return {
    key: 'type',
    label: tr('type'),
    options: types.map(type => ({ value: type, label: type })),
    matches: (s: SessionSummary, value: string) => s.chat?.type === value,
  };
}

const time = (at: number) => <time dateTime={new Date(at).toISOString()}>{listTime(at)}</time>;

export function RoomsPage() {
  const [params] = useSearchParams();
  const group = groupFromParams(params);
  if (!group) return <Navigate to={paths.home} replace />;
  return <RoomTable key={JSON.stringify(group)} query={group} />;
}

function RoomTable({ query }: { query: RoomGroupAddress }) {
  const list = useSessionList(query);
  const sessions = useProvider(SESSION_PROTOCOL);
  const actions = useSessionActions();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const { settings } = useFeatures();
  /** 打开着「场所设置」的那一行 */
  const [opened, setOpened] = useState<SessionSummary>();
  const layers = useLayers();
  const filterFields = [typeField(list.sessions ?? []), statusField()];
  const group = list.groups.find(g => inGroup(g, query));
  const title = group?.label ?? ('instance' in query ? query.instance : query.platform);

  const columns: TableColumn<SessionSummary>[] = [
    {
      key: 'name',
      label: tr('name'),
      primary: true,
      render: s => <Link to={paths.session(s.id)}>{s.title}</Link>,
      sortValue: s => s.title,
    },
    { key: 'type', label: tr('type'), render: s => s.chat?.type },
    ...(group && group.accounts > 1
      ? [
          {
            key: 'account',
            label: tr('account'),
            render: (s: SessionSummary) => s.account,
            sortValue: (s: SessionSummary) => s.account ?? '',
          },
        ]
      : []),
    {
      key: 'status',
      label: tr('status'),
      primary: true,
      render: s => {
        const status = statusOf(s);
        return status && status !== 'unread' && <SessionStatus session={s} status={status} />;
      },
      sortValue: s => {
        const status = statusOf(s);
        return status && status !== 'unread' ? STATUS_ORDER.indexOf(status) : STATUS_ORDER.length;
      },
    },
    { key: 'active', label: tr('lastActive'), render: s => time(s.updatedAt), sortValue: s => s.updatedAt },
    {
      key: 'replied',
      label: tr('lastReply'),
      render: s => (s.lastReplyAt === undefined ? '—' : time(s.lastReplyAt)),
      sortValue: s => s.lastReplyAt ?? 0,
    },
  ];

  const filterValues = Object.fromEntries(
    filterFields.flatMap(field => {
      const value = params.get(field.key);
      return value ? [[field.key, value]] : [];
    }),
  );

  const setFilter = (values: Record<string, string>) =>
    setParams(
      current => {
        const next = new URLSearchParams(current);
        for (const field of filterFields) {
          if (values[field.key]) next.set(field.key, values[field.key]);
          else next.delete(field.key);
        }
        return next;
      },
      { replace: true },
    );

  const rowsOf = (keys: string[]) => (list.sessions ?? []).filter(s => keys.includes(s.id));

  return (
    <Main>
      <Panel icon={MessagesSquare} title={title} back={paths.home}>
        <SessionGate>
          <div className="rooms-page">
            {list.error ? (
              <FetchError what={tr('rooms')} error={list.error} retry={list.retry} source={sessions} />
            ) : (
              list.sessions && (
                <Table
                  label={tr('roomsOf', { name: title })}
                  rows={list.sessions}
                  rowKey={s => s.id}
                  columns={columns}
                  empty={tr('roomsEmpty')}
                  search={s => `${s.title} ${s.id}`}
                  filter={{ fields: filterFields, values: filterValues, onChange: setFilter }}
                  rowActions={s =>
                    settings &&
                    s.place.kind === 'window' && (
                      <Button variant="text" onClick={() => setOpened(s)}>
                        {tr('placeSettings')}
                      </Button>
                    )
                  }
                  selection={{
                    selected,
                    onChange: setSelected,
                    rowLabel: s => s.title,
                    actions: keys => (
                      <>
                        <Button
                          onClick={() => {
                            actions.archive(rowsOf(keys));
                            setSelected(new Set());
                          }}
                        >
                          {tr('archive')}
                        </Button>
                        <Button variant="text" danger onClick={() => actions.remove(rowsOf(keys))}>
                          {tr('delete')}
                        </Button>
                      </>
                    ),
                  }}
                />
              )
            )}
            {settings && (
              <div className="rooms-hint">
                <p>{tr('roomsHint')}</p>
                <ButtonLink to={paths.settingsSection('session-defaults')} variant="text">
                  {tr('goToSessionDefaults')}
                </ButtonLink>
              </div>
            )}
          </div>
        </SessionGate>
      </Panel>
      <Dialog
        open={opened !== undefined}
        title={tr('placeSettingsOf', { name: opened?.place.name ?? '' })}
        size="form"
        onClose={() => setOpened(undefined)}
        footer={<Button onClick={() => setOpened(undefined)}>{tr('close')}</Button>}
      >
        {layers.error && <SessionsFetchError what={tr('settingLayers')} error={layers.error} retry={layers.retry} />}
        {opened && layers.value && (
          <LayerRows
            layer={{ scope: 'place', key: opened.place.key }}
            order={layers.value.order}
            at={{ platform: opened.platform, chatType: opened.chat?.type }}
            what={tr('placeSettings')}
          />
        )}
      </Dialog>
    </Main>
  );
}
