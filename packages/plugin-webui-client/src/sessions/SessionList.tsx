import type { RoomGroup, SessionSummary } from '@aalis/api-session-protocol';
import { MessagesSquare, Plus, Search, Table2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Disclosure } from '../components/Disclosure';
import { IconButton } from '../components/IconButton';
import { List, ListItem } from '../components/List';
import { Menu } from '../components/Menu';
import { listTime } from '../format';
import { AttentionSummary } from '../health/AttentionList';
import { GetStarted } from '../health/GetStarted';
import { shortcutLabel } from '../keys';
import { PinnedList } from '../pages/Pinned';
import {
  addressOf,
  groupFromParams,
  inGroup,
  paths,
  type RoomGroupAddress,
  routes,
  useSessionAddress,
} from '../routes';
import { countNote, HOST_ENTRIES, useEntryCounts } from '../shell/entries';
import { SessionGate, SessionsFetchError } from '../shell/SessionGate';
import { Left, usePhone, useShell } from '../shell/Shell';
import { useSessionActions } from './actions';
import { useSessionList } from './live-list';
import { useMine } from './mine';
import { BackgroundStatus, SessionStatus, statusOf } from './status';
import './SessionList.css';

// 左栏的会话列表：只列根会话。「我的」在上；房间按适配器实例分组，组默认折叠，有需要处理的自动展开；底部是默认折叠的
// 「已归档」。子会话不在这里展开，在会话面板的「后台」标签里按会话树列出；有后台工作的行写「后台 N」。
// 手机上它是第一层，没有图标栏，「开始使用」（没有能对话的模型时）、「需要处理」的摘要、宿主的入口（运行状况带数）与固定的页面列在会话上面

/** 组内露出近这么久她开过口的房间，其余收进「其余 N 个」 */
const RECENT_REPLY_MS = 7 * 24 * 60 * 60_000;

export function SessionList() {
  const { openSearch } = useShell();
  const navigate = useNavigate();
  const phone = usePhone();
  const newSession = () => navigate(paths.newSession);
  return (
    <Left label="会话">
      {phone ? (
        <div className="header-bar session-list-header">
          <h1 className="session-list-title">会话</h1>
          <IconButton icon={Search} label="搜索" onClick={openSearch} />
          <IconButton icon={Plus} label="新会话" onClick={newSession} />
        </div>
      ) : (
        <div className="header-bar session-list-header">
          <Button icon={Plus} title={`新会话（${shortcutLabel('newSession')}）`} onClick={newSession}>
            新会话
          </Button>
          <IconButton icon={Search} label="搜索" shortcut={shortcutLabel('search')} onClick={openSearch} />
        </div>
      )}
      <div className="session-list-body">
        {phone && <GetStarted />}
        {phone && <AttentionSummary />}
        {phone && <Entries />}
        {phone && <PinnedList />}
        <SessionGate>
          <Sections />
        </SessionGate>
      </div>
    </Left>
  );
}

/** 手机第一层的宿主入口 */
function Entries() {
  const countOf = useEntryCounts();
  return (
    <List label="入口">
      {HOST_ENTRIES.map(({ area, label, icon: Icon, path }) => {
        const count = countOf(area);
        return (
          <ListItem
            key={area}
            to={path}
            title={
              <span className="pinned-title">
                <Icon aria-hidden />
                {label}
              </span>
            }
            meta={
              count !== undefined && (
                <>
                  <span aria-hidden>
                    <Badge tone="attention">{count}</Badge>
                  </span>
                  <span className="visually-hidden">{countNote(count)}</span>
                </>
              )
            }
          />
        );
      })}
    </List>
  );
}

function Sections() {
  const mine = useMine();
  if (mine.error) return <SessionsFetchError what="会话列表" error={mine.error} retry={mine.retry} />;
  if (!mine.sessions) return null;
  return (
    <>
      <Section title="我的">
        {mine.sessions.length === 0 ? (
          <p className="session-list-note">还没有会话</p>
        ) : (
          <List label="我的会话">
            {mine.sessions.map(session => (
              <SessionRow key={session.id} session={session} />
            ))}
          </List>
        )}
      </Section>
      {mine.groups.length > 0 && (
        <Section title="房间">
          {mine.groups.map(group => (
            <RoomGroupItem key={JSON.stringify(addressOf(group))} group={group} />
          ))}
        </Section>
      )}
      <Archive />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="section-heading session-list-heading">
        {title}
      </h2>
      {children}
    </section>
  );
}

