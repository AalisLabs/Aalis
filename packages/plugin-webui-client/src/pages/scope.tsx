import type { ActionView, DeclarativePageView, PageDataByType, PageRow } from '@aalis/api-webui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { useConnection } from '../connection';
import { isRecord, postJson, useJson } from '../rest';
import { ActionForm } from './ActionForm';

// 一个打开着的声明式页面：取数与动作都按它的实例、key 与会话（会话面板）走。整页在手动刷新与管理连接重连后重取；
// 一个组件在插件推来的 page.invalidate 指到它时重取（带会话的只认打开着这个会话的面板）。
// 动作按 effect 推出交互：带输入的弹表单，destructive 先确认，其余直接调；发出后到回来这个动作在这一行上算进行中。
// 成功时插件给的一句结果用 Toast 显示，失败按用户操作的失败显示（开着的表单写在表单上）。结果变了由插件 invalidate，
// 这里不自己重取

/** destructive 动作没写确认文案时，宿主的确认框写这一句（声明式页面与插件前端同一句） */
export const DEFAULT_CONFIRM = '这个操作不能撤销。';

interface Scope {
  page: DeclarativePageView;
  /** 会话面板的会话 */
  sessionId?: string;
  /** 整页重取的计数：PageScope 收的是手动刷新的次数，给组件的另加上管理连接重连的次数 */
  version: number;
}

/** 动作作用的那一行：行动作的 rowKey，以及给表单预填的这一行的值 */
export interface ActionTarget {
  rowKey: string;
  row?: PageRow;
}

interface Running {
  /** 这个动作在这一行（页面动作不带行）上还没回来 */
  busy(name: string, target?: ActionTarget): boolean;
  run(name: string, target?: ActionTarget): void;
}

const ScopeContext = createContext<Scope | undefined>(undefined);
const RunningContext = createContext<Running | undefined>(undefined);

/** 打开着的页面与它的会话 */
export function usePageScope(): Scope {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error('只能在页面里取页面的数据');
  return scope;
}

export function useActions(): Running & { actions: Readonly<Record<string, ActionView>> } {
  const running = useContext(RunningContext);
  const { page } = usePageScope();
  if (!running) throw new Error('只能在页面里调页面的动作');
  return { ...running, actions: page.actions ?? {} };
}

const enc = encodeURIComponent;
const pageBase = (page: DeclarativePageView) => `/api/pages/${enc(page.instance)}/${enc(page.key)}`;

const PARSERS: { [T in keyof PageDataByType]: (body: unknown) => PageDataByType[T] } = {
  table: body => dataOf(body, Array.isArray, '行的数组') as PageDataByType['table'],
  graph: body =>
    dataOf(
      body,
      data => isRecord(data) && Array.isArray(data.nodes) && Array.isArray(data.edges),
      '{ nodes, edges }',
    ) as PageDataByType['graph'],
  info: body => dataOf(body, Array.isArray, '{ label, value } 的数组') as PageDataByType['info'],
  markdown: body => dataOf(body, data => typeof data === 'string', '文字') as string,
};

function dataOf(body: unknown, test: (data: unknown) => boolean, shape: string): unknown {
  const data = isRecord(body) ? body.data : undefined;
  if (!test(data)) throw new Error(`取回的数据不是${shape}`);
  return data;
}

/** 一个组件的数据：详情里的组件带上选中的 rowKey */
export function usePageData<T extends keyof PageDataByType>(
  type: T,
  componentId: string,
  rowKey?: string,
): { value?: PageDataByType[T]; error?: Error; retry(): void } {
  const { page, sessionId, version } = usePageScope();
  const { admin } = useConnection();
  const [own, invalidate] = useReducer((n: number) => n + 1, 0);

  useEffect(
    () =>
      admin.on('page.invalidate', event => {
        if (event.instance !== page.instance || event.pageKey !== page.key) return;
        if (event.componentId !== undefined && event.componentId !== componentId) return;
        if (event.sessionId !== undefined && event.sessionId !== sessionId) return;
        invalidate();
      }),
    [admin, page.instance, page.key, componentId, sessionId],
  );

  const query = new URLSearchParams();
  if (sessionId !== undefined) query.set('sessionId', sessionId);
  if (rowKey !== undefined) query.set('rowKey', rowKey);
  const search = query.toString();
  const path = `${pageBase(page)}/data/${enc(componentId)}${search ? `?${search}` : ''}`;
  const result = useJson(path, PARSERS[type], `${version}:${own}`);
  return { ...result, retry: invalidate };
}

/** 弹出的确认框或表单：哪个动作、作用于哪一行 */
interface Pending {
  name: string;
  action: ActionView;
  target?: ActionTarget;
}

const keyOf = (name: string, target?: ActionTarget) => JSON.stringify([name, target?.rowKey ?? null]);

