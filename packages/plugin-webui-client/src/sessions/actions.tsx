import type { SessionMethodResult } from '@aalis/api-session-protocol';
import type { Localized, TextRef } from '@aalis/schema-i18n';
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
import { tr } from '../language';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import { t } from '../texts';
import './actions.css';

// 会话的改名、归档、恢复与删除：列表行、房间表与会话头共用一处对话框与回报。
// 归档可撤销，直接做并给一条带「撤销」的 Toast；删除不可撤销，先确认，确认框点名对象、焦点落在「取消」上

interface SessionRef {
  id: string;
  title: string;
}

type BatchResult = Localized<SessionMethodResult<'session/batch'>>;

interface SessionActions {
  rename(session: SessionRef): void;
  archive(sessions: readonly SessionRef[]): void;
  unarchive(sessions: readonly SessionRef[]): void;
  remove(sessions: readonly SessionRef[]): void;
}

const Context = createContext<SessionActions | undefined>(undefined);

export function useSessionActions(): SessionActions {
  const actions = useContext(Context);
  if (!actions) throw new Error(tr('sessionActionsOutsideProvider'));
  return actions;
}

export function SessionActionsProvider({ children }: { children: ReactNode }) {
  const client = useSessionClient();
  const toast = useToast();
  const source = useProvider(SESSION_PROTOCOL);
  const [renaming, setRenaming] = useState<SessionRef>();
  const [removing, setRemoving] = useState<readonly SessionRef[]>();

  const failed = useCallback(
    (action: TextRef, err: unknown) =>
      toast({ kind: 'danger', text: tr('actionFailed', { action, error: (err as Error).message }), source }),
    [toast, source],
  );
  /** 批量操作里有没做成的：写数目与第一个的原因 */
  const partial = useCallback(
    (op: 'archive' | 'delete', { failed: missed }: BatchResult) => {
      if (missed.length === 0) return;
      const counted = { count: missed.length, error: missed[0].message };
      toast({
        kind: 'danger',
        text: op === 'archive' ? tr('batchArchiveFailed', counted) : tr('batchDeleteFailed', counted),
        source,
      });
    },
    [toast, source],
  );

  const unarchive = useCallback(
    async (sessions: readonly SessionRef[]) => {
      const results = await Promise.allSettled(
        sessions.map(s => client.request('session/unarchive', { sessionId: s.id })),
      );
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) failed(t('restore'), rejected.reason);
    },
    [client, failed],
  );

  const archive = useCallback(
    async (sessions: readonly SessionRef[]) => {
      try {
        const result = await client.request('session/batch', { op: 'archive', ids: sessions.map(s => s.id) });
        const done = sessions.filter(s => !result.failed.some(f => f.sessionId === s.id));
        partial('archive', result);
        if (done.length > 0) {
          toast({
            kind: 'success',
            text:
              done.length === 1
                ? tr('archivedOne', { title: done[0].title })
                : tr('archivedMany', { count: done.length }),
            action: { label: tr('undo'), run: () => void unarchive(done) },
          });
        }
      } catch (err) {
        failed(t('archive'), err);
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
      title={tr('rename')}
      size="form"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{tr('cancel')}</Button>
          <Button variant="primary" type="submit" form={formId} busy={busy} disabled={!title.trim()}>
            {tr('save')}
          </Button>
        </>
      }
    >
      <form id={formId} className="session-form" onSubmit={submit}>
        <input
          aria-label={tr('sessionName')}
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
  failed(action: TextRef, err: unknown): void;
  partial(op: 'archive' | 'delete', result: BatchResult): void;
  onClose(): void;
}

function DeleteDialog({ targets, failed, partial, onClose }: DeleteDialogProps) {
  const client = useSessionClient();
  const [busy, setBusy] = useState(false);

  const deleteSessions = async (sessions: readonly SessionRef[]) => {
    setBusy(true);
    try {
      partial('delete', await client.request('session/batch', { op: 'delete', ids: sessions.map(s => s.id) }));
    } catch (err) {
      failed(t('delete'), err);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog
      open={targets !== undefined}
      title={
        targets === undefined
          ? ''
          : targets.length === 1
            ? tr('deleteSessionConfirm', { title: targets[0].title })
            : tr('deleteSessionsConfirm', { count: targets.length })
      }
      onClose={onClose}
      footer={
        targets && (
          <>
            <Button data-autofocus onClick={onClose}>
              {tr('cancel')}
            </Button>
            <Button variant="primary" danger busy={busy} onClick={() => void deleteSessions(targets)}>
              {tr('delete')}
            </Button>
          </>
        )
      }
    >
      {tr('deleteSessionNote')}
    </Dialog>
  );
}
