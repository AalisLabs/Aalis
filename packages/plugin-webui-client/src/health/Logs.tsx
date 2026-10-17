import { approvals } from '@aalis/api-approval';
import type { LogFilter, WebuiAdminEvent } from '@aalis/api-webui';
import type { TextRef } from '@aalis/schema-i18n';
import { type FormEvent, useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '../components/Button';
import { ButtonLink } from '../components/ButtonLink';
import { EmptyState } from '../components/EmptyState';
import { FetchError } from '../components/FetchError';
import { Select } from '../components/Select';
import { useToast } from '../components/Toast';
import { useConnection, useConnectionState } from '../connection';
import { compareText, fullTime, logTime } from '../format';
import { text, tr } from '../language';
import { withInstance } from '../pages/registry';
import { labelOf, usePlugins, useProvider } from '../plugins/list';
import { getJson, isRecord } from '../rest';
import { logFilterFrom, logQuery, paths } from '../routes';
import { t } from '../texts';

// 日志标签：筛选写在地址里，服务端按它筛历史与实时推送。先订阅、再取最后一页历史，取回之前推来的按序号接在后面；
// 管理连接重连或筛选变了就重新订阅、重取，离开时退订。最新的在底部，停在底部时新来的出现在视野里

type LogEntry = Extract<WebuiAdminEvent, { type: 'log' }>['entry'];
type LogLevel = LogEntry['level'];

/** 历史一页的条数，「更早的日志」每次也翻这么多 */
const PAGE = 200;
/** 页面上最多留这么多条，实时推来的多了丢最早的 */
const KEEP = 2000;

const LEVELS: Record<LogLevel, TextRef> = {
  debug: t('logLevelDebug'),
  info: t('logLevelInfo'),
  warn: t('logLevelWarn'),
  error: t('logLevelError'),
};
const LEVEL_FILTERS: ReadonlyArray<{ value: LogLevel | ''; label: TextRef }> = [
  { value: '', label: t('logLevelAll') },
  { value: 'info', label: t('logLevelInfoUp') },
  { value: 'warn', label: t('logLevelWarnUp') },
  { value: 'error', label: t('logErrorsOnly') },
];

function parseEntries(body: unknown): LogEntry[] {
  const valid =
    Array.isArray(body) &&
    body.every(
      entry =>
        isRecord(entry) &&
        typeof entry.seq === 'number' &&
        typeof entry.timestamp === 'string' &&
        Object.hasOwn(LEVELS, String(entry.level)) &&
        typeof entry.scope === 'string' &&
        typeof entry.message === 'string',
    );
  if (!valid) throw new Error(tr('logsMalformed'));
  return body as LogEntry[];
}

/** 取历史的地址：给了 before 时往前翻 */
function historyPath(query: string, before?: number): string {
  const params = new URLSearchParams(query);
  params.set('limit', String(PAGE));
  if (before !== undefined) params.set('before', String(before));
  return `/api/logs/${before === undefined ? 'tail' : 'range'}?${params}`;
}

interface Loaded {
  entries: LogEntry[];
  /** 最近一次取满了一页，可能还有更早的 */
  more: boolean;
}

/** query 是筛选的查询串（logQuery）。取到之前与取数失败时没有 loaded */
function useLogs(query: string) {
  const { admin } = useConnection();
  const open = useConnectionState(admin).status === 'open';
  const toast = useToast();
  const [version, retry] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<{ query: string; loaded?: Loaded; error?: Error }>({ query });
  const [busy, setBusy] = useState(false);
  const older = useRef<AbortController>(undefined);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    /** 历史取回之前推来的先攒着 */
    let early: LogEntry[] | undefined = [];
    // 推送与历史走两条连接，先后不定：比历史里最后一条旧的已经在里面了
    const off = admin.on('log', ({ entry }) => {
      if (early) early.push(entry);
      else
        setState(last =>
          last.loaded && entry.seq > (last.loaded.entries.at(-1)?.seq ?? Number.NEGATIVE_INFINITY)
            ? { ...last, loaded: { ...last.loaded, entries: [...last.loaded.entries, entry].slice(-KEEP) } }
            : last,
        );
    });
    admin.send({ type: 'log.subscribe', filter: logFilterFrom(new URLSearchParams(query)) });
    getJson(historyPath(query), controller.signal)
      .then(parseEntries)
      .then(
        tail => {
          const last = tail.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
          const entries = [...tail, ...(early ?? []).filter(entry => entry.seq > last)].slice(-KEEP);
          early = undefined;
          setState({ query, loaded: { entries, more: tail.length === PAGE } });
        },
        (error: Error) => {
          early = undefined;
          if (!controller.signal.aborted) setState({ query, error });
        },
      );
    return () => {
      off();
      controller.abort();
      older.current?.abort();
      admin.send({ type: 'log.unsubscribe' });
    };
  }, [admin, open, query, version]);

  const current = state.query === query ? state : { query };
  const loadOlder = () => {
    const first = current.loaded?.entries[0]?.seq;
    if (first === undefined) return;
    const controller = new AbortController();
    older.current = controller;
    setBusy(true);
    getJson(historyPath(query, first), controller.signal)
      .then(parseEntries)
      .then(
        earlier =>
          setState(last =>
            last.query === query && last.loaded
              ? { ...last, loaded: { entries: [...earlier, ...last.loaded.entries], more: earlier.length === PAGE } }
              : last,
          ),
        (error: Error) => {
          if (!controller.signal.aborted)
            toast({ kind: 'danger', text: tr('logsOlderFailed', { error: error.message }) });
        },
      )
      .finally(() => setBusy(false));
  };
  return { ...current, retry, loadOlder, busy };
}

