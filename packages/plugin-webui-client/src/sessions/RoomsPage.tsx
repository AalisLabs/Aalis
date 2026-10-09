import type { SessionSummary, SettingLayer } from '@aalis/api-session-protocol';
import { MessagesSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Button } from '../components/Button';
import { ButtonLink } from '../components/ButtonLink';
import { Dialog } from '../components/Dialog';
import { FetchError } from '../components/FetchError';
import { Panel } from '../components/Panel';
import { Table, type TableColumn } from '../components/Table';
import { listTime } from '../format';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
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
// 「会话默认」，表格下面一句话指过去

const STATUS_FIELD = {
  key: 'status',
  label: '状态',
  options: [
    { value: 'attention', label: '需要处理' },
    { value: 'error', label: '出错' },
    { value: 'running', label: '运行中' },
  ],
  matches: (s: SessionSummary, value: string) => s[value as 'attention' | 'error' | 'running'],
};

/** 类型的筛选：本组出现过的类型名，原样写 */
function typeField(sessions: readonly SessionSummary[]) {
  const types = [...new Set(sessions.flatMap(s => (s.chat ? [s.chat.type] : [])))].sort();
  return {
    key: 'type',
    label: '类型',
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
  /** 打开着「场所设置」的那个窗口 */
  const [place, setPlace] = useState<SessionSummary['place']>();
  const layer = useMemo((): SettingLayer | undefined => place && { scope: 'place', key: place.key }, [place]);
  const layers = useLayers();
  const filterFields = [typeField(list.sessions ?? []), STATUS_FIELD];
  const group = list.groups.find(g => inGroup(g, query));
  const title = group?.label ?? ('instance' in query ? query.instance : query.platform);

  const columns: TableColumn<SessionSummary>[] = [
    {
      key: 'name',
      label: '名称',
      primary: true,
      render: s => <Link to={paths.session(s.id)}>{s.title}</Link>,
      sortValue: s => s.title,
    },
    { key: 'type', label: '类型', render: s => s.chat?.type },
    ...(group && group.accounts > 1
      ? [
          {
            key: 'account',
            label: '账号',
            render: (s: SessionSummary) => s.account,
            sortValue: (s: SessionSummary) => s.account ?? '',
          },
        ]
      : []),
    {
      key: 'status',
      label: '状态',
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
    { key: 'active', label: '最后活动', render: s => time(s.updatedAt), sortValue: s => s.updatedAt },
    {
      key: 'replied',
      label: '她最近开口',
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
              <FetchError what="房间" error={list.error} retry={list.retry} source={sessions} />
            ) : (
              list.sessions && (
                <Table
                  label={`${title}的房间`}
                  rows={list.sessions}
                  rowKey={s => s.id}
                  columns={columns}
                  empty="这一组没有房间"
                  search={s => `${s.title} ${s.id}`}
                  filter={{ fields: filterFields, values: filterValues, onChange: setFilter }}
                  rowActions={s =>
                    s.place.kind === 'window' && (
                      <Button variant="text" onClick={() => setPlace(s.place)}>
                        场所设置
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
                          归档
                        </Button>
                        <Button variant="text" danger onClick={() => actions.remove(rowsOf(keys))}>
                          删除
                        </Button>
                      </>
                    ),
                  }}
                />
              )
            )}
            <div className="rooms-hint">
              <p>统一设置一个平台或一种类型去「会话默认」，单个窗口在这里设。</p>
              <ButtonLink to={paths.settingsSection('session-defaults')} variant="text">
                去会话默认
              </ButtonLink>
            </div>
          </div>
        </SessionGate>
      </Panel>
      <Dialog
        open={place !== undefined}
        title={`场所设置：${place?.name ?? ''}`}
        size="form"
        onClose={() => setPlace(undefined)}
        footer={<Button onClick={() => setPlace(undefined)}>关闭</Button>}
      >
        {layers.error && <SessionsFetchError what="会话设置的层" error={layers.error} retry={layers.retry} />}
        {layer && layers.value && <LayerRows layer={layer} order={layers.value.order} what="场所设置" />}
      </Dialog>
    </Main>
  );
}
