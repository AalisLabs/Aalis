import type { Context, ConfigSchema, PluginModule, StorageService } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import { CheckpointServiceImpl, resolveConfig, type CheckpointService } from './service.js';
import { mkdir } from 'node:fs/promises';

// ════════════════════════════════════════════════════════════
// plugin-checkpoint — 文件操作快照与回滚
// ════════════════════════════════════════════════════════════

export const name = '@aalis/plugin-checkpoint';
export const displayName = '回滚检查点';
export const provides = ['checkpoint'];

export const configSchema: ConfigSchema = {
  rootDir: {
    type: 'string',
    label: '存储目录',
    description: '相对工作目录的路径，所有 checkpoint blob 和 manifest 写入此目录。',
    default: 'data/checkpoints',
  },
  maxFileSize: {
    type: 'number',
    label: '单文件大小上限（字节）',
    description: '超过此大小的文件不做内容快照，只在 manifest 里记录为 skipped。',
    default: 10 * 1024 * 1024,
  },
  keepSessions: {
    type: 'number',
    label: '保留的会话数',
    description: 'GC 阈值。每次提交回合后，若 session 目录数超过此值，删除最早的几个。设为 0 关闭 GC。',
    default: 20,
  },
};

export const defaultConfig = {
  rootDir: 'data/checkpoints',
  maxFileSize: 10 * 1024 * 1024,
  keepSessions: 20,
};

// ──────────── WebUI Handlers ────────────

export const webuiHandlers: PluginModule['webuiHandlers'] = {
  async listTurns(ctx, args) {
    const svc = ctx.getService<CheckpointService>('checkpoint');
    if (!svc) return [];
    const sessionId = (args.sessionId as string | undefined) ?? '';
    if (!sessionId) return { error: '缺少 sessionId' };
    return svc.listTurns(sessionId);
  },
  async getManifest(ctx, args) {
    const svc = ctx.getService<CheckpointService>('checkpoint');
    if (!svc) return null;
    const sessionId = args.sessionId as string;
    const turnId = args.turnId as string;
    return svc.getManifest(sessionId, turnId);
  },
  async rollback(ctx, args) {
    const svc = ctx.getService<CheckpointService>('checkpoint');
    if (!svc) return { ok: false, errors: [{ uri: '', reason: 'checkpoint 服务未启用' }] };
    const sessionId = args.sessionId as string;
    const turnId = args.turnId as string;
    if (!sessionId || !turnId) return { ok: false, errors: [{ uri: '', reason: '缺少 sessionId 或 turnId' }] };
    return svc.rollback(sessionId, turnId);
  },
  async rollbackWithChat(ctx, args) {
    const svc = ctx.getService<CheckpointService>('checkpoint');
    if (!svc) return { ok: false, errors: [{ uri: '', reason: 'checkpoint 服务未启用' }], deletedMessages: 0, chatDeleted: false };
    const sessionId = args.sessionId as string;
    const turnId = args.turnId as string;
    if (!sessionId || !turnId) return { ok: false, errors: [{ uri: '', reason: '缺少 sessionId 或 turnId' }], deletedMessages: 0, chatDeleted: false };
    return svc.rollbackWithChat(sessionId, turnId);
  },
};

// ──────────── 插件入口 ────────────

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('checkpoint');
  await mkdir(config.rootDir, { recursive: true });

  const service = new CheckpointServiceImpl(config, logger);
  ctx.provide('checkpoint', service);

  // 注入回滚后端：通过 storage 路由器执行写回 / 删除
  // 在 apply 阶段，storage 可能还没注册；用懒解析
  service.setBackend(
    async (uri, data) => {
      const storage = ctx.getService<StorageService>('storage');
      if (!storage) throw new Error('storage 服务不可用');
      await storage.writeFile(uri, data);
    },
    async (uri) => {
      const storage = ctx.getService<StorageService>('storage');
      if (!storage) throw new Error('storage 服务不可用');
      await storage.delete(uri);
    },
  );

  // 注入 chat 回滚所需依赖：memory + 事件发出器（懒解析 memory，但事件发出器立即可用）
  const memoryProxy: MemoryService = new Proxy({} as MemoryService, {
    get(_t, prop) {
      const m = ctx.getService<MemoryService>('memory');
      if (!m) return undefined;
      const v = (m as unknown as Record<string | symbol, unknown>)[prop as string];
      return typeof v === 'function' ? (v as Function).bind(m) : v;
    },
  });
  service.setChatRollbackDeps({
    memory: memoryProxy,
    emitMessagesDeleted: (sessionId, timestamps) => {
      ctx.emit('memory:messages-deleted', { sessionId, timestamps })
        .catch(err => logger.debug(`emit memory:messages-deleted 失败: ${(err as Error).message}`));
    },
    emitHistoryChanged: (sessionId) => {
      ctx.emit('history:changed', { sessionId })
        .catch(err => logger.debug(`emit history:changed 失败: ${(err as Error).message}`));
    },
  });

  // ──────────── 回合生命周期 ────────────
  // agent:input:before：一次 LLM 回合开始（一个用户消息进来）
  ctx.middleware('agent:input:before', async (data, next) => {
    service.beginTurn(data.message.sessionId);
    await next();
  });

  // agent:turn:after：回合结束
  ctx.middleware('agent:turn:after', async (_data, next) => {
    await next();
    await service.endTurn();
  });

  // 监听 exec 工具调用，给当前 turn 打 execUsed 标记（UI 显示 "部分未保护"）
  ctx.middleware('agent:tool:before', async (data, next) => {
    if (data.name === 'exec' || data.name === 'shell') {
      service.markExecUsed();
    }
    await next();
  });

  logger.info(`checkpoint 服务就绪 rootDir=${config.rootDir} maxFileSize=${config.maxFileSize}`);
}

export type { CheckpointService, TurnSummary, TurnManifest, CheckpointFileRecord, RollbackResult, RollbackWithChatResult } from './service.js';
