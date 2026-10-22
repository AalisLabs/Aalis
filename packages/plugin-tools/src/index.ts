import { ownHostConfig } from '@aalis/api-host-config';
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
    label: '后台任务',
    fields: {
      maxWaitSeconds: {
        type: 'number',
        label: '前台最多等待（秒）',
        default: DEFAULT_LIMITS.maxWaitSeconds,
        min: 1,
        // 计时器能表示的最长时限（2147483647 毫秒）：超过时 Node 按 1 毫秒算，等于立即转后台
        max: 2_147_483,
        integer: true,
        description: '可转后台的工具调用在前台最多等多少秒，模型给的 waitSeconds 超过它按它算；到时还没结束就转到后台',
      },
      maxPerSession: {
        type: 'number',
        label: '每个会话同时在跑的上限',
        default: DEFAULT_LIMITS.maxPerSession,
        min: 1,
        integer: true,
        description:
          '同一会话里对话回合中同时在跑的可转后台工具调用（前台与后台一起数），满了时新的调用在执行之前就被拒绝；不在对话回合里的调用不会转后台，不占名额',
      },
    },
  },
  // 按会话字段：空列表即只给不属于任何分组的工具，只有 owner 能改
  enabledToolGroups: {
    type: 'multiselect',
    label: t('groupsLabel'),
    description: t('groupsDescription'),
    dynamicOptions: 'toolGroups',
    allowCustom: true,
    default: [],
    session: { prominence: 'common', order: 30 },
  },
});

export default definePlugin({
  name: '@aalis/plugin-tools',
  displayName: '工具注册表',
  subsystem: 'agent',
  configSchema,
  provides: [tools, backgroundTasks],
  uses: {
    logger,
    provide,
    /** 后台任务的 tool:output、background:changed 与结束通知；会话删除与停机 */
    events,
    lifecycle,
    config,
    /** 按会话读「工具分组」；缺席时各会话取插件配置里的值 */
    sessionFields: optional(sessionFields),
    /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
    document: optional(ownHostConfig),
    /** 后台任务登记写进插件数据；没有时只记在内存里 */
    storage: optional(storage),
  },
  apply(caps) {
    const { logger, events, lifecycle } = caps;
    const cfg = parseConfig(configSchema, caps.config.use, logger.use);
    const fields = caps.sessionFields.use.fields(configSchema, caps);

    const tasks = new BackgroundTasks({ logger: logger.use, events: events.use, limits: cfg.background });
    events.use.on('session:deleted', sessionId => tasks.deleteSession(sessionId));
    events.use.on('app:stopping', () => tasks.shutdown());
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
      fields.get(sessionId, { platform }).enabledToolGroups;
    caps.provide.use(tools, new ToolRegistry(logger.use, tasks, sessionGroups));
    caps.provide.use(backgroundTasks, tasks);
  },
});
