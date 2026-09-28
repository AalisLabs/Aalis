import { type BoundPublish, WORK_ID_PATTERN } from '@aalis/api-publish';
import type { BoundWebui, WebuiPage } from '@aalis/api-webui';
import type { WorksSiteConfig } from './config.js';
import type { WorksDeployer } from './deploy.js';
import type { WorksStore } from './state.js';

const PAGE: WebuiPage = {
  key: 'works-site',
  label: '作品站',
  order: 56,
  refresh: 30,
  content: [
    { type: 'markdown', source: 'worksStatus' },
    {
      type: 'tabs',
      items: [
        {
          key: 'works',
          label: '作品',
          content: [
            {
              type: 'table',
              source: 'worksItems',
              columns: [
                { key: 'thumbnail', label: '缩略图', render: 'image', method: 'worksThumbnail' },
                { key: 'title', label: '标题' },
                { key: 'kind', label: '类型' },
                { key: 'branch', label: '分支' },
                { key: 'alias', label: '别名' },
                { key: 'url', label: '网址' },
                { key: 'at', label: '上线时刻' },
              ],
              actions: [
                {
                  label: '撤下',
                  method: 'worksWithdraw',
                  danger: true,
                  confirm: '撤下后站点与缓存会在几分钟内不再返回它；已保持的连接可能更久。',
                },
              ],
            },
          ],
        },
        {
          key: 'deployments',
          label: '部署',
          content: [
            {
              type: 'table',
              source: 'worksDeployments',
              columns: [
                { key: 'branch', label: '分支' },
                { key: 'id', label: '部署' },
                { key: 'nonce', label: 'nonce' },
                { key: 'at', label: '时刻' },
                { key: 'count', label: '作品数' },
              ],
            },
            {
              type: 'table',
              source: 'worksHistory',
              columns: [
                { key: 'at', label: '时刻' },
                { key: 'branch', label: '分支' },
                { key: 'deployment', label: '部署' },
                { key: 'result', label: '结果' },
              ],
            },
          ],
        },
        {
          key: 'alerts',
          label: '告警',
          content: [
            {
              type: 'table',
              source: 'worksAlerts',
              columns: [
                { key: 'kind', label: '类型' },
                { key: 'detail', label: '详情' },
                { key: 'at', label: '时刻' },
              ],
              actions: [{ label: '标为已读', method: 'worksAcknowledge' }],
            },
          ],
        },
      ],
    },
    {
      type: 'actions',
      label: '操作',
      items: [
        { label: '重试部署', method: 'worksRetry' },
        { label: '恢复自动部署', method: 'worksResume' },
        {
          label: '对齐项目设置',
          method: 'worksAlignSettings',
          confirm: '按配置更新两套 fail_open？其他设置需去控制台修改。',
        },
        {
          label: '重新部署并清理账外部署',
          method: 'worksCleanupUnknown',
          danger: true,
          confirm: '先重新部署我方分支与主站，再删除账外部署。继续？',
        },
      ],
    },
  ],
};

const fail = (error: string) => ({ ok: false as const, error });
const ok = () => ({ ok: true as const });

