import type {} from '@aalis/api-agent'; // 加载 agent:* 钩子的 HookContextMap augmentation
import { authority } from '@aalis/api-authority';
import { checkpoint } from '@aalis/api-checkpoint';
import { contributions } from '@aalis/api-contributions';
import { hooks } from '@aalis/api-hooks';
import { ownHostConfig } from '@aalis/api-host-config';
import { memory } from '@aalis/api-memory';
import { roomClass, sessionManager } from '@aalis/api-session-manager';
import { sessionFields } from '@aalis/api-session-settings';
import { storage } from '@aalis/api-storage';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { parseConfig } from '@aalis/schema-config';
import { configSchema } from './config.js';
import { CheckpointServiceImpl, normalizeConfig } from './service.js';
import { t } from './texts.js';

// ════════════════════════════════════════════════════════════
// plugin-checkpoint — 文件操作快照与回滚（契约见 @aalis/api-checkpoint）
// ════════════════════════════════════════════════════════════

const uses = {
  /**
   * storage 是硬依赖：本插件的快照/manifest 全部经 storage 落盘。
   *
   * 声明成 required 同时决定关停次序：storage 排在本插件之后退场，onDispose 里的 flushAll 才写得动。
   * 该保证只在 app.stop() 的整体拓扑逆序成立；单独禁用/热重载 storage 时 flushAll 会落空
   * （回合 blob 在写点已落盘，丢的只是在飞回合的 manifest）。
   */
  storage,
  /** 只有「回滚整轮对话」用得到（抓消息时间戳、删消息）；没有 memory 也能做纯文件回滚 */
  memory: optional(memory),
  /** 登记 /clear 的 checkpoint 类型 */
  contributions: optional(contributions),
  /** 判会话的受众（房间类别，子会话取根会话的）：coverage 为按受众时用；会话管理缺席时判不出，不记 */
  sessionManager: optional(sessionManager),
  /** 房间类别里谁是 owner；缺席时没有人是 owner */
  authority: optional(authority),
  /** 按会话读 coverage；缺席时取插件配置里的值 */
  sessionFields: optional(sessionFields),
  /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
  document: optional(ownHostConfig),
  events,
  hooks,
  lifecycle,
  logger,
  config,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-checkpoint',
  displayName: '回滚检查点',
  subsystem: 'scheduler',
  configSchema,
  provides: [checkpoint],
  uses,
  apply: run,
});

function run(caps: Caps): void {
  const { storage, memory, events, hooks, lifecycle, provide, contributions, sessionManager, authority } = caps;
  /** 服务内部的 commitTurn / gc / flush 都写这个 source，日志页按 `…:checkpoint` 归组 */
  const logger = caps.logger.use.child('checkpoint');
  const cfg = normalizeConfig(parseConfig(configSchema, caps.config.use, logger));
  const gateway = storage.use;

  const service = new CheckpointServiceImpl(cfg, logger, gateway);
  provide.use(checkpoint, service);

  // 注入 chat 回滚所需依赖：memory 引用（每次调用解析当前提供者）+ 事件发出器
  service.setChatRollbackDeps({
    memory,
    emitMessagesDeleted: (sessionId, timestamps) => {
      events.use
        .emit('memory:messages-deleted', { sessionId, timestamps })
        .catch(err => logger.debug(`emit memory:messages-deleted 失败: ${(err as Error).message}`));
    },
    emitHistoryChanged: sessionId => {
      events.use
        .emit('history:changed', { sessionId })
        .catch(err => logger.debug(`emit history:changed 失败: ${(err as Error).message}`));
    },
  });

  // ──────────── 回合生命周期 ────────────
  // agent:input:before 的 next 就是这一轮的全部（后续中间件、模型调用、工具、回合结束钩子），
  // 用 agent 给的 turnId 把它包进 runTurn：期间的存储改动记进这一轮，next 返回（含被下游拦下、出错）即提交。
  // 只包 coverage 覆盖的会话：按受众时看根会话的房间类别，不看这一轮从哪个入口进来。
  const fields = caps.sessionFields.use.fields(configSchema, caps);
  const lookup = (id: string) => (sessionManager.present ? sessionManager.use.getSession(id) : undefined);
  const isOwner = (platform: string, userId: string) => authority.present && authority.use.isOwner(platform, userId);
  const covered = (sessionId: string, platform: string): boolean => {
    const coverage = fields.get(sessionId, { platform }).coverage;
    return (
      coverage === 'all' || (coverage === 'ownerOnly' && roomClass(lookup(sessionId), lookup, isOwner) === 'owner-only')
    );
  };

  hooks.use.middleware('agent:input:before', async (data, next) => {
    if (covered(data.message.sessionId, data.message.platform)) {
      await service.runTurn(data.turnId, data.message.sessionId, next);
    } else {
      await next();
    }
  });

  // ──────────── 参与统一的 memory:clear ────────────
  // /clear 与 session-manager.deleteSession 都通过 memory:clear hook 编排，
  // 不监听的话 checkpoint 目录无人清理，长期泄漏。登记 checkpoint 类型，/clear -t 才选得中。
  contributions.use.contribute('memory:clear-type', { id: 'checkpoint', label: t('clearType') });
  hooks.use.middleware('memory:clear', async (data, next) => {
    if (data.types && !data.types.includes('checkpoint')) {
      await next();
      return;
    }
    try {
      if (data.scope === 'all') {
        const n = await service.clearAll();
        data.results.push({
          source: 'checkpoint',
          type: 'checkpoint',
          success: true,
          message: `所有 checkpoint 已清空（${n} 个 session）`,
        });
      } else if (data.sessionId) {
        const n = await service.clearSession(data.sessionId);
        data.results.push({
          source: 'checkpoint',
          type: 'checkpoint',
          success: true,
          message: n > 0 ? `当前会话 checkpoint 已清空（${n} 个 turn）` : '当前会话无 checkpoint',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      data.results.push({
        source: 'checkpoint',
        type: 'checkpoint',
        success: false,
        message: `checkpoint 清空失败: ${msg}`,
      });
    }
    await next();
  });

  // 拆卸时提交所有还在跑的回合，避免崩溃/重载时丢失
  lifecycle.use.onDispose(() => service.flushAll());

  logger.info(`checkpoint 服务就绪 rootUri=${cfg.rootUri} maxFileSize=${cfg.maxFileSize}`);
}
