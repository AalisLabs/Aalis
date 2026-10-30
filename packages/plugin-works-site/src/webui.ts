// ============================================================
// WebUI 作品站页：概况（健康状况与几个运维动作）、线上的作品、部署与部署历史、未读告警。
// 状态写盘后页面重取；健康状况不正常（状态读不出、暂停、鉴权失败、部署连续失败）时发「出错」提示，恢复后撤回。
// 动作要求作品站在运行：状态读不出或已停止时一律回错误。
// ============================================================

import { type BoundPublish, type PublishedItem, WORK_ID_PATTERN } from '@aalis/api-publish';
import type { BoundWebui, NoticeHandle } from '@aalis/api-webui';
import type { ServiceSelection } from '@aalis/core';
import { TextError, type TextRef } from '@aalis/schema-i18n';
import type { WorksSiteConfig } from './config.js';
import type { WorksDeployer } from './deploy.js';
import type { SiteAlert, WorksStore } from './state.js';
import { t } from './texts.js';

const PAGE_KEY = 'works-site';

/** 作品类型的显示名（存储里的值照旧；状态文件读回时只认这两种） */
const WORK_KINDS: Record<PublishedItem['kind'], TextRef> = { html: t('kindHtml'), media: t('kindMedia') };
/** 部署结果的显示名（存储里的值照旧） */
const RESULTS: Readonly<Record<string, TextRef>> = {
  live: t('resultLive'),
  failed: t('resultFailed'),
  'rolled-back': t('resultRolledBack'),
};
/** 告警类型的显示名（存储里的值照旧） */
const ALERT_KINDS: Record<SiteAlert['kind'], TextRef> = {
  'unknown-deployment': t('alertUnknownDeployment'),
  settings: t('alertSettings'),
  domains: t('alertDomains'),
  probe: t('alertProbe'),
  content: t('alertContent'),
  'cache-lag': t('alertCacheLag'),
  alias: t('alertAlias'),
  auth: t('alertAuth'),
  integrity: t('alertIntegrity'),
  'deploy-failed': t('alertDeployFailed'),
};
/** 落盘值的显示名：状态文件读回时不核这两种值，表里没有的照旧显示原值 */
const nameIn = (names: Readonly<Record<string, TextRef>>, value: string): string | TextRef =>
  Object.hasOwn(names, value) ? names[value] : value;

