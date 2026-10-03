import type { TokenUsageBreakdown } from '@aalis/api-agent';
import { type CSSProperties, Fragment, useState } from 'react';
import { Disclosure } from '../components/Disclosure';
import { percent, tokens } from '../format';
import { usePluginNames } from '../plugins/list';
import type { UsageItem } from './live-session';
import './Usage.css';

// 上下文用量：会话头部一个百分比（上下文已用占窗口的比例），达到压缩线换警告色；点开是拆分表。
// 拆分表的行是上下文窗口、已用、各分项、为回复预留与剩余，为 0 的不显示；「其余系统提示」按注入者的插件实例合并到插件，
// 行名取插件显示名，对不上的归「其他」。表上方一条按窗口画的堆叠进度条：分项按占用从大到小取图表色，表里每行前一个
// 同色的点作图例，压缩线标在条上；不知道窗口时没有这条，也没有剩余

/** 各分项的行名；分项之外的键原样显示 */
const PARTS = {
  history: '历史消息',
  toolResults: '工具结果',
  toolDefs: '工具定义',
  persona: '人设',
  memorySummary: '对话摘要',
  memoryVector: '向量记忆',
  skills: '技能',
  platform: '平台提示',
  subtask: '子任务',
} satisfies Partial<Record<keyof TokenUsageBreakdown, string>>;

/** 不单列的键：系统提示的合计（各分项加起来就是它）与另起一行的两项 */
const NOT_PARTS = new Set<string>(['system', 'systemOther', 'reservedForReply'] satisfies Array<
  keyof TokenUsageBreakdown
>);

/** 图表色有这么多种；占用排在后面的分项与为回复预留一样用弱化色 */
const CHART_COLORS = 6;

const reachesCompressAt = (usage: UsageItem) => usage.compressAt !== undefined && usage.usageRatio >= usage.compressAt;

export function UsageMeter({ usage, onOpen }: { usage: UsageItem; onOpen(): void }) {
  const ratio = percent(usage.usageRatio);
  return (
    <button
      type="button"
      className="usage-meter"
      aria-label={`上下文已用 ${ratio}`}
      title={
        usage.compressAt === undefined
          ? `上下文已用 ${ratio}`
          : `上下文已用 ${ratio}，到 ${percent(usage.compressAt)} 自动压缩`
      }
      data-tone={reachesCompressAt(usage) ? 'warning' : undefined}
      onClick={onOpen}
    >
      {ratio}
    </button>
  );
}

/** 其余系统提示按插件合并：注入者的键是「插件实例 id/局部 id」，同一插件的几个实例合在一起 */
function byPlugin(
  usage: UsageItem,
  names: ReturnType<typeof usePluginNames>,
): Array<{ label: string; tokens: number }> {
  const merged = new Map<string, { label: string; tokens: number }>();
  let others = usage.breakdown.systemOther ?? 0;
  for (const [key, count] of Object.entries(usage.injectors ?? {})) {
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
  return others > 0 ? [...rows, { label: '其他', tokens: others }] : rows;
}

interface Part {
  label: string;
  tokens: number;
  /** 图例与进度条上的颜色 */
  swatch: string;
  /** 其余系统提示：可以展开到插件 */
  system?: true;
}

const Swatch = ({ swatch }: { swatch: string }) => <span className="usage-swatch" data-swatch={swatch} aria-hidden />;

export function UsageTable({ usage }: { usage: UsageItem }) {
  const names = usePluginNames();
  const [expanded, setExpanded] = useState(false);
  const { contextWindow } = usage;
  // 模型的上下文窗口不知道时没有占比
  const share = (count: number) => (contextWindow > 0 ? `${((count / contextWindow) * 100).toFixed(1)}%` : '');
  const systemOther = usage.breakdown.systemOther ?? 0;
  const reserved = usage.breakdown.reservedForReply ?? usage.maxTokens;
  const remaining = Math.max(0, contextWindow - usage.used - reserved);
  const parts: Part[] = [
    ...Object.entries(PARTS).map(([key, label]) => ({ label, tokens: usage.breakdown[key] ?? 0 })),
    ...Object.entries(usage.breakdown)
      .filter(([key]) => !(key in PARTS) && !NOT_PARTS.has(key))
      .map(([key, count]) => ({ label: key, tokens: count })),
    { label: '其余系统提示', tokens: systemOther, system: true as const },
  ]
    .filter(part => part.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((part, rank) => ({ ...part, swatch: rank < CHART_COLORS ? String(rank + 1) : 'other' }));
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
          插件的显示名没取到（{names.error.message}），按插件实例 id 显示
        </p>
      )}
      {contextWindow > 0 && (
        <div className="usage-bar" aria-hidden>
          {[...parts, { label: '为回复预留', tokens: reserved, swatch: 'reserved' }].map(part => (
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
      <table className="usage-table" aria-label="上下文用量">
        <tbody>
          {contextWindow > 0 && (
            <tr>
              <th scope="row">上下文窗口</th>
              <td>{tokens(contextWindow)}</td>
              <td />
            </tr>
          )}
          {row('已用', usage.used)}
          {parts.map(part =>
            part.system ? (
              <Fragment key={part.label}>
                <tr>
                  <th scope="row">
                    <Swatch swatch={part.swatch} />
                    <Disclosure expanded={expanded} onToggle={() => setExpanded(!expanded)}>
                      {part.label}
                    </Disclosure>
                  </th>
                  <td>{tokens(part.tokens)}</td>
                  <td>{share(part.tokens)}</td>
                </tr>
                {expanded && byPlugin(usage, names).map(plugin => row(plugin.label, plugin.tokens, undefined, true))}
              </Fragment>
            ) : (
              row(part.label, part.tokens, part.swatch)
            ),
          )}
          {row('为回复预留', reserved, 'reserved')}
          {row('剩余', remaining, 'free')}
        </tbody>
      </table>
      {usage.compressAt !== undefined && <p className="usage-note">到 {percent(usage.compressAt)} 自动压缩</p>}
    </div>
  );
}