function RoomGroupItem({ group }: { group: RoomGroup }) {
  const [open, setOpen] = useState<boolean>();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const address = addressOf(group);
  const expanded = open ?? group.attention > 0;
  const shown = pathname === routes.rooms ? groupFromParams(params) : undefined;
  const tableOpen = shown !== undefined && inGroup(shown, address);
  return (
    <div className="room-group">
      <div className="section-heading room-group-header">
        <Disclosure expanded={expanded} onToggle={() => setOpen(!expanded)}>
          <MessagesSquare aria-hidden />
          <span className="room-group-label">{group.label}</span>
          <span className="room-group-count">{`${group.rooms} 个房间`}</span>
        </Disclosure>
        {group.attention > 0 && (
          <span className="room-group-attention">
            <Badge tone="attention">{group.attention}</Badge>
            <span className="visually-hidden">个需要处理</span>
          </span>
        )}
        <IconButton
          icon={Table2}
          label={`用表格查看「${group.label}」的全部房间`}
          aria-current={tableOpen ? 'page' : undefined}
          onClick={() => navigate(paths.rooms(address))}
        />
      </div>
      {expanded && <GroupRooms query={address} label={group.label} accounts={group.accounts} />}
    </div>
  );
}

function GroupRooms({ query, label, accounts }: { query: RoomGroupAddress; label: string; accounts: number }) {
  const list = useSessionList(query);
  const current = useSessionAddress()?.sessionId;
  const [all, setAll] = useState(false);
  if (list.error) return <SessionsFetchError what="会话列表" error={list.error} retry={list.retry} />;
  if (!list.sessions) return null;
  const now = Date.now();
  const surfaced = list.sessions.filter(
    s =>
      s.attention ||
      s.error ||
      s.running ||
      s.background > 0 ||
      s.id === current ||
      (s.lastReplyAt !== undefined && now - s.lastReplyAt <= RECENT_REPLY_MS),
  );
  const rest = list.sessions.length - surfaced.length;
  return (
    <List label={label}>
      {(all ? list.sessions : surfaced).map(session => (
        <SessionRow key={session.id} session={session} account={accounts > 1} />
      ))}
      {rest > 0 && (
        <li>
          <button type="button" className="room-group-more" onClick={() => setAll(!all)}>
            {all ? '收起' : `其余 ${rest} 个`}
          </button>
        </li>
      )}
    </List>
  );
}

function Archive() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="已归档">
      <div className="section-heading">
        <Disclosure expanded={open} onToggle={() => setOpen(!open)}>
          已归档
        </Disclosure>
      </div>
      {open && <ArchivedSessions />}
    </section>
  );
}

function ArchivedSessions() {
  const list = useSessionList({ archived: true });
  if (list.error) return <SessionsFetchError what="会话列表" error={list.error} retry={list.retry} />;
  if (!list.sessions) return null;
  if (list.sessions.length === 0) return <p className="session-list-note">没有归档的会话</p>;
  return (
    <List label="已归档">
      {list.sessions.map(session => (
        <SessionRow key={session.id} session={session} />
      ))}
    </List>
  );
}

/**
 * 会话的一行：整行可点，「更多」收改名、归档、删除（已归档的是恢复、删除）。
 * 「我的」是双行，状态句在第二行；房间是单行，不正常时状态代替时间写在右侧。最要紧的状态之外有后台工作时写「后台 N」
 */
function SessionRow({ session, account }: { session: SessionSummary; account?: boolean }) {
  const actions = useSessionActions();
  const current = useSessionAddress()?.sessionId === session.id;
  const status = statusOf(session);
  const said =
    status === 'unread' || status === undefined ? (
      session.background > 0 && <BackgroundStatus count={session.background} />
    ) : (
      <SessionStatus session={session} status={status} />
    );
  const time = <time dateTime={new Date(session.updatedAt).toISOString()}>{listTime(session.updatedAt)}</time>;
  const room = session.kind === 'room';
  const items = session.archived
    ? [
        { label: '恢复', onSelect: () => actions.unarchive([session]) },
        { label: '删除', danger: true, onSelect: () => actions.remove([session]) },
      ]
    : [
        { label: '改名', onSelect: () => actions.rename(session) },
        { label: '归档', onSelect: () => actions.archive([session]) },
        { label: '删除', danger: true, onSelect: () => actions.remove([session]) },
      ];
  return (
    <ListItem
      to={paths.session(session.id)}
      title={
        <>
          {session.title}
          {account && <span className="session-account">{session.account}</span>}
        </>
      }
      detail={room ? undefined : said}
      meta={room ? said || time : time}
      marker={status === 'running' ? undefined : status}
      current={current}
      menu={<Menu label="更多" items={items} />}
    />
  );
}
