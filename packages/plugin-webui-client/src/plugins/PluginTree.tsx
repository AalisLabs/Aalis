import { DEFAULT_SUBSYSTEM_METADATA } from '@aalis/api-webui';
import { Store } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { Button } from '../components/Button';
import { List, ListItem } from '../components/List';
import { Panel } from '../components/Panel';
import { Toggle } from '../components/Toggle';
import { instanceName } from '../pages/registry';
import { paths } from '../routes';
import { Left } from '../shell/Shell';
import { labelOf, type PluginRow, usePlugins } from './list';
import { hasProblem, markerOf, statusOf } from './status';
import './PluginTree.css';

// 插件区的左栏：顶上是市场与「只看有问题的」，下面是已安装的实例树，按子系统分组到插件、再到实例。
// 组名与顺序取 api-webui 的子系统目录，不认识的按原样排在后面，没声明的归「其他」。正常运行的行不写状态

const SUBSYSTEMS = new Map(DEFAULT_SUBSYSTEM_METADATA.map(entry => [entry.id, entry]));

/** 一个插件：主实例（没有时是第一个实例）与其余实例 */
interface PluginItem {
  main: PluginRow;
  others: PluginRow[];
}

interface PluginGroup {
  key: string;
  label: string;
  items: PluginItem[];
}

/** 排序键：目录里的按目录的顺序，目录外的按名字排在后面，没声明的在最后 */
const rank = (subsystem: string | undefined): [number, number, string] => {
  if (subsystem === undefined) return [2, 0, ''];
  const known = SUBSYSTEMS.get(subsystem);
  return known ? [0, known.order, ''] : [1, 0, subsystem];
};

function groupsOf(rows: readonly PluginRow[]): PluginGroup[] {
  const byName = new Map<string, PluginRow[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
  const groups = new Map<string | undefined, PluginItem[]>();
  for (const instances of byName.values()) {
    const main = instances.find(row => row.instanceId === row.name) ?? instances[0];
    const others = instances.filter(row => row !== main).sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    groups.set(main.subsystem, [...(groups.get(main.subsystem) ?? []), { main, others }]);
  }
  return [...groups]
    .sort(([a], [b]) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
    })
    .map(([subsystem, items]) => ({
      key: subsystem ?? '',
      label: subsystem === undefined ? '其他' : (SUBSYSTEMS.get(subsystem)?.label ?? subsystem),
      items: items.sort((a, b) => labelOf(a.main).localeCompare(labelOf(b.main))),
    }));
}

/** 只看有问题的：留下自己或其余实例有问题的插件，其余实例只留有问题的 */
function problemsOf(groups: PluginGroup[]): PluginGroup[] {
  return groups.flatMap(group => {
    const items = group.items.flatMap(({ main, others }) => {
      const failing = others.filter(hasProblem);
      return hasProblem(main) || failing.length > 0 ? [{ main, others: failing }] : [];
    });
    return items.length > 0 ? [{ ...group, items }] : [];
  });
}

export function PluginTree() {
  const { plugins, error, refresh } = usePlugins();
  const [problemsOnly, setProblemsOnly] = useState(false);
  const onMarket = useLocation().pathname === paths.market;
  const all = groupsOf(plugins ?? []);
  const groups = problemsOnly ? problemsOf(all) : all;

  return (
    <Left label="插件">
      <Panel title="插件" back={paths.home}>
        <div className="plugin-tree">
          <List label="市场">
            <ListItem
              to={paths.market}
              current={onMarket}
              title={
                <span className="pinned-title">
                  <Store aria-hidden />
                  市场
                </span>
              }
            />
          </List>
          <div className="plugin-tree-filter">
            <span aria-hidden>只看有问题的</span>
            <Toggle label="只看有问题的" checked={problemsOnly} onChange={setProblemsOnly} />
          </div>
          {error && (
            <p className="plugin-tree-note" role="alert">
              插件列表没取到：{error.message}
              <Button variant="text" onClick={() => void refresh()}>
                重试
              </Button>
            </p>
          )}
          {plugins && groups.length === 0 && (
            <p className="plugin-tree-note">{problemsOnly ? '没有出问题的插件' : '还没有安装插件'}</p>
          )}
          {groups.map(group => (
            <Group key={group.key} group={group} />
          ))}
        </div>
      </Panel>
    </Left>
  );
}

function Group({ group }: { group: PluginGroup }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="plugin-tree-heading">
        {group.label}
      </h3>
      <List label={group.label}>
        {group.items.map(item => (
          <InstanceRow key={item.main.instanceId} row={item.main} title={labelOf(item.main)}>
            {item.others.length > 0 && (
              <List label={`${labelOf(item.main)}的其余实例`}>
                {item.others.map(row => (
                  <InstanceRow key={row.instanceId} row={row} title={instanceName(row.instanceId) ?? row.instanceId} />
                ))}
              </List>
            )}
          </InstanceRow>
        ))}
      </List>
    </section>
  );
}

function InstanceRow({ row, title, children }: { row: PluginRow; title: string; children?: ReactNode }) {
  const { instance } = useParams();
  const status = statusOf(row);
  return (
    <ListItem
      to={paths.plugin(row.instanceId)}
      title={title}
      meta={status.state && status.short}
      marker={markerOf(status)}
      current={instance === row.instanceId}
    >
      {children}
    </ListItem>
  );
}
