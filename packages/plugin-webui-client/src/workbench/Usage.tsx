import type { TokenUsageBreakdown } from '@aalis/api-agent';
import { Fragment, useState } from 'react';
import { Disclosure } from '../components/Disclosure';
import { percent, tokens } from '../format';
import { type PluginNames, usePluginNames } from '../plugins';
import type { UsageItem } from './live-session';
import './Usage.css';

// 上下文用量：会话头部一个百分比（上下文已用占窗口的比例），达到压缩线换警告色；点开是拆分表。
// 拆分表的行是上下文窗口、已用、为回复预留与各分项，为 0 的不显示；「其余系统提示」按注入者的插件实例合并到插件，
// 行名取插件显示名，对不上的归「其他」

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
function byPlugin(usage: UsageItem, names: PluginNames): Array<{ label: string; tokens: number }> {
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

export function UsageTable({ usage }: { usage: UsageItem }) {
  const names = usePluginNames();
  const [expanded, setExpanded] = useState(false);
  // 模型的上下文窗口不知道时没有占比
  const share = (count: number) =>
    usage.contextWindow > 0 ? `${((count / usage.contextWindow) * 100).toFixed(1)}%` : '';
  const known = Object.entries(PARTS).map(([key, label]) => ({ label, tokens: usage.breakdown[key] ?? 0 }));
  const unknown = Object.entries(usage.breakdown)
    .filter(([key]) => !(key in PARTS) && !NOT_PARTS.has(key))
    .map(([key, count]) => ({ label: key, tokens: count }));
  const systemOther = usage.breakdown.systemOther ?? 0;
  const reserved = usage.breakdown.reservedForReply ?? usage.maxTokens;
  const row = (label: string, count: number, nested = false) =>
    count > 0 && (
      <tr key={label} data-nested={nested || undefined}>
        <th scope="row">{label}</th>
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
      <table className="usage-table" aria-label="上下文用量">
        <tbody>
          {usage.contextWindow > 0 && (
            <tr>
              <th scope="row">上下文窗口</th>
              <td>{tokens(usage.contextWindow)}</td>
              <td />
            </tr>
          )}
          {row('已用', usage.used)}
          {[...known, ...unknown].map(part => row(part.label, part.tokens))}
          {systemOther > 0 && (
            <Fragment key="systemOther">
              <tr>
                <th scope="row">
                  <Disclosure expanded={expanded} onToggle={() => setExpanded(!expanded)}>
                    其余系统提示
                  </Disclosure>
                </th>
                <td>{tokens(systemOther)}</td>
                <td>{share(systemOther)}</td>
              </tr>
              {expanded && byPlugin(usage, names).map(plugin => row(plugin.label, plugin.tokens, true))}
            </Fragment>
          )}
          {row('为回复预留', reserved)}
        </tbody>
      </table>
      {usage.compressAt !== undefined && <p className="usage-note">到 {percent(usage.compressAt)} 自动压缩</p>}
    </div>
  );
}
