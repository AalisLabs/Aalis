import type { SettingRow as Row } from '@aalis/api-session-protocol';
import { useState } from 'react';
import { Disclosure } from '../components/Disclosure';
import { usePluginNames } from '../plugins/list';
import { dependencyOf, effectiveOf, formatValue, unsetOf, valueKey } from './field';
import { SettingRow } from './SettingRow';

// 会话设置的一组行，会话的「设置」标签、设置的「会话默认」与房间的「场所设置」共用：composer 与 common 在前，advanced 收进默认
// 折叠的「高级」，按登记它的插件分组，组名取插件显示名。每行写生效值与来源（来源的称呼由调用方按层表给），生效值出自写入的
// 这一层的有「恢复继承」。全局默认层由服务偏好承担的项（「模型」）没设时写服务实际用的那一个，偏好指向的已不在时标出

interface SettingRowsProps {
  rows: readonly Row[];
  /** 改动写进的那一层的层名：生效值出自它的行有「恢复继承」 */
  layer: string;
  /** 来源写成徽标时的称呼 */
  sourceOf?(name: string): string | undefined;
  /** 来源写成值下面的一句时的称呼 */
  originOf?(name: string): string | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/** 生效值出自全局默认、服务实际用的却是另一个：偏好指向的已不在 */
function dangling(row: Row): string | undefined {
  if (row.resolved === undefined || row.effective === undefined) return undefined;
  if (valueKey(row.field, row.effective) === valueKey(row.field, row.resolved)) return undefined;
  return `所选模型不在，正在用${formatValue(row.field, row.resolved)}`;
}

export function SettingRows({ rows, layer, sourceOf, originOf, update }: SettingRowsProps) {
  const names = usePluginNames();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const line = (row: Row) => (
    <SettingRow
      key={row.key}
      field={row.field}
      value={effectiveOf(row)}
      source={row.source && sourceOf?.(row.source)}
      origin={row.source && originOf?.(row.source)}
      note={dangling(row)}
      reset={row.source === layer ? '恢复继承' : undefined}
      dependency={dependencyOf(rows, row)}
      unset={unsetOf(row)}
      save={value => update(row.key, value)}
    />
  );
  const advanced = rows.filter(row => row.prominence === 'advanced');
  const groups = new Map<string, Row[]>();
  for (const row of advanced) {
    const label = names.instances.get(row.plugin)?.label ?? row.plugin;
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  return (
    <>
      {rows.filter(row => row.prominence !== 'advanced').map(line)}
      {advanced.length > 0 && (
        <div className="settings-advanced">
          <Disclosure expanded={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)}>
            高级
          </Disclosure>
          {advancedOpen && names.error && (
            <p className="settings-advanced-note" role="alert">
              插件的显示名没取到（{names.error.message}），按插件实例 id 分组
            </p>
          )}
          {advancedOpen &&
            [...groups].map(([label, group]) => (
              <section key={label} aria-label={label}>
                <h3 className="settings-group">{label}</h3>
                {group.map(line)}
              </section>
            ))}
        </div>
      )}
    </>
  );
}
