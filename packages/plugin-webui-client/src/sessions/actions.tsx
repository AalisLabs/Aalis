import type { SessionMethodResult } from '@aalis/api-session-protocol';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { useSessionClient } from '../connection';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import './actions.css';

// 会话的改名、归档、恢复与删除：列表行、房间表与会话头共用一处对话框与回报。
// 归档可撤销，直接做并给一条带「撤销」的 Toast；删除不可撤销，先确认，确认框点名对象、焦点落在「取消」上

interface SessionRef {
  id: string;
  title: string;
}

type BatchResult = SessionMethodResult<'session/batch'>;

interface SessionActions {
  rename(session: SessionRef): void;
  archive(sessions: readonly SessionRef[]): void;
  unarchive(sessions: readonly SessionRef[]): void;
  remove(sessions: readonly SessionRef[]): void;
}

const Context = createContext<SessionActions | undefined>(undefined);

export function useSessionActions(): SessionActions {
  const actions = useContext(Context);
  if (!actions) throw new Error('只能在 SessionActionsProvider 里取会话操作');
  return actions;
}

const named = (sessions: readonly SessionRef[]) =>
  sessions.length === 1 ? `「${sessions[0].title}」` : ` ${sessions.length} 个会话`;

export function SessionActionsProvider({ children }: { children: ReactNode }) {
  const client = useSessionClient();
  const toast = useToast();
  const source = useProvider(SESSION_PROTOCOL);
  const [renaming, setRenaming] = useState<SessionRef>();
  const [removing, setRemoving] = useState<readonly SessionRef[]>();

  const failed = useCallback(
    (verb: string, err: unknown) => toast({ kind: 'danger', text: `${verb}失败：${(err as Error).message}`, source }),
    [toast, source],
  );
  /** 批量操作里有没做成的：写数目与第一个的原因 */
  const partial = useCallback(
    (verb: string, { failed: missed }: BatchResult) => {
      if (missed.length === 0) return;
      toast({ kind: 'danger', text: `有 ${missed.length} 个会话没能${verb}：${missed[0].message}`, source });
    },
    [toast, source],
  );

  const unarchive = useCallback(
    async (sessions: readonly SessionRef[]) => {
      const results = await Promise.allSettled(
        sessions.map(s => client.request('session/unarchive', { sessionId: s.id })),
      );
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) failed('恢复', rejected.reason);
    },
    [client, failed],
  );

  const archive = useCallback(
    async (sessions: readonly SessionRef[]) => {
      try {
        const result = await client.request('session/batch', { op: 'archive', ids: sessions.map(s => s.id) });
        const done = sessions.filter(s => !result.failed.some(f => f.sessionId === s.id));
        partial('归档', result);
        if (done.length > 0) {
          toast({
            kind: 'success',
            text: `已归档${named(done)}`,
            action: { label: '撤销', run: () => void unarchive(done) },
          });
        }
      } catch (err) {
        failed('归档', err);
      }
    },
    [client, toast, failed, partial, unarchive],
  );

  const actions = useMemo<SessionActions>(
    () => ({
      rename: setRenaming,
      archive: sessions => void archive(sessions),
      unarchive: sessions => void unarchive(sessions),
      remove: setRemoving,
    }),
    [archive, unarchive],
  );

  return (
    <Context.Provider value={actions}>
      {children}
      <RenameDialog target={renaming} onClose={() => setRenaming(undefined)} />
      <DeleteDialog targets={removing} failed={failed} partial={partial} onClose={() => setRemoving(undefined)} />
    </Context.Provider>
  );
}

function RenameDialog({ target, onClose }: { target?: SessionRef; onClose(): void }) {
  const client = useSessionClient();
  const formId = useId();
  const [shown, setShown] = useState(target);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (target !== shown) {
    setShown(target);
    setTitle(target?.title ?? '');
    setError(undefined);
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = title.trim();
    if (!target || !next) return;
    setBusy(true);
    try {
      await client.request('session/rename', { sessionId: target.id, title: next });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={target !== undefined}
      title="改名"
      size="form"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form={formId} busy={busy} disabled={!title.trim()}>
            保存
          </Button>
        </>
      }
    >
      <form id={formId} className="session-form" onSubmit={submit}>
        <input
          aria-label="会话名"
          value={title}
          aria-invalid={error ? true : undefined}
          data-autofocus
          onChange={event => setTitle(event.target.value)}
        />
        {error && (
          <p className="session-form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

interface DeleteDialogProps {
  targets?: readonly SessionRef[];
  failed(verb: string, err: unknown): void;
  partial(verb: string, result: BatchResult): void;
  onClose(): void;
}

function DeleteDialog({ targets, failed, partial, onClose }: DeleteDialogProps) {
  const client = useSessionClient();
  const [busy, setBusy] = useState(false);

  const deleteSessions = async (sessions: readonly SessionRef[]) => {
    setBusy(true);
    try {
      partial('删除', await client.request('session/batch', { op: 'delete', ids: sessions.map(s => s.id) }));
    } catch (err) {
      failed('删除', err);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog
      open={targets !== undefined}
      title={targets ? `删除${targets.length === 1 ? '会话' : ''}${named(targets)}？` : ''}
      onClose={onClose}
      footer={
        targets && (
          <>
            <Button data-autofocus onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" danger busy={busy} onClick={() => void deleteSessions(targets)}>
              删除
            </Button>
          </>
        )
      }
    >
      会话的消息记录与长期记忆都会清空，删除后不能恢复。
    </Dialog>
  );
}
