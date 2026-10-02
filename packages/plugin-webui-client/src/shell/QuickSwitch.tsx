import type { RoomGroup, SessionSummary } from '@aalis/api-session-protocol';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { Dialog } from '../components/Dialog';
import { useSessionClient } from '../connection';
import { composing } from '../keys';
import { addressOf, inGroup, paths } from '../routes';
import './QuickSwitch.css';

// 快速切换：按名称、id 与「平台:群号」搜会话（根会话，不含已归档的），方向键选、回车打开

const RESULT_LIMIT = 20;

interface Result {
  sessions: SessionSummary[];
  groups: RoomGroup[];
}

function where(session: SessionSummary, groups: RoomGroup[]): string {
  if (session.kind === 'owner') return '我的';
  const group = groups.find(g => inGroup(session, addressOf(g)));
  return group?.label ?? session.platform ?? '';
}

export function QuickSwitch({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} title="搜索会话" onClose={onClose}>
      {open && <Search onClose={onClose} />}
    </Dialog>
  );
}

function Search({ onClose }: { onClose(): void }) {
  const client = useSessionClient();
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<Error>();
  const [active, setActive] = useState(0);

  useEffect(() => {
    let stale = false;
    client.request('sessions/list', { query: query.trim() || undefined, limit: RESULT_LIMIT }).then(
      next => {
        if (stale) return;
        setResult(next);
        setError(undefined);
        setActive(0);
      },
      (err: Error) => {
        if (!stale) setError(err);
      },
    );
    return () => {
      stale = true;
    };
  }, [client, query]);

  const sessions = result?.sessions ?? [];
  const optionId = (index: number) => `${listId}-${index}`;

  const choose = (session: SessionSummary) => {
    onClose();
    navigate(paths.session(session.id));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (sessions.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + sessions.length) % sessions.length);
    } else if (event.key === 'Enter' && !composing(event.nativeEvent)) {
      event.preventDefault();
      choose(sessions[active]);
    }
  };

  return (
    <div className="quick-switch">
      <input
        type="search"
        role="combobox"
        aria-label="搜索会话"
        aria-expanded={sessions.length > 0}
        aria-controls={listId}
        aria-activedescendant={sessions.length > 0 ? optionId(active) : undefined}
        placeholder="名称、id 或「平台:群号」"
        value={query}
        data-autofocus
        onChange={event => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error ? (
        <p className="quick-switch-note" role="alert">
          {error.message}
        </p>
      ) : (
        result && sessions.length === 0 && <p className="quick-switch-note">没有找到会话</p>
      )}
      <div id={listId} role="listbox" aria-label="搜索结果" className="quick-switch-results">
        {sessions.map((session, index) => (
          <button
            key={session.id}
            type="button"
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            tabIndex={-1}
            className="quick-switch-option"
            onClick={() => choose(session)}
            onMouseMove={() => setActive(index)}
          >
            <span className="quick-switch-title">{session.title}</span>
            <span className="quick-switch-where">{where(session, result?.groups ?? [])}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
