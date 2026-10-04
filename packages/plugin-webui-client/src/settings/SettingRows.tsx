import type { SettingRow as Row } from '@aalis/api-session-protocol';
import { useState } from 'react';
import { Disclosure } from '../components/Disclosure';
import { usePluginNames } from '../plugins/list';
import { dependencyOf, effectiveOf } from './field';
import { SettingRow } from './SettingRow';

// 会话设置的一组行，会话的「设置」标签与设置的「会话默认」共用：composer 与 common 在前，advanced 收进默认折叠的「高级」，
// 按登记它的插件分组，组名取插件显示名。每行写生效值与来源，被这一层覆盖的有「恢复继承」

const SOURCES: Record<NonNullable<Row['source']>, string> = {
  session: '本会话',
  parent: '父会话',
  audience: '受众',
  platform: '平台档',
  defaults: '默认',
};

export function SettingRows({
  rows,
  update,
}: {
  rows: readonly Row[];
  update(key: string, value: unknown): Promise<void>;
}) {
  const names = usePluginNames();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const line = (row: Row) => (
    <SettingRow
      key={row.key}
      field={row.field}
      value={effectiveOf(row)}
      source={row.source && SOURCES[row.source]}
      reset={row.value === undefined ? undefined : '恢复继承'}
      dependency={dependencyOf(rows, row)}
      unset={row.unset}
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
