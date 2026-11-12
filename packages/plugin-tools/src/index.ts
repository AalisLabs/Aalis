import { ownHostConfig } from '@aalis/api-host-config';
import { rootSessionOf, sessionManager } from '@aalis/api-session-manager';
import { sessionFields } from '@aalis/api-session-settings';
import { storage } from '@aalis/api-storage';
import { backgroundTasks, tools } from '@aalis/api-tools';
import { config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';
import { BackgroundTasks, DEFAULT_LIMITS } from './background.js';
import { t } from './texts.js';
import { ToolRegistry } from './tools.js';

const configSchema = defineConfig({
  background: {
    label: t('backgroundLabel'),
    fields: {
      maxWaitSeconds: {
        type: 'number',
        label: t('maxWaitSecondsLabel'),
        default: DEFAULT_LIMITS.maxWaitSeconds,
        min: 1,
        // 计时器能表示的最长时限（2147483647 毫秒）：超过时 Node 按 1 毫秒算，等于立即转后台
        max: 2_147_483,
        integer: true,
        description: t('maxWaitSecondsDescription'),
      },
      maxPerSession: {
        type: 'number',
        label: t('maxPerSessionLabel'),
        default: DEFAULT_LIMITS.maxPerSession,
        min: 1,
        integer: true,
        description: t('maxPerSessionDescription'),
      },
    },
  },
  // 按会话字段：空列表即只给不属于任何分组的工具，只有 owner 能改；哪一层都没设时见 unsetGroups
  enabledToolGroups: {
    type: 'multiselect',
    label: t('groupsLabel'),
    description: t('groupsDescription'),
    dynamicOptions: 'toolGroups',
    allowCustom: true,
    session: { prominence: 'common', order: 30, unset: t('groupsUnset') },
  },
});

export default definePlugin({
  name: '@aalis/plugin-tools',
  displayName: t('displayName'),
  subsystem: 'agent',
  configSchema,
  provides: [tools, backgroundTasks],
  uses: {
    logger,
    provide,
    /** 后台任务的 tool:output、background:changed 与结束通知；会话删除 */
    events,
    lifecycle,
    config,
    /** 按会话读「工具分组」；缺席时各会话取插件配置里的值 */
    sessionFields: optional(sessionFields),
    /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
    document: optional(ownHostConfig),
    /** 后台任务登记写进插件数据；没有时只记在内存里 */
    storage: optional(storage),
    /** 工具分组哪一层都没设时看根会话从哪里建的；缺席时一律不开 */
    sessionManager: optional(sessionManager),
  },
  apply(caps) {
    const { logger, events, lifecycle } = caps;
    const cfg = parseConfig(configSchema, caps.config.use, logger.use);

    /**
     * 工具分组哪一层都没设时：根会话（子会话取根会话的）带创建来源，即在本机的 WebUI 或终端建的，开全部分组；聊天平台的
     * 会话与内部会话不开。不按 owner 开：开了就看不出 owner 默认用什么工具
     */
    const unsetGroups = (sessionId: string): string[] => {
      if (!caps.sessionManager.present) return [];
      const sm = caps.sessionManager.use;
      return rootSessionOf(sm.getSession(sessionId), id => sm.getSession(id))?.createdFrom !== undefined ? ['*'] : [];
    };
    // 同一个值作为字段的 actual 交给会话设置：会话的行上写出来，编辑从它开始，建子会话时写下
    const fields = caps.sessionFields.use.fields(configSchema, caps, {
      enabledToolGroups: sessionId => {
        if (sessionId === undefined) return undefined;
        const value = unsetGroups(sessionId);
        return { value, label: t(value.length > 0 ? 'groupsAll' : 'groupsNone') };
      },
    });

    const tasks = new BackgroundTasks({
      logger: logger.use,
      events: events.use,
      limits: cfg.background,
      signal: lifecycle.use.signal,
    });
    events.use.on('session:deleted', sessionId => tasks.deleteSession(sessionId));
    // 停接新活时：在跑的落成 aborted 并写盘，这时依赖的存储还在
    lifecycle.use.onDrain(() => tasks.close());
    // 登记表读回一次：optional 依赖不参与激活顺序，存储可能晚于本插件上线，有了插件数据根才读
    const store = caps.storage.use;
    let restoring = false;
    caps.storage.follow(() => {
      if (restoring || !store.listRoots().some(root => root.name === 'pluginData')) return;
      restoring = true;
      void tasks.restore(store.own);
    });

    const sessionGroups = (sessionId: string, platform?: string) =>
      fields.get(sessionId, { platform }).enabledToolGroups ?? unsetGroups(sessionId);
    caps.provide.use(tools, new ToolRegistry(logger.use, tasks, sessionGroups));
    caps.provide.use(backgroundTasks, tasks);
  },
});