export function Logs() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const filter = logFilterFrom(params);
  const query = logQuery(filter);
  const { loaded, error, retry, loadOlder, busy } = useLogs(query);
  const { plugins } = usePlugins();
  /** 「审批」预设按插件列表的 provides 找提供审批服务的实例 */
  const approver = useProvider(approvals.name);
  const options = (plugins ?? [])
    .map(plugin => ({ value: plugin.instanceId, label: withInstance(labelOf(plugin), plugin.instanceId) }))
    .sort((a, b) => compareText(a.label, b.label));
  if (filter.plugin && !options.some(option => option.value === filter.plugin)) {
    options.push({ value: filter.plugin, label: filter.plugin });
  }
  const apply = (next: LogFilter) => navigate(paths.healthLogs({ ...filter, ...next }), { replace: true });
  const submitText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply({ text: String(new FormData(event.currentTarget).get('text') ?? '').trim() });
  };

  return (
    <div className="health-logs">
      <form aria-label={tr('logsFilter')} className="health-logs-filters" onSubmit={submitText}>
        <ButtonLink to={paths.healthLogs({ level: 'error' })}>{tr('logErrorsOnly')}</ButtonLink>
        {approver && <ButtonLink to={paths.healthLogs({ plugin: approver })}>{tr('approvals')}</ButtonLink>}
        <Select
          aria-label={tr('logsLevel')}
          value={filter.level ?? ''}
          options={LEVEL_FILTERS.map(({ value, label }) => ({ value, label: text(label) }))}
          onChange={value => apply({ level: (value || undefined) as LogLevel | undefined })}
        />
        <Select
          aria-label={tr('plugins')}
          value={filter.plugin ?? ''}
          options={[{ value: '', label: tr('logsAllPlugins') }, ...options]}
          onChange={value => apply({ plugin: value })}
        />
        <input
          key={filter.text ?? ''}
          type="search"
          name="text"
          aria-label={tr('logsText')}
          placeholder={tr('logsTextPlaceholder')}
          defaultValue={filter.text ?? ''}
        />
        {query && (
          <ButtonLink to={paths.healthLogs()} variant="text">
            {tr('clearFilters')}
          </ButtonLink>
        )}
      </form>
      {error ? (
        // 日志本身没取到，「查看日志」帮不上
        <FetchError what={tr('logs')} error={error} retry={retry} />
      ) : (
        loaded &&
        (loaded.entries.length === 0 ? (
          <EmptyState
            title={tr(query ? 'logsNoMatch' : 'logsEmpty')}
            description={tr(query ? 'logsNoMatchHint' : 'logsEmptyHint')}
          />
        ) : (
          <div className="health-logs-scroll">
            <div className="health-logs-content">
              {loaded.more && (
                <Button variant="text" busy={busy} onClick={loadOlder}>
                  {tr('logsOlder')}
                </Button>
              )}
              <ol className="log-list" aria-label={tr('logs')}>
                {loaded.entries.map(entry => (
                  <li key={entry.seq} className="log-line" data-level={entry.level}>
                    <span className="log-meta">
                      <time dateTime={entry.timestamp} title={fullTime(Date.parse(entry.timestamp))}>
                        {logTime(Date.parse(entry.timestamp))}
                      </time>
                      <span className="log-level">{text(LEVELS[entry.level])}</span>
                      <span className="log-scope" title={entry.scope}>
                        {entry.scope}
                      </span>
                    </span>
                    <span className="log-message">{entry.message}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