export function registerWorksPage(deps: {
  webui: BoundWebui;
  publish: BoundPublish;
  store: WorksStore;
  deployer: WorksDeployer;
  config: WorksSiteConfig;
}): void {
  const state = () => deps.store.data;
  const ready = () =>
    deps.store.failure ? fail(deps.store.failure) : !deps.deployer.active ? fail('作品站尚未启动或已停止') : undefined;
  deps.webui.registerPage(PAGE);
  deps.webui.registerAction('worksStatus', async () => {
    const snapshot = state();
    const health = deps.deployer.health();
    const last = snapshot?.history[0];
    return {
      content:
        `主站：${deps.config.siteOrigin}\n\n健康：${health.ok ? '正常' : health.reason}\n\n` +
        `上次部署：${last ? `${new Date(last.at).toISOString()} ${last.result}` : '尚无'}\n\n` +
        `暂停：${snapshot?.paused?.reason ?? '否'}\n\nfail_open：期望 ${deps.config.failOpen}，线上 ` +
        `${deps.deployer.onlineFailOpen ?? '未核对'}\n\ntoken 到期：` +
        `${deps.deployer.tokenExpiresOn ? new Date(deps.deployer.tokenExpiresOn).toISOString() : '未知/不过期'}\n\n` +
        '已打开的连接在撤下后可能继续取到旧内容十分钟以上。',
    };
  });
  deps.webui.registerAction('worksItems', async () =>
    Object.values(state()?.current ?? {})
      .filter(item => item.branch === deps.config.productionBranch)
      .flatMap(item =>
        item.works.map(work => ({
          id: work.id,
          thumbnail: work.hasThumbnail ? work.id : '',
          title: work.title,
          kind: work.kind,
          branch: state()?.groups[work.group]?.branch ?? '主站',
          alias: state()?.groups[work.group]?.alias ?? '',
          url: `${deps.config.siteOrigin}/w/${work.id}/`,
          at: item.at,
        })),
      ),
  );
  deps.webui.registerAction('worksDeployments', async () =>
    Object.values(state()?.current ?? {}).map(item => ({
      branch: item.branch,
      id: item.id.slice(0, 8),
      nonce: item.nonce,
      at: item.at,
      count: item.works.length,
    })),
  );
  deps.webui.registerAction('worksHistory', async () =>
    (state()?.history ?? []).slice(0, 50).map(item => ({
      ...item,
      deployment: item.deployment.slice(0, 8),
    })),
  );
  deps.webui.registerAction('worksAlerts', async () => state()?.alerts.filter(item => !item.acknowledged) ?? []);
  deps.webui.registerAction('worksThumbnail', async args => {
    if (ready()) return ready();
    const id = args.id;
    if (typeof id !== 'string' || !WORK_ID_PATTERN.test(id)) return fail('作品编号不合法');
    const item = state()?.current[deps.config.productionBranch]?.works.find(work => work.id === id);
    if (!item?.hasThumbnail) return fail('缩略图不存在');
    try {
      const service = deps.publish.current;
      if (!service) return fail('发布服务不在场');
      const bytes = await service.readThumbnail(id);
      return { name: `${id}.png`, mime: 'image/png', base64: Buffer.from(bytes).toString('base64') };
    } catch {
      return fail('缩略图不可读取');
    }
  });
  deps.webui.registerAction('worksWithdraw', async args => {
    if (ready()) return ready();
    const id = args.id;
    if (
      typeof id !== 'string' ||
      !WORK_ID_PATTERN.test(id) ||
      !state()?.current[deps.config.productionBranch]?.works.some(work => work.id === id)
    )
      return fail('作品不存在');
    const service = deps.publish.current;
    if (!service) return fail('发布服务不在场');
    const result = await service.withdraw(id, { kind: 'owner' }, 'owner 在作品页撤下');
    if ('refused' in result) return fail(result.refused);
    deps.deployer.change();
    return result.degraded ? { ok: true, message: `撤下已登记；站点状态：${result.degraded}` } : ok();
  });
  deps.webui.registerAction('worksRetry', async () => {
    if (ready()) return ready();
    deps.deployer.retry();
    return ok();
  });
  deps.webui.registerAction('worksResume', async () => {
    if (ready()) return ready();
    return (await deps.deployer.resume()) ? ok() : fail('请先把未读告警标为已读');
  });
  deps.webui.registerAction('worksAcknowledge', async args => {
    if (ready()) return ready();
    return typeof args.id === 'string' && (await deps.deployer.acknowledge(args.id)) ? ok() : fail('告警不存在');
  });
  deps.webui.registerAction('worksAlignSettings', async () => {
    if (ready()) return ready();
    try {
      await deps.deployer.alignSettings();
      return ok();
    } catch {
      return fail('项目设置对齐失败');
    }
  });
  deps.webui.registerAction('worksCleanupUnknown', async () => {
    if (ready()) return ready();
    try {
      await deps.deployer.cleanupUnknown();
      return ok();
    } catch {
      return fail('重新部署与清理未完成');
    }
  });
}