export function PageScope({ page, sessionId, version, children }: Scope & { children: ReactNode }) {
  const { admin } = useConnection();
  const [reconnects, reconnected] = useReducer((n: number) => n + 1, 0);
  useEffect(() => admin.onReconnect(reconnected), [admin]);
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<Pending>();
  /** 正在显示的对话框：调用回来时据此判断发起它的那个还开着没有 */
  const shown = useRef<Pending>(undefined);
  useEffect(() => {
    shown.current = pending;
  }, [pending]);
  const actions: Readonly<Record<string, ActionView>> = page.actions ?? {};

  /** 调一个动作，回来之前这个动作在这一行上算进行中；成功时 Toast 写插件给的结果，失败时把错误交给调用方 */
  const call = useCallback(
    async (name: string, target?: ActionTarget, input?: Record<string, unknown>) => {
      const key = keyOf(name, target);
      setBusy(current => new Set(current).add(key));
      try {
        const body = {
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(target === undefined ? {} : { rowKey: target.rowKey }),
          ...(input === undefined ? {} : { input }),
        };
        const reply = await postJson(`${pageBase(page)}/actions/${enc(name)}`, body);
        const message = isRecord(reply) ? reply.message : undefined;
        if (typeof message === 'string') toast({ kind: 'success', text: message });
      } finally {
        setBusy(current => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [page, sessionId, toast],
  );

  const failed = useCallback(
    (action: ActionView, err: unknown) =>
      toast({ kind: 'danger', text: `${action.label}失败：${(err as Error).message}` }),
    [toast],
  );

  const running = useMemo<Running>(
    () => ({
      busy: (name, target) => busy.has(keyOf(name, target)),
      run(name, target) {
        const action = actions[name];
        if (action.input || action.effect === 'destructive') setPending({ name, action, target });
        else call(name, target).catch(err => failed(action, err));
      },
    }),
    [actions, busy, call, failed],
  );

  /**
   * 对话框里发出的调用。对话框在回来之前可以关掉，这一行照样显示进行中；回来时只关发起它的那个（之后打开的不动）。
   * 失败时发起它的表单还开着就写在表单上，其余用 Toast 报
   */
  const submit = useCallback(
    async (mine: Pending, input?: Record<string, unknown>) => {
      try {
        await call(mine.name, mine.target, input);
      } catch (err) {
        if (mine.action.input && shown.current === mine) throw err;
        failed(mine.action, err);
      }
      setPending(current => (current === mine ? undefined : current));
    },
    [call, failed],
  );

  const scope = useMemo(
    () => ({ page, sessionId, version: version + reconnects }),
    [page, sessionId, version, reconnects],
  );
  return (
    <ScopeContext.Provider value={scope}>
      <RunningContext.Provider value={running}>
        {children}
        <ActionDialog
          pending={pending}
          busy={pending !== undefined && busy.has(keyOf(pending.name, pending.target))}
          submit={input => (pending ? submit(pending, input) : Promise.resolve())}
          onClose={() => setPending(undefined)}
        />
      </RunningContext.Provider>
    </ScopeContext.Provider>
  );
}

/**
 * 带输入的动作弹表单，destructive 先确认：确认框的标题是按钮上的字加问号，正文是插件给的确认文案（没写时是默认的警示，
 * 带输入的写在表单里），焦点落在「取消」上。对话框一直挂着，关上时焦点回到打开它的按钮
 */
function ActionDialog({
  pending,
  busy,
  submit,
  onClose,
}: {
  pending?: Pending;
  /** 这个动作在这一行上还没回来 */
  busy: boolean;
  submit(input?: Record<string, unknown>): Promise<void>;
  onClose(): void;
}) {
  const formId = useId();
  const action = pending?.action;
  const warning = action?.effect === 'destructive' ? (action.confirm ?? DEFAULT_CONFIRM) : undefined;
  return (
    <Dialog
      open={action !== undefined}
      title={action ? (action.input ? action.label : `${action.label}？`) : ''}
      size={action?.input ? 'form' : 'confirm'}
      onClose={onClose}
      footer={
        action && (
          <>
            <Button data-autofocus={action.input ? undefined : true} onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              danger={action.effect === 'destructive'}
              busy={busy}
              {...(action.input ? { type: 'submit', form: formId } : { onClick: () => void submit() })}
            >
              {action.label}
            </Button>
          </>
        )
      }
    >
      {action?.input ? (
        <ActionForm
          key={keyOf(pending?.name ?? '', pending?.target)}
          id={formId}
          warning={warning}
          fields={action.input}
          row={pending?.target?.row}
          submit={submit}
        />
      ) : (
        <p>{warning}</p>
      )}
    </Dialog>
  );
}
