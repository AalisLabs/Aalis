import { useState } from 'react';
import { Disclosure } from '../components/Disclosure';
import { tr } from '../language';
import { withInstance } from '../pages/registry';
import { usePluginNames } from '../plugins/list';
import { authorDefault, dependencyOf, type Row, unsetOf } from './field';
import { SettingRow } from './SettingRow';

// 会话设置的一组行，会话的「设置」标签、设置的「会话默认」与房间的「场所设置」共用：composer 与 common 在前，advanced 收进默认
// 折叠的「高级」，按声明它的插件实例分组，组名取插件显示名（后缀实例写「显示名 · 实例名」）。每行写生效值；生效值出自写入的
// 这一层的行有恢复按钮（全局层叫「恢复默认」，值已等于作者默认的不出；其余层「恢复继承」），其余写来源（称呼由调用方按层表
// 给）。全局层自己的各行（设置的「会话默认」选了全局）写作者默认：等于默认标「默认」，不等写「默认：<值>」与「恢复默认」。
// 没有生效值的写声明给的「没设时」，另写此刻实际在用的值

interface SettingRowsProps {
  rows: readonly Row[];
  /** 改动写进的那一层的层名 */
  layer: string;
  /** 行是这一层自己的（value 是这一层写的值），不是一个会话的 */
  own?: boolean;
  /** 来源写成值下面的一句 */
  originOf(source: string): string;
  /** 写一项：给值即写入，null 恢复继承（全局层恢复默认）；没落盘时交回那一句 */
  update(row: Row, value: unknown): Promise<string | undefined>;
}

export function SettingRows({ rows, layer, own = false, originOf, update }: SettingRowsProps) {
  const names = usePluginNames();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const global = layer === 'global';
  // 全局层自己的各行写作者默认，其余写来源
  const authored = own && global;
  /** 生效值出自全局层、已等于作者默认：恢复默认回不到别处 */
  const atDefault = (row: Row) =>
    row.source === 'global' && authorDefault(row.field, row.effective)?.isDefault === true;
  const line = (row: Row) => {
    const fallback = authored ? authorDefault(row.field, row.value) : undefined;
    const reset = global ? tr('resetDefault') : tr('resetInherit');
    return (
      <SettingRow
        key={`${row.plugin}/${row.key}`}
        field={row.field}
        value={row.effective}
        source={fallback?.isDefault ? tr('sourceDefault') : undefined}
        note={!authored && row.source !== undefined && row.source !== layer ? originOf(row.source) : undefined}
        defaultNote={fallback?.isDefault === false ? fallback.note : undefined}
        reset={(authored ? fallback?.isDefault === false : row.source === layer && !atDefault(row)) ? reset : undefined}
        dependency={dependencyOf(rows, row)}
        unset={unsetOf(row, authored)}
        save={value => update(row, value)}
      />
    );
  };
  const advanced = rows.filter(row => row.prominence === 'advanced');
  const groups = new Map<string, Row[]>();
  for (const row of advanced) groups.set(row.plugin, [...(groups.get(row.plugin) ?? []), row]);
  const groupLabel = (plugin: string) => {
    const named = names.instances.get(plugin);
    return named ? withInstance(named.label, plugin) : plugin;
  };
  return (
    <>
      {rows.filter(row => row.prominence !== 'advanced').map(line)}
      {advanced.length > 0 && (
        <div className="settings-advanced">
          <Disclosure expanded={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)}>
            {tr('advanced')}
          </Disclosure>
          {advancedOpen && names.error && (
            <p className="settings-advanced-note" role="alert">
              {tr('pluginNamesFailedGroup', { error: names.error.message })}
            </p>
          )}
          {advancedOpen &&
            [...groups].map(([plugin, group]) => (
              <section key={plugin} aria-label={groupLabel(plugin)}>
                <h3 className="settings-group">{groupLabel(plugin)}</h3>
                {group.map(line)}
              </section>
            ))}
        </div>
      )}
    </>
  );
}
