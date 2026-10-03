import type { SettingRow as Row } from '@aalis/api-session-protocol';
import type { HostPanelTab, PageRef } from '@aalis/api-webui';
import { Circle, CircleAlert, CircleCheck, CircleDot, Plus, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/Button';
import { Disclosure } from '../components/Disclosure';
import { IconButton } from '../components/IconButton';
import { Menu } from '../components/Menu';
import { Panel } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { useToast } from '../components/Toast';
import { useSessionClient } from '../connection';
import { PageContent } from '../pages/PageContent';
import { PageScope, usePageVersion } from '../pages/scope';
import { usePluginNames } from '../plugins';
import { paths } from '../routes';
import { SettingRow } from '../settings/SettingRow';
import type { useSessionSettings } from '../settings/session-settings';
import { Aside, usePhone } from '../shell/Shell';
import type { PlanItem, UsageItem } from './live-session';
import type { SessionTabs } from './panel-tabs';
import { UsageTable } from './Usage';
import './SessionPanel.css';

// 会话的右侧面板：宿主的标签（计划、设置、用量）与插件的会话面板在一个标签栏里，按 owner 排的顺序（合成见 panel-tabs.ts）。
// 当前标签旁有关闭按钮，关掉的与还没打开过的在标签栏末尾的「+」里；插件面板的标签就是它的标题，手动刷新放在标签栏里。
// 标签由地址决定，地址没写或写的标签不在标签栏里时停在第一个

interface SessionPanelProps {
  sessionId: string;
  tabs: SessionTabs;
  /** 地址上的宿主标签 */
  tab?: HostPanelTab;
  /** 地址上的插件面板 */
  panel?: PageRef;
  plan?: PlanItem;
  usage?: UsageItem;
  settings: ReturnType<typeof useSessionSettings>;
}

export function SessionPanel({ sessionId, tabs, tab, panel, plan, usage, settings }: SessionPanelProps) {
  const phone = usePhone();
  const [version, refresh] = usePageVersion();
  const addressed = panel ? paths.page(panel) : tab;
  const current = tabs.bar.find(item => item.key === addressed) ?? tabs.bar[0];
  const host = current && 'host' in current.ref ? current.ref.host : undefined;

  const body = (
    <Tabs
      label="会话面板"
      items={tabs.bar}
      value={current?.key ?? ''}
      onChange={key => tabs.show(tabs.bar.find(item => item.key === key)!.ref, { replace: true })}
      onClose={current && (() => tabs.close(current.ref))}
      trailing={
        <>
          {current?.page && <IconButton icon={RotateCw} label="刷新" onClick={refresh} />}
          {tabs.error && (
            <IconButton
              icon={CircleAlert}
              label={`面板的标签没取全：${tabs.error.message}（点按重试）`}
              onClick={tabs.retry}
            />
          )}
          {tabs.add.length > 0 && (
            <Menu
              icon={Plus}
              label="打开标签"
              items={tabs.add.map(item => ({
                id: item.key,
                label: item.title,
                onSelect: () => tabs.show(item.ref, { replace: true }),
              }))}
            />
          )}
        </>
      }
    >
      {host === 'plan' && plan && <PlanTab sessionId={sessionId} plan={plan} />}
      {host === 'settings' && <SettingsTab settings={settings} />}
      {host === 'usage' && usage && <UsageTable usage={usage} />}
      {current?.page && (
        <PageScope key={current.key} page={current.page} sessionId={sessionId} version={version}>
          <PageContent page={current.page} />
        </PageScope>
      )}
    </Tabs>
  );
  return (
    <Aside label="会话面板">
      {phone ? (
        <Panel title="会话面板" back={paths.session(sessionId)}>
          {body}
        </Panel>
      ) : (
        body
      )}
    </Aside>
  );
}

const PLAN_STATUS = {
  'not-started': { icon: Circle, text: '未开始' },
  'in-progress': { icon: CircleDot, text: '进行中' },
  completed: { icon: CircleCheck, text: '已完成' },
} as const;

function PlanTab({ sessionId, plan }: { sessionId: string; plan: PlanItem }) {
  const client = useSessionClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="session-panel-section">
      <ul className="plan" aria-label="计划">
        {plan.entries.map(entry => {
          const { icon: Icon, text } = PLAN_STATUS[entry.status];
          return (
            <li key={entry.id} data-status={entry.status}>
              <Icon aria-hidden />
              <span className="plan-title">{entry.title}</span>
              <span className="visually-hidden">{text}</span>
            </li>
          );
        })}
      </ul>
      <Button
        variant="text"
        size="sm"
        busy={busy}
        onClick={() => {
          setBusy(true);
          client
            .request('plan/clear', { sessionId })
            .catch((err: Error) => toast({ kind: 'danger', text: `清空失败：${err.message}` }))
            .finally(() => setBusy(false));
        }}
      >
        清空
      </Button>
    </div>
  );
}

function SettingsTab({ settings }: { settings: SessionPanelProps['settings'] }) {
  const names = usePluginNames();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { rows, error, update } = settings;
  if (error) {
    return (
      <p className="session-panel-note" role="alert">
        设置没取到：{error.message}
      </p>
    );
  }
  if (!rows) return null;
  if (rows.length === 0) return <p className="session-panel-note">这个会话没有可以设置的项</p>;

  const save = (row: Row) => (value: unknown) => update(row.key, value);
  const advanced = rows.filter(row => row.prominence === 'advanced');
  const groups = new Map<string, Row[]>();
  for (const row of advanced) {
    const label = names.instances.get(row.plugin)?.label ?? row.plugin;
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  return (
    <div className="session-panel-section">
      <p className="session-panel-note">改动从下一轮起生效</p>
      {rows
        .filter(row => row.prominence !== 'advanced')
        .map(row => (
          <SettingRow key={row.key} row={row} save={save(row)} />
        ))}
      {advanced.length > 0 && (
        <div className="settings-advanced">
          <Disclosure expanded={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)}>
            高级
          </Disclosure>
          {advancedOpen && names.error && (
            <p className="session-panel-note" role="alert">
              插件的显示名没取到（{names.error.message}），按插件实例 id 分组
            </p>
          )}
          {advancedOpen &&
            [...groups].map(([label, group]) => (
              <section key={label} aria-label={label}>
                <h3 className="settings-group">{label}</h3>
                {group.map(row => (
                  <SettingRow key={row.key} row={row} save={save(row)} />
                ))}
              </section>
            ))}
        </div>
      )}
    </div>
  );
}
