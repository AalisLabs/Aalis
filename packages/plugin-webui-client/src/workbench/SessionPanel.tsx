import type { SettingRow as Row } from '@aalis/api-session-protocol';
import { Circle, CircleCheck, CircleDot } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/Button';
import { Disclosure } from '../components/Disclosure';
import { Panel } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { useToast } from '../components/Toast';
import { useSessionClient } from '../connection';
import { usePluginNames } from '../plugins';
import { paths, type SessionTab } from '../routes';
import { SettingRow } from '../settings/SettingRow';
import type { useSessionSettings } from '../settings/session-settings';
import { Aside, usePhone } from '../shell/Shell';
import type { PlanItem, UsageItem } from './live-session';
import { UsageTable } from './Usage';
import './SessionPanel.css';

// 会话的右侧面板：计划（有计划条目才有）、设置、用量（有用量数据才有；手机上从会话头的百分比点开，从底部弹出）。
// 标签由地址决定，地址没写或写的标签现在没有时停在第一个

const TAB_TITLES: Record<SessionTab, string> = { plan: '计划', settings: '设置', usage: '用量' };

interface SessionPanelProps {
  sessionId: string;
  tab?: SessionTab;
  plan?: PlanItem;
  usage?: UsageItem;
  settings: ReturnType<typeof useSessionSettings>;
}

/** 面板现有的标签：计划与用量按数据出现 */
export function panelTabs(plan: PlanItem | undefined, usage: UsageItem | undefined, phone: boolean): SessionTab[] {
  return [
    ...(plan && plan.entries.length > 0 ? (['plan'] as const) : []),
    'settings' as const,
    ...(usage && !phone ? (['usage'] as const) : []),
  ];
}

export function SessionPanel({ sessionId, tab, plan, usage, settings }: SessionPanelProps) {
  const phone = usePhone();
  const navigate = useNavigate();
  const tabs = panelTabs(plan, usage, phone);
  const current = tab !== undefined && tabs.includes(tab) ? tab : tabs[0];
  const body = (
    <Tabs
      label="会话面板"
      items={tabs.map(key => ({ key, title: TAB_TITLES[key] }))}
      value={current}
      onChange={key => navigate(paths.session(sessionId, key as SessionTab), { replace: true })}
    >
      {current === 'plan' && plan && <PlanTab sessionId={sessionId} plan={plan} />}
      {current === 'settings' && <SettingsTab settings={settings} />}
      {current === 'usage' && usage && <UsageTable usage={usage} />}
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
            .catch((err: Error) => toast({ kind: 'error', text: `清空失败：${err.message}` }))
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
