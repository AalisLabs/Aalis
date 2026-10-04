import type { AttentionItem } from '@aalis/api-webui';
import { Button } from '../components/Button';
import { ButtonLink } from '../components/ButtonLink';
import { MARKERS } from '../components/List';
import { pageAddress, usePages, withInstance } from '../pages/registry';
import { usePluginNames } from '../plugins/list';
import { statusOf } from '../plugins/status';
import { paths } from '../routes';
import { useAttention } from './attention';
import './AttentionList.css';

/** 首页摘要最多列这么多条 */
const SUMMARY_LIMIT = 5;

interface Row {
  key: string;
  tone: 'attention' | 'error';
  title: string;
  detail?: string;
  action?: { to: string; label: string };
}

/** 每项一行：审批进它的会话，插件故障进插件详情，提示的跳转由宿主推出（去配置、打开它指向的页面） */
function useRows(items: readonly AttentionItem[], named: boolean): Row[] {
  const { instances } = usePluginNames();
  const { pages } = usePages();
  const pluginOf = (instance: string) => {
    const label = instances.get(instance)?.label;
    return label === undefined ? instance : withInstance(label, instance);
  };
  return items.map((item): Row => {
    if (item.kind === 'approval') {
      return {
        key: `approval:${item.id}`,
        tone: 'attention',
        title: item.session ?? item.sessionId,
        detail: `等你批准：${item.tool}`,
        action: { to: paths.session(item.sessionId), label: '去处理' },
      };
    }
    if (item.kind === 'plugin') {
      const status = statusOf(item);
      return {
        key: `plugin:${item.instance}`,
        tone: item.state === 'error' ? 'error' : 'attention',
        title: pluginOf(item.instance),
        detail: status.reason ? `${status.short}：${status.reason}` : status.short,
        action: { to: paths.plugin(item.instance), label: '去处理' },
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
      detail: [named && pluginOf(instance), item.detail].filter(Boolean).join(' · ') || undefined,
      action:
        open === 'config'
          ? { to: paths.plugin(instance, 'config'), label: '去配置' }
          : page && to
            ? { to, label: `打开${page.title}` }
            : undefined,
    };
  });
}

/** named 时说明里带上提示来自哪个插件 */
export function AttentionList({ items, named = true }: { items: readonly AttentionItem[]; named?: boolean }) {
  return (
    <ul className="attention-list">
      {useRows(items, named).map(row => (
        <li key={row.key} className="attention-row" data-marker={row.tone}>
          <span className="list-item-marker" aria-hidden />
          <span className="visually-hidden">{MARKERS[row.tone]}</span>
          <span className="attention-text">
            <span className="attention-title">{row.title}</span>
            {row.detail && <span className="attention-detail">{row.detail}</span>}
          </span>
          {row.action && <ButtonLink to={row.action.to}>{row.action.label}</ButtonLink>}
        </li>
      ))}
    </ul>
  );
}

/** 没取到或重取失败：原因与「重试」。stale 时旧的还显示着，写「没刷新成功」 */
export function FetchError({ error, retry, stale }: { error: Error; retry(): void; stale: boolean }) {
  return (
    <p className="fetch-error" role="alert">
      {`${stale ? '没刷新成功' : '没取到'}：${error.message}`}
      <Button variant="text" onClick={retry}>
        重试
      </Button>
    </p>
  );
}

/** 首页（手机上是第一层顶部）的摘要：最多五条，标题写总数，「全部」链到运行状况；空了又没出错时整条不出现 */
export function AttentionSummary() {
  const { items, error, retry } = useAttention();
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
      {error && <FetchError error={error} retry={retry} stale={items !== undefined} />}
    </section>
  );
}
