import type { BackgroundTask, SessionSummary } from '@aalis/api-session-protocol';
import type { HostPanelTab, PageRef } from '@aalis/api-webui';
import { Circle, CircleAlert, CircleCheck, CircleDot, Plus, RotateCw } from 'lucide-react';
import { useReducer, useState } from 'react';
import { BackgroundTab } from '../background/Background';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { Menu } from '../components/Menu';
import { Panel } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { useToast } from '../components/Toast';
import { useSessionClient } from '../connection';
import { FramePage } from '../frame/FramePage';
import { PageContent } from '../pages/PageContent';
import { PageGone } from '../pages/PluginPage';
import { refOf, sameRef, usePages } from '../pages/registry';
import { PageScope } from '../pages/scope';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import { paths } from '../routes';
import { SettingRows } from '../settings/SettingRows';
import type { useSettingRows } from '../settings/setting-rows';
import { SessionsFetchError } from '../shell/SessionGate';
import { Aside, usePhone } from '../shell/Shell';
import type { PlanItem, UsageItem } from './live-session';
import type { SessionTabs } from './panel-tabs';
import { UsageTable } from './Usage';
import './SessionPanel.css';

// 会话的右侧面板：宿主的标签（计划、设置、用量、后台）与插件的会话面板在一个标签栏里，按 owner 排的顺序（合成见 panel-tabs.ts）。
// 标签栏里有关闭当前标签的按钮，关掉的与还没打开过的在标签栏末尾的「+」里；插件面板的标签就是它的标题，手动刷新放在标签栏里
// （插件前端的手动刷新是重新挂载）。
// 标签由地址决定，地址没写或写的标签不在标签栏里时停在第一个

interface SessionPanelProps {
  sessionId: string;
  tabs: SessionTabs;
  /** 地址上的宿主标签 */
  tab?: HostPanelTab;
  /** 地址上的插件面板 */
  panel?: PageRef;
  summary?: SessionSummary;
  plan?: PlanItem;
  usage?: UsageItem;
  settings: ReturnType<typeof useSettingRows>;
  /** 这个会话的后台任务 */
  tasks: readonly BackgroundTask[];
  /** 打开着日志的后台任务 */
  log?: string;
  onLog(taskId?: string): void;
}

export function SessionPanel({
  sessionId,
  tabs,
  tab,
  panel,
  summary,
  plan,
  usage,
  settings,
  tasks,
  log,
  onLog,
}: SessionPanelProps) {
  const phone = usePhone();
  const { pages } = usePages();
  const [reloads, reload] = useReducer((n: number) => n + 1, 0);
  const addressed = panel ? paths.page(panel) : tab;
  // 地址上的插件面板所属的插件停用了：标签栏末尾留着它，内容是占位；插件重新启用后它回到标签栏里原来的位置
  const gone = panel && pages && !pages.some(page => sameRef(panel)(refOf(page))) ? panel : undefined;
  const current = gone ? undefined : (tabs.bar.find(item => item.key === addressed) ?? tabs.bar[0]);
  const host = current && 'host' in current.ref ? current.ref.host : undefined;
  const items = gone ? [...tabs.bar, { ref: gone, key: paths.page(gone), title: '已停用' }] : tabs.bar;
  const selected = gone ? paths.page(gone) : current?.key;
  const shownRef = gone ?? current?.ref;

  const body = (
    <Tabs
      label="会话面板"
      items={items}
      value={selected ?? ''}
      onChange={key => {
        if (key !== selected) tabs.show(items.find(item => item.key === key)!.ref, { replace: true });
      }}
      onClose={shownRef && (() => tabs.close(shownRef))}
      trailing={
        <>
          {current?.page && <IconButton icon={RotateCw} label="刷新" onClick={reload} />}
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
      {gone && <PageGone instance={gone.instance} />}
      {host === 'plan' && plan && <PlanTab sessionId={sessionId} plan={plan} />}
      {host === 'settings' && <SettingsTab settings={settings} />}
      {host === 'usage' && usage && <UsageTable usage={usage} session={summary} />}
      {host === 'background' && summary && <BackgroundTab session={summary} tasks={tasks} log={log} onLog={onLog} />}
      {current?.page &&
        (current.page.frame ? (
          <FramePage key={current.key} page={current.page} sessionId={sessionId} reloads={reloads} reload={reload} />
        ) : (
          <PageScope key={current.key} page={current.page} sessionId={sessionId} version={reloads}>
            <PageContent page={current.page} />
          </PageScope>
        ))}
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
  const sessions = useProvider(SESSION_PROTOCOL);
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
        busy={busy}
        onClick={() => {
          setBusy(true);
          client
            .request('plan/clear', { sessionId })
            .catch((err: Error) => toast({ kind: 'danger', text: `清空失败：${err.message}`, source: sessions }))
            .finally(() => setBusy(false));
        }}
      >
        清空
      </Button>
    </div>
  );
}

function SettingsTab({ settings }: { settings: SessionPanelProps['settings'] }) {
  const { rows, error, update, retry } = settings;
  if (error) {
    return (
      <div className="session-panel-section">
        <SessionsFetchError what="设置" error={error} retry={retry} />
      </div>
    );
  }
  if (!rows) return null;
  if (rows.length === 0) return <p className="session-panel-note">这个会话没有可以设置的项</p>;
  return (
    <div className="session-panel-section">
      <p className="session-panel-note">改动从下一轮起生效</p>
      <SettingRows rows={rows} update={update} />
    </div>
  );
}