export function registerWorksPage(deps: {
  webui: BoundWebui;
  publish: ServiceSelection<BoundPublish>;
  store: WorksStore;
  deployer: WorksDeployer;
  config: WorksSiteConfig;
}): void {
  const { config, deployer, store } = deps;
  const state = () => store.data;
  const ready = () => {
    if (store.failure) throw new TextError(store.failure);
    if (!deployer.active) throw new TextError(t('notRunning'));
  };
  const page = deps.webui.definePage({
    key: PAGE_KEY,
    title: t('displayName'),
    icon: 'images',
    actions: {
      withdrawWork: {
        label: t('withdrawLabel'),
        effect: 'destructive',
        confirm: t('withdrawConfirm'),
        row: true,
        async handler({ rowKey }) {
          ready();
          if (
            !WORK_ID_PATTERN.test(rowKey) ||
            !state()?.current[config.productionBranch]?.works.some(work => work.id === rowKey)
          )
            throw new TextError(t('workNotFound'));
          if (!deps.publish.present) throw new TextError(t('publishAbsent'));
          const result = await deps.publish.use.withdraw(rowKey, { kind: 'owner' }, 'owner 在作品页撤下');
          if ('refused' in result) {
            const { refused } = result;
            throw typeof refused === 'string' ? new Error(refused) : new TextError(refused);
          }
          deployer.change();
          return result.degraded ? t('withdrawnDegraded', { state: result.degraded }) : t('withdrawn');
        },
      },
      acknowledgeAlert: {
        label: t('acknowledgeLabel'),
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          ready();
          if (!(await deployer.acknowledge(rowKey))) throw new TextError(t('alertNotFound'));
          return t('acknowledged');
        },
      },
      retryDeploy: {
        label: t('retryLabel'),
        effect: 'write',
        handler() {
          ready();
          deployer.retry();
          return t('retryScheduled');
        },
      },
      resumeDeploy: {
        label: t('resumeLabel'),
        effect: 'write',
        async handler() {
          ready();
          if (!(await deployer.resume())) throw new TextError(t('acknowledgeFirst'));
          return t('resumed');
        },
      },
      alignSettings: {
        label: t('alignLabel'),
        effect: 'write',
        async handler() {
          ready();
          try {
            await deployer.alignSettings();
          } catch {
            throw new TextError(t('alignFailed'));
          }
          return t('aligned');
        },
      },
      cleanupUnknown: {
        label: t('cleanupLabel'),
        effect: 'destructive',
        confirm: t('cleanupConfirm'),
        async handler() {
          ready();
          try {
            await deployer.cleanupUnknown();
          } catch {
            throw new TextError(t('cleanupIncomplete'));
          }
          return t('cleanedUp');
        },
      },
    },
    content: {
      tabs: [
        {
          key: 'overview',
          title: t('tabOverview'),
          content: [
            {
              type: 'info',
              id: 'health',
              description: t('healthDescription'),
              data() {
                const snapshot = state();
                const health = deployer.health();
                const last = snapshot?.history[0];
                return [
                  { label: t('publishTarget'), value: config.targetId },
                  { label: t('mainSite'), value: `${config.siteOrigin}${config.basePath}`, kind: 'link' as const },
                  {
                    label: t('health'),
                    value: health.ok ? { text: t('healthy') } : { text: health.reason, state: 'error' as const },
                    kind: 'status' as const,
                  },
                  { label: t('lastDeployment'), value: last ? nameIn(RESULTS, last.result) : t('noneYet') },
                  ...(last ? [{ label: t('lastDeployedAt'), value: last.at, kind: 'time' as const }] : []),
                  { label: t('pausedLabel'), value: snapshot?.paused?.reason ?? t('no') },
                  {
                    label: 'fail_open',
                    value: t('failOpenState', {
                      expected: String(config.failOpen),
                      live: deployer.onlineFailOpen == null ? t('unchecked') : String(deployer.onlineFailOpen),
                    }),
                  },
                  deployer.tokenExpiresOn
                    ? { label: t('tokenExpiry'), value: deployer.tokenExpiresOn, kind: 'time' as const }
                    : { label: t('tokenExpiry'), value: t('tokenNoExpiry') },
                ];
              },
            },
            {
              type: 'actions',
              description: t('actionsDescription'),
              actions: ['retryDeploy', 'resumeDeploy', 'alignSettings', 'cleanupUnknown'],
            },
          ],
        },
        {
          key: 'works',
          title: t('tabWorks'),
          content: [
            {
              type: 'table',
              id: 'works',
              rowKey: 'id',
              empty: t('worksEmpty'),
              columns: [
                { key: 'thumbnail', label: t('columnThumbnail'), kind: 'image', primary: true },
                { key: 'title', label: t('columnTitle'), primary: true },
                { key: 'kind', label: t('columnKind') },
                { key: 'branch', label: t('columnBranch') },
                { key: 'alias', label: t('columnAlias') },
                { key: 'url', label: t('columnUrl'), kind: 'link' },
                { key: 'at', label: t('columnLiveAt'), kind: 'time' },
              ],
              rowActions: [{ action: 'withdrawWork' }],
              data: () =>
                Object.values(state()?.current ?? {})
                  .filter(item => item.branch === config.productionBranch)
                  .flatMap(item =>
                    item.works.map(work => ({
                      id: work.id,
                      thumbnail:
                        work.hasThumbnail && deps.publish.present ? deps.publish.use.thumbnailUri(work.id) : undefined,
                      title: work.title,
                      kind: WORK_KINDS[work.kind],
                      branch: state()?.groups[work.group]?.branch ?? t('mainSite'),
                      alias: state()?.groups[work.group]?.alias ?? '',
                      url: `${config.siteOrigin}${config.basePath}w/${work.id}/`,
                      at: item.at,
                    })),
                  ),
            },
          ],
        },
        {
          key: 'deployments',
          title: t('tabDeployments'),
          content: [
            {
              type: 'table',
              id: 'deployments',
              label: t('currentDeployments'),
              rowKey: 'id',
              empty: t('deploymentsEmpty'),
              columns: [
                { key: 'branch', label: t('columnBranch'), primary: true },
                { key: 'deployment', label: t('columnDeployment'), kind: 'code' },
                { key: 'nonce', label: 'nonce', kind: 'code' },
                { key: 'at', label: t('columnTime'), kind: 'time', primary: true },
                { key: 'count', label: t('columnWorkCount') },
              ],
              data: () =>
                Object.values(state()?.current ?? {}).map(item => ({
                  id: item.id,
                  branch: item.branch,
                  deployment: item.id.slice(0, 8),
                  nonce: item.nonce,
                  at: item.at,
                  count: item.works.length,
                })),
            },
            {
              type: 'table',
              id: 'history',
              label: t('history'),
              rowKey: 'key',
              empty: t('historyEmpty'),
              columns: [
                { key: 'at', label: t('columnTime'), kind: 'time', primary: true },
                { key: 'branch', label: t('columnBranch') },
                { key: 'deployment', label: t('columnDeployment'), kind: 'code' },
                { key: 'result', label: t('columnResult'), primary: true },
              ],
              // 历史没有自己的 id，按从新到旧的次序标识
              data: () =>
                (state()?.history ?? []).slice(0, 50).map((item, i) => ({
                  key: String(i),
                  at: item.at,
                  branch: item.branch,
                  deployment: item.deployment.slice(0, 8),
                  result: nameIn(RESULTS, item.result),
                })),
            },
          ],
        },
        {
          key: 'alerts',
          title: t('tabAlerts'),
          content: [
            {
              type: 'table',
              id: 'alerts',
              rowKey: 'id',
              empty: t('alertsEmpty'),
              columns: [
                { key: 'kind', label: t('columnKind') },
                { key: 'detail', label: t('columnDetail'), kind: 'long-text', primary: true },
                { key: 'at', label: t('columnTime'), kind: 'time', primary: true },
              ],
              rowActions: [{ action: 'acknowledgeAlert' }],
              data: () =>
                (state()?.alerts ?? [])
                  .filter(item => !item.acknowledged)
                  .map(item => ({
                    id: item.id,
                    kind: nameIn(ALERT_KINDS, item.kind),
                    detail: item.detail,
                    at: item.at,
                  })),
            },
          ],
        },
      ],
    },
  });

  let unhealthy: NoticeHandle | undefined;
  /** 状态变了：页面重取，健康状况不正常时发出提示，恢复后撤回 */
  const changed = () => {
    page.invalidate();
    const health = deployer.health();
    if (health.ok) {
      unhealthy?.clear();
      unhealthy = undefined;
      return;
    }
    unhealthy = deps.webui.notify({
      id: 'health',
      level: 'error',
      title: t('healthNotice', { reason: health.reason }),
      open: { page: PAGE_KEY },
    });
  };
  store.onChange(changed);
  changed();
}
