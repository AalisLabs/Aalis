import type {} from '@aalis/api-agent'; // 加载 agent:* 钩子的 HookContextMap augmentation
import { checkpoint } from '@aalis/api-checkpoint';
import { hooks } from '@aalis/api-hooks';
import { memory } from '@aalis/api-memory';
import { storage } from '@aalis/api-storage';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { parseConfig } from '@aalis/schema-config';
import { configSchema } from './config.js';
import { CheckpointServiceImpl, normalizeConfig } from './service.js';

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
  const { storage, memory, events, hooks, lifecycle, provide } = caps;
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
  // 仅对配置 scopes 匹配的会话参与回合生命周期，避免 onebot 等聊天平台为每条消息都创建空 checkpoint。
  const isScopeEnabled = (platform?: string, sessionType?: string): boolean => {
    if (cfg.scopes.length === 0) return false;
    const p = platform ?? '';
    const t = sessionType ?? '';
    for (const raw of cfg.scopes) {
      const [sp = '*', st = '*'] = raw.includes(':') ? raw.split(':', 2) : [raw, '*'];
      const platOk = sp === '*' || sp === '' || sp === p;
      const typeOk = st === '*' || st === '' || st === t;
      if (platOk && typeOk) return true;
    }
    return false;
  };

  hooks.use.middleware('agent:input:before', async (data, next) => {
    if (isScopeEnabled(data.message.platform, data.message.sessionType)) {
      await service.runTurn(data.turnId, data.message.sessionId, next);
    } else {
      await next();
    }
  });

  // 监听命令类工具调用，给调用所在的那一轮在清单里打 execUsed 标记：
  // 这些工具的副作用（子进程改磁盘、装包、起服务）不经 storage，快照覆盖不到。
  hooks.use.middleware('agent:tool:before', async (data, next) => {
    const name = data.name;
    if (name === 'exec' || name.startsWith('run_')) {
      service.markExecUsed();
    }
    await next();
  });

  // ──────────── 参与统一的 memory:clear ────────────
  // /clear 与 session-manager.deleteSession 都通过 memory:clear hook 编排，
  // 不监听的话 checkpoint 目录无人清理，长期泄漏。
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

  logger.info(
    `checkpoint 服务就绪 rootUri=${cfg.rootUri} maxFileSize=${cfg.maxFileSize} scopes=${cfg.scopes.join('|') || '<空>'}`,
  );
}
