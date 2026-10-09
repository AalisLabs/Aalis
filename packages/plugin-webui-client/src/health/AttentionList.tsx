import type { AttentionItem } from '@aalis/api-webui';
import type { ReactNode } from 'react';
import { ButtonLink } from '../components/ButtonLink';
import { FetchError } from '../components/FetchError';
import { MARKERS } from '../components/List';
import { pageAddress, usePages } from '../pages/registry';
import { useFindPlugin, useHost } from '../plugins/list';
import { fixLink, markerOf, pluginName, statusLine, statusOf } from '../plugins/status';
import { paths } from '../routes';
import { useAttention } from './attention';
import './AttentionList.css';

/** 首页摘要最多列这么多条 */
const SUMMARY_LIMIT = 5;

/** 一行：行首的标记（没有时不标），标题与说明两行，行尾一个操作 */
export interface Row {
  key: string;
  tone?: 'attention' | 'error';
  title: string;
  detail?: string;
  action?: ReactNode;
}

/** 一组行：「需要处理」与「开始使用」都是这个样子 */
export function Rows({ rows }: { rows: readonly Row[] }) {
  return (
    <ul className="attention-list">
      {rows.map(row => (
        <li key={row.key} className="attention-row" data-marker={row.tone}>
          <span className="list-item-marker" aria-hidden />
          {row.tone && <span className="visually-hidden">{MARKERS[row.tone]}</span>}
          <span className="attention-text">
            <span className="attention-title">{row.title}</span>
            {row.detail && <span className="attention-detail">{row.detail}</span>}
          </span>
          {row.action}
        </li>
      ))}
    </ul>
  );
}

const link = (to: string, label: string) => <ButtonLink to={to}>{label}</ButtonLink>;

/**
 * 每项一行：审批进它的会话；插件故障写状态与原因，缺服务的去第一条链的根插件（没有根插件可去时进这个插件的详情），
 * 待配置的去配置区；提示的跳转由宿主推出（去配置、打开它指向的页面）
 */
function useRows(items: readonly AttentionItem[], named: boolean): Row[] {
  const find = useFindPlugin();
  const { pages } = usePages();
  return items.map((item): Row => {
    if (item.kind === 'approval') {
      return {
        key: `approval:${item.id}`,
        tone: 'attention',
        title: item.session ?? item.sessionId,
        detail: `等你批准：${item.tool}`,
        action: link(paths.session(item.sessionId), '去处理'),
      };
    }
    if (item.kind === 'plugin') {
      const fix = fixLink(item.instance, item, find);
      return {
        key: `plugin:${item.instance}`,
        tone: markerOf(statusOf(item)),
        title: pluginName(item.instance, find),
        detail: statusLine(item, find),
        action: link(fix.to, fix.label),
      };
    }
    const { instance, open } = item;
    const page =
      typeof open === 'object' ? pages?.find(p => p.instance === instance && p.key === open.page) : undefined;
    const to = page && pageAddress(page);
    return {
      key: `notice:${instance}:${item.id}`,
      tone: item.level === 'error' ? 'error' : 'attention',
      title: item.title,
      detail: [named && pluginName(instance, find), item.detail].filter(Boolean).join(' · ') || undefined,
      action:
        open === 'config'
          ? link(paths.plugin(instance, 'config'), '去配置')
          : page && to
            ? link(to, `打开${page.title}`)
            : undefined,
    };
  });
}

/** named 时说明里带上提示来自哪个插件 */
export function AttentionList({ items, named = true }: { items: readonly AttentionItem[]; named?: boolean }) {
  return <Rows rows={useRows(items, named)} />;
}

/** 首页（手机上是第一层顶部）的摘要：最多五条，标题写总数，「全部」链到运行状况；空了又没出错时整条不出现 */
export function AttentionSummary() {
  const { items, error, retry } = useAttention();
  const host = useHost();
  const count = items?.length ?? 0;
  if (count === 0 && !error) return null;
  return (
    <section className="attention-summary" aria-label="需要处理">
      <div className="attention-summary-head">
        <h2 className="section-heading">{count > 0 ? `需要处理 · ${count}` : '需要处理'}</h2>
        {count > 0 && (
          <ButtonLink to={paths.health} variant="text">
            全部
          </ButtonLink>
        )}
      </div>
      {items && count > 0 && <AttentionList items={items.slice(0, SUMMARY_LIMIT)} />}
      {error && (
        <FetchError what="「需要处理」" error={error} retry={retry} stale={items !== undefined} inline source={host} />
      )}
    </section>
  );
}
