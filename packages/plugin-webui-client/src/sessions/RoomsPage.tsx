import type { SessionSummary } from '@aalis/api-session-protocol';
import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Button } from '../components/Button';
import { ButtonLink } from '../components/ButtonLink';
import { FetchError } from '../components/FetchError';
import { Panel } from '../components/Panel';
import { Table, type TableColumn } from '../components/Table';
import { listTime } from '../format';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import { groupFromParams, inGroup, paths, type RoomGroupAddress } from '../routes';
import { SessionGate } from '../shell/SessionGate';
import { Main } from '../shell/Shell';
import { useSessionActions } from './actions';
import { useSessionList } from './live-list';
import { SessionStatus, STATUS_ORDER, statusOf } from './status';
import './RoomsPage.css';

// 房间表：一组房间（一个适配器实例，或还没记下实例的一个平台）一次取全，筛选、排序、搜索与分页都在客户端。
// 类型与状态的筛选写进地址；批量动作只有归档与删除。统一设置一类房间在设置的「会话默认」，表格下面一句话指过去

const FILTER_FIELDS = [
  {
    key: 'type',
    label: '类型',
    options: [
      { value: 'group', label: '群' },
      { value: 'private', label: '私聊' },
    ],
    matches: (s: SessionSummary, value: string) => s.audience === value,
  },
  {
    key: 'status',
    label: '状态',
    options: [
      { value: 'attention', label: '需要处理' },
      { value: 'error', label: '出错' },
      { value: 'running', label: '运行中' },
    ],
    matches: (s: SessionSummary, value: string) => s[value as 'attention' | 'error' | 'running'],
  },
];

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
    { key: 'type', label: '类型', render: s => (s.audience === 'private' ? '私聊' : '群') },
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
    FILTER_FIELDS.flatMap(field => {
      const value = params.get(field.key);
      return value ? [[field.key, value]] : [];
    }),
  );

  const setFilter = (values: Record<string, string>) =>
    setParams(
      current => {
        const next = new URLSearchParams(current);
        for (const field of FILTER_FIELDS) {
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
                  filter={{ fields: FILTER_FIELDS, values: filterValues, onChange: setFilter }}
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
              <p>
                要统一设置一类房间，用「会话默认」里这个平台的档或它的群、私聊条目；平台档按平台名生效，不区分实例。
              </p>
              <ButtonLink to={paths.settingsSection('session-defaults')} variant="text">
                去会话默认
              </ButtonLink>
            </div>
          </div>
        </SessionGate>
      </Panel>
    </Main>
  );
}
