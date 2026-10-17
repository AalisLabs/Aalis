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
import { text, tr } from '../language';
import { PinnedList } from '../pages/Pinned';
import type { RoomGroup, SessionSummary } from '../protocol/session-client';
import {
  addressOf,
  groupFromParams,
  inGroup,
  paths,
  type RoomGroupAddress,
  routes,
  useSessionAddress,
} from '../routes';
import { entryName, HOST_ENTRIES, useEntryCounts } from '../shell/entries';
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
    <Left label={tr('sessions')}>
      {phone ? (
        <div className="header-bar session-list-header">
          <h1 className="session-list-title">{tr('sessions')}</h1>
          <IconButton icon={Search} label={tr('search')} onClick={openSearch} />
          <IconButton icon={Plus} label={tr('newSession')} onClick={newSession} />
        </div>
      ) : (
        <div className="header-bar session-list-header">
          <Button
            icon={Plus}
            title={tr('withShortcut', { label: tr('newSession'), shortcut: shortcutLabel('newSession') })}
            onClick={newSession}
          >
            {tr('newSession')}
          </Button>
          <IconButton icon={Search} label={tr('search')} shortcut={shortcutLabel('search')} onClick={openSearch} />
        </div>
      )}
      <div className="session-list-body">
        {phone && <GetStarted />}
        {phone && <AttentionSummary />}
        {phone && <Entries />}
        {phone && <PinnedList />}
        <SessionGate quiet={!phone}>
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
    <List label={tr('entries')}>
      {HOST_ENTRIES.map(({ area, label, icon: Icon, path }) => {
        const count = countOf(area);
        const name = text(label);
        return (
          <ListItem
            key={area}
            to={path}
            title={
              // 带数时读屏读后面的整句
              <span className="pinned-title" aria-hidden={count !== undefined || undefined}>
                <Icon aria-hidden />
                {name}
              </span>
            }
            meta={
              count !== undefined && (
                <>
                  <span aria-hidden>
                    <Badge tone="attention">{count}</Badge>
                  </span>
                  <span className="visually-hidden">{entryName(name, count)}</span>
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
  if (mine.error) return <SessionsFetchError what={tr('sessionList')} error={mine.error} retry={mine.retry} />;
  if (!mine.sessions) return null;
  return (
    <>
      <Section title={tr('mine')}>
        {mine.sessions.length === 0 ? (
          <p className="session-list-note">{tr('noSessions')}</p>
        ) : (
          <List label={tr('mySessions')}>
            {mine.sessions.map(session => (
              <SessionRow key={session.id} session={session} />
            ))}
          </List>
        )}
      </Section>
      {mine.groups.length > 0 && (
        <Section title={tr('rooms')}>
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
          <span className="room-group-count">{tr('roomCount', { count: group.rooms })}</span>
        </Disclosure>
        {group.attention > 0 && (
          <span className="room-group-attention">
            <span aria-hidden>
              <Badge tone="attention">{group.attention}</Badge>
            </span>
            <span className="visually-hidden">{tr('roomAttention', { count: group.attention })}</span>
          </span>
        )}
        <IconButton
          icon={Table2}
          label={tr('roomTable', { group: group.label })}
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
  if (list.error) return <SessionsFetchError what={tr('sessionList')} error={list.error} retry={list.retry} />;
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
            {all ? tr('showLess') : tr('restCount', { count: rest })}
          </button>
        </li>
      )}
    </List>
  );
}

function Archive() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={tr('archived')}>
      <div className="section-heading">
        <Disclosure expanded={open} onToggle={() => setOpen(!open)}>
          {tr('archived')}
        </Disclosure>
      </div>
      {open && <ArchivedSessions />}
    </section>
  );
}

function ArchivedSessions() {
  const list = useSessionList({ archived: true });
  if (list.error) return <SessionsFetchError what={tr('sessionList')} error={list.error} retry={list.retry} />;
  if (!list.sessions) return null;
  if (list.sessions.length === 0) return <p className="session-list-note">{tr('noArchived')}</p>;
  return (
    <List label={tr('archived')}>
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
        { label: tr('restore'), onSelect: () => actions.unarchive([session]) },
        { label: tr('delete'), danger: true, onSelect: () => actions.remove([session]) },
      ]
    : [
        { label: tr('rename'), onSelect: () => actions.rename(session) },
        { label: tr('archive'), onSelect: () => actions.archive([session]) },
        { label: tr('delete'), danger: true, onSelect: () => actions.remove([session]) },
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
      menu={<Menu label={tr('more')} items={items} />}
    />
  );
}
