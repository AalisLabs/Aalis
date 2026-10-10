// ============================================================
// WebUI 作品站页：概况（健康状况与几个运维动作）、线上的作品、部署与部署历史、未读告警。
// 状态写盘后页面重取；健康状况不正常（状态读不出、暂停、鉴权失败、部署连续失败）时发「出错」提示，恢复后撤回。
// 动作要求作品站在运行：状态读不出或已停止时一律回错误。
// ============================================================

import { type BoundPublish, WORK_ID_PATTERN } from '@aalis/api-publish';
import type { BoundWebui, NoticeHandle } from '@aalis/api-webui';
import type { ServiceSelection } from '@aalis/core';
import type { WorksSiteConfig } from './config.js';
import type { WorksDeployer } from './deploy.js';
import type { WorksStore } from './state.js';

const PAGE_KEY = 'works-site';

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
    if (store.failure) throw new Error(store.failure);
    if (!deployer.active) throw new Error('作品站尚未启动或已停止');
  };
  const page = deps.webui.definePage({
    key: PAGE_KEY,
    title: '作品站',
    icon: 'images',
    actions: {
      withdrawWork: {
        label: '撤下',
        effect: 'destructive',
        confirm: '撤下后站点与缓存会在几分钟内不再返回它；已保持的连接可能更久。',
        row: true,
        async handler({ rowKey }) {
          ready();
          if (
            !WORK_ID_PATTERN.test(rowKey) ||
            !state()?.current[config.productionBranch]?.works.some(work => work.id === rowKey)
          )
            throw new Error('作品不存在');
          if (!deps.publish.present) throw new Error('发布服务不在场');
          const result = await deps.publish.use.withdraw(rowKey, { kind: 'owner' }, 'owner 在作品页撤下');
          if ('refused' in result) throw new Error(result.refused);
          deployer.change();
          return result.degraded ? `撤下已登记；站点状态：${result.degraded}` : '已撤下';
        },
      },
      acknowledgeAlert: {
        label: '标为已读',
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          ready();
          if (!(await deployer.acknowledge(rowKey))) throw new Error('告警不存在');
          return '已标为已读';
        },
      },
      retryDeploy: {
        label: '重试部署',
        effect: 'write',
        handler() {
          ready();
          deployer.retry();
          return '已安排重试部署';
        },
      },
      resumeDeploy: {
        label: '恢复自动部署',
        effect: 'write',
        async handler() {
          ready();
          if (!(await deployer.resume())) throw new Error('请先把未读告警标为已读');
          return '已恢复自动部署';
        },
      },
      alignSettings: {
        label: '对齐项目设置',
        effect: 'write',
        async handler() {
          ready();
          try {
            await deployer.alignSettings();
          } catch {
            throw new Error('项目设置对齐失败');
          }
          return '项目设置已对齐';
        },
      },
      cleanupUnknown: {
        label: '重新部署并清理账外部署',
        effect: 'destructive',
        confirm: '先重新部署我方分支与主站，再删除账外部署。继续？',
        async handler() {
          ready();
          try {
            await deployer.cleanupUnknown();
          } catch {
            throw new Error('重新部署与清理未完成');
          }
          return '已重新部署并清理账外部署';
        },
      },
    },
    content: {
      tabs: [
        {
          key: 'overview',
          title: '概况',
          content: [
            {
              type: 'info',
              id: 'health',
              description: '已打开的连接在撤下后可能继续取到旧内容十分钟以上。',
              data() {
                const snapshot = state();
                const health = deployer.health();
                const last = snapshot?.history[0];
                return [
                  { label: '发布目标', value: config.targetId },
                  { label: '主站', value: `${config.siteOrigin}${config.basePath}`, kind: 'link' as const },
                  {
                    label: '健康',
                    value: health.ok ? { text: '正常' } : { text: health.reason, state: 'error' as const },
                    kind: 'status' as const,
                  },
                  { label: '上次部署', value: last ? last.result : '尚无' },
                  ...(last ? [{ label: '上次部署时间', value: last.at, kind: 'time' as const }] : []),
                  { label: '暂停', value: snapshot?.paused?.reason ?? '否' },
                  {
                    label: 'fail_open',
                    value: `期望 ${config.failOpen}，线上 ${deployer.onlineFailOpen ?? '未核对'}`,
                  },
                  deployer.tokenExpiresOn
                    ? { label: 'token 到期', value: deployer.tokenExpiresOn, kind: 'time' as const }
                    : { label: 'token 到期', value: '未知或不过期' },
                ];
              },
            },
            {
              type: 'actions',
              description: '对齐项目设置只按配置更新两套 fail_open，其他设置要去控制台改。',
              actions: ['retryDeploy', 'resumeDeploy', 'alignSettings', 'cleanupUnknown'],
            },
          ],
        },
        {
          key: 'works',
          title: '作品',
          content: [
            {
              type: 'table',
              id: 'works',
              rowKey: 'id',
              empty: '主站上还没有作品',
              columns: [
                { key: 'thumbnail', label: '缩略图', kind: 'image', primary: true },
                { key: 'title', label: '标题', primary: true },
                { key: 'kind', label: '类型' },
                { key: 'branch', label: '分支' },
                { key: 'alias', label: '别名' },
                { key: 'url', label: '网址', kind: 'link' },
                { key: 'at', label: '上线时刻', kind: 'time' },
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
                      kind: work.kind,
                      branch: state()?.groups[work.group]?.branch ?? '主站',
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
          title: '部署',
          content: [
            {
              type: 'table',
              id: 'deployments',
              label: '当前部署',
              rowKey: 'id',
              empty: '还没有部署',
              columns: [
                { key: 'branch', label: '分支', primary: true },
                { key: 'deployment', label: '部署', kind: 'code' },
                { key: 'nonce', label: 'nonce', kind: 'code' },
                { key: 'at', label: '时刻', kind: 'time', primary: true },
                { key: 'count', label: '作品数' },
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
              label: '部署历史',
              rowKey: 'key',
              empty: '还没有部署历史',
              columns: [
                { key: 'at', label: '时刻', kind: 'time', primary: true },
                { key: 'branch', label: '分支' },
                { key: 'deployment', label: '部署', kind: 'code' },
                { key: 'result', label: '结果', primary: true },
              ],
              // 历史没有自己的 id，按从新到旧的次序标识
              data: () =>
                (state()?.history ?? []).slice(0, 50).map((item, i) => ({
                  key: String(i),
                  at: item.at,
                  branch: item.branch,
                  deployment: item.deployment.slice(0, 8),
                  result: item.result,
                })),
            },
          ],
        },
        {
          key: 'alerts',
          title: '告警',
          content: [
            {
              type: 'table',
              id: 'alerts',
              rowKey: 'id',
              empty: '没有未读告警',
              columns: [
                { key: 'kind', label: '类型' },
                { key: 'detail', label: '详情', kind: 'long-text', primary: true },
                { key: 'at', label: '时刻', kind: 'time', primary: true },
              ],
              rowActions: [{ action: 'acknowledgeAlert' }],
              data: () =>
                (state()?.alerts ?? [])
                  .filter(item => !item.acknowledged)
                  .map(item => ({ id: item.id, kind: item.kind, detail: item.detail, at: item.at })),
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
      title: `作品站：${health.reason}`,
      open: { page: PAGE_KEY },
    });
  };
  store.onChange(changed);
  changed();
}
