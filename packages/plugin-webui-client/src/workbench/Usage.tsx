import { type CSSProperties, Fragment, useState } from 'react';
import { Disclosure } from '../components/Disclosure';
import { percent, tokens } from '../format';
import { tr } from '../language';
import { usePluginNames } from '../plugins/list';
import type { SessionSummary } from '../protocol/session-client';
import type { UsageItem } from './live-session';
import './Usage.css';

// 上下文用量：会话头部一个百分比（上下文已用占窗口的比例），达到压缩线换警告色；点开是拆分表。
// 拆分表的行是上下文窗口、已用、条目里的各分项（行名与次序照条目）、为回复预留与剩余，为 0 的不显示；带注入者明细的
// 分项可以展开，按注入者的插件实例合并到插件，行名取插件显示名，对不上的归「其他」。表上方一条按窗口画的堆叠进度条：
// 分项按占用从大到小堆叠、取图表色，表里每行前一个同色的点作图例，压缩线标在条上；不知道窗口时没有这条，也没有剩余。
// 表下另写会话累计的输入与输出 token（会话树上的数，有子会话时含子会话）

/** 图表色有这么多种；占用排在后面的分项与为回复预留一样用弱化色 */
const CHART_COLORS = 6;

const reachesCompressAt = (usage: UsageItem) => usage.compressAt !== undefined && usage.usageRatio >= usage.compressAt;

export function UsageMeter({ usage, onOpen }: { usage: UsageItem; onOpen(): void }) {
  const ratio = percent(usage.usageRatio);
  return (
    <button
      type="button"
      className="header-meter"
      aria-label={tr('contextUsed', { ratio })}
      title={
        usage.compressAt === undefined
          ? tr('contextUsed', { ratio })
          : tr('contextUsedCompress', { ratio, at: percent(usage.compressAt) })
      }
      data-tone={reachesCompressAt(usage) ? 'warning' : undefined}
      onClick={onOpen}
    >
      {ratio}
    </button>
  );
}

type UsagePart = UsageItem['parts'][number];

/** 注入者明细按插件合并：注入者的键是「插件实例 id/局部 id」，同一插件的几个实例合在一起 */
function byPlugin(part: UsagePart, names: ReturnType<typeof usePluginNames>): Array<{ label: string; tokens: number }> {
  const merged = new Map<string, { label: string; tokens: number }>();
  let others = part.tokens;
  for (const [key, count] of Object.entries(part.injectors ?? {})) {
    const instance = key.slice(0, key.lastIndexOf('/'));
    const plugin = names.instances.get(instance);
    const label = plugin?.label ?? (names.error ? instance : undefined);
    if (label === undefined) continue;
    const group = plugin?.name ?? instance;
    const entry = merged.get(group) ?? { label, tokens: 0 };
    entry.tokens += count;
    merged.set(group, entry);
    others -= count;
  }
  const rows = [...merged.values()].sort((a, b) => b.tokens - a.tokens);
  return others > 0 ? [...rows, { label: tr('other'), tokens: others }] : rows;
}

const Swatch = ({ swatch }: { swatch: string }) => <span className="usage-swatch" data-swatch={swatch} aria-hidden />;

export function UsageTable({ usage, session }: { usage: UsageItem; session?: SessionSummary }) {
  const names = usePluginNames();
  const [expanded, setExpanded] = useState<string>();
  const { contextWindow, maxTokens: reserved } = usage;
  // 模型的上下文窗口不知道时没有占比
  const share = (count: number) => (contextWindow > 0 ? `${((count / contextWindow) * 100).toFixed(1)}%` : '');
  const remaining = Math.max(0, contextWindow - usage.used - reserved);
  const parts = usage.parts.filter(part => part.tokens > 0);
  const bySize = [...parts].sort((a, b) => b.tokens - a.tokens);
  /** 图例与进度条上的颜色：按占用从大到小取 */
  const swatchOf = (part: UsagePart) => {
    const rank = bySize.indexOf(part);
    return rank < CHART_COLORS ? String(rank + 1) : 'other';
  };
  const row = (label: string, count: number, swatch?: string, nested = false) =>
    count > 0 && (
      <tr key={label} data-nested={nested || undefined}>
        <th scope="row">
          {swatch && <Swatch swatch={swatch} />}
          {label}
        </th>
        <td>{tokens(count)}</td>
        <td>{share(count)}</td>
      </tr>
    );

  return (
    <div className="usage">
      {names.error && (
        <p className="usage-note" role="alert">
          {tr('usageNamesFailed', { error: names.error.message })}
        </p>
      )}
      {contextWindow > 0 && (
        <div className="usage-bar" aria-hidden>
          {[
            ...bySize.map(part => ({ label: part.label, tokens: part.tokens, swatch: swatchOf(part) })),
            { label: tr('usageReserved'), tokens: reserved, swatch: 'reserved' },
          ].map(part => (
            <span
              key={part.label}
              data-swatch={part.swatch}
              style={{ '--share': `${(part.tokens * 100) / contextWindow}%` } as CSSProperties}
            />
          ))}
          {usage.compressAt !== undefined && (
            <span data-mark style={{ '--at': percent(usage.compressAt) } as CSSProperties} />
          )}
        </div>
      )}
      <table className="usage-table" aria-label={tr('contextUsage')}>
        <tbody>
          {contextWindow > 0 && (
            <tr>
              <th scope="row">{tr('contextWindow')}</th>
              <td>{tokens(contextWindow)}</td>
              <td />
            </tr>
          )}
          {row(tr('usageUsed'), usage.used)}
          {parts.map(part =>
            part.injectors ? (
              <Fragment key={part.label}>
                <tr>
                  <th scope="row">
                    <Swatch swatch={swatchOf(part)} />
                    <Disclosure
                      expanded={expanded === part.label}
                      onToggle={() => setExpanded(expanded === part.label ? undefined : part.label)}
                    >
                      {part.label}
                    </Disclosure>
                  </th>
                  <td>{tokens(part.tokens)}</td>
                  <td>{share(part.tokens)}</td>
                </tr>
                {expanded === part.label &&
                  byPlugin(part, names).map(plugin => row(plugin.label, plugin.tokens, undefined, true))}
              </Fragment>
            ) : (
              row(part.label, part.tokens, swatchOf(part))
            ),
          )}
          {row(tr('usageReserved'), reserved, 'reserved')}
          {row(tr('usageRemaining'), remaining, 'free')}
        </tbody>
      </table>
      {usage.compressAt !== undefined && (
        <p className="usage-note">{tr('usageCompressAt', { at: percent(usage.compressAt) })}</p>
      )}
      {session?.tokens && (
        <p className="usage-total">
          {tr(session.childCount > 0 ? 'usageTotalWithChildren' : 'usageTotal', {
            input: tokens(session.tokens.input),
            output: tokens(session.tokens.output),
          })}
        </p>
      )}
    </div>
  );
}
