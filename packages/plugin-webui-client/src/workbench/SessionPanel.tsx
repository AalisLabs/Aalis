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
import { text, tr } from '../language';
import { PageContent } from '../pages/PageContent';
import { PageGone } from '../pages/PluginPage';
import { refOf, sameRef, usePages } from '../pages/registry';
import { PageScope } from '../pages/scope';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import type { BackgroundTask, SessionSummary } from '../protocol/session-client';
import { paths } from '../routes';
import { SessionSettings } from '../settings/SessionSettings';
import type { useSettingRows } from '../settings/setting-rows';
import { Aside, usePhone } from '../shell/Shell';
import { t } from '../texts';
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
  const items = gone ? [...tabs.bar, { ref: gone, key: paths.page(gone), title: tr('stateDisabled') }] : tabs.bar;
  const selected = gone ? paths.page(gone) : current?.key;
  const shownRef = gone ?? current?.ref;

  const body = (
    <Tabs
      label={tr('sessionPanel')}
      items={items}
      value={selected ?? ''}
      onChange={key => {
        if (key !== selected) tabs.show(items.find(item => item.key === key)!.ref, { replace: true });
      }}
      onClose={shownRef && (() => tabs.close(shownRef))}
      trailing={
        <>
          {current?.page && <IconButton icon={RotateCw} label={tr('refresh')} onClick={reload} />}
          {tabs.error && (
            <IconButton
              icon={CircleAlert}
              label={tr('panelTabsIncomplete', { error: tabs.error.message })}
              onClick={tabs.retry}
            />
          )}
          {tabs.add.length > 0 && (
            <Menu
              icon={Plus}
              label={tr('panelTabOpen')}
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
      {host === 'settings' && <SessionSettings summary={summary} settings={settings} />}
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
    <Aside label={tr('sessionPanel')}>
      {phone ? (
        <Panel title={tr('sessionPanel')} back={paths.session(sessionId)}>
          {body}
        </Panel>
      ) : (
        body
      )}
    </Aside>
  );
}

const PLAN_STATUS = {
  'not-started': { icon: Circle, label: t('planNotStarted') },
  'in-progress': { icon: CircleDot, label: t('planInProgress') },
  completed: { icon: CircleCheck, label: t('planCompleted') },
};

function PlanTab({ sessionId, plan }: { sessionId: string; plan: PlanItem }) {
  const client = useSessionClient();
  const toast = useToast();
  const sessions = useProvider(SESSION_PROTOCOL);
  const [busy, setBusy] = useState(false);
  return (
    <div className="session-panel-section">
      <ul className="plan" aria-label={tr('plan')}>
        {plan.entries.map(entry => {
          const { icon: Icon, label } = PLAN_STATUS[entry.status];
          return (
            <li key={entry.id} data-status={entry.status}>
              <Icon aria-hidden />
              <span className="plan-title">{entry.title}</span>
              <span className="visually-hidden">{text(label)}</span>
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
            .catch((err: Error) =>
              toast({
                kind: 'danger',
                text: tr('actionFailed', { action: t('clear'), error: err.message }),
                source: sessions,
              }),
            )
            .finally(() => setBusy(false));
        }}
      >
        {tr('clear')}
      </Button>
    </div>
  );
}
