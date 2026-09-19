import type {} from '@aalis/api-agent'; // 加载 agent:* 钩子的 HookContextMap augmentation
import type { MemoryService } from '@aalis/api-memory';
import type { StorageService } from '@aalis/api-storage';
import { createStorageGateway } from '@aalis/api-storage';
import type {} from '@aalis/api-webui'; // PluginModule.actions 槽位的 merging 可见性
import type { Context, PluginModule } from '@aalis/core';
import { defineService } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { type CheckpointService, CheckpointServiceImpl, resolveConfig } from './service.js';

// ════════════════════════════════════════════════════════════
// plugin-checkpoint — 文件操作快照与回滚
// ════════════════════════════════════════════════════════════

export const name = '@aalis/plugin-checkpoint';
export const displayName = '回滚检查点';
export const subsystem = 'scheduler';
export const provides = ['checkpoint'];
/**
 * storage 是硬依赖：本插件的快照/manifest 全部经 storage 落盘。
 *
 * 不声明的话 topoSortByDeps 只按 requiredDeps 建边、两者 inDegree 均为 0，拆卸序退化成
 * 注册序的逆序——storage 可能先于 checkpoint 被 retire，于是 onDispose 里的 flushAll 调
 * storage.writeFile 时 entry 已被摘除，在飞回合的 manifest 落不了盘。
 * 该保证只在 app.stop() 的整体拓扑逆序成立；单独禁用/热重载 storage 时 flushAll 会落空
 * （回合 blob 在写点已落盘，丢的只是在飞回合的 manifest）。
 */
export const inject = {
  required: ['storage'],
};

export const configSchema: ConfigSchema = {
  rootDir: {
    type: 'string',
    label: '存储目录',
    description:
      '存储 URI（默认 data:/checkpoints），也兼容裸名/相对路径。所有 checkpoint blob 和 manifest 写入此位置。',
    default: 'data:/checkpoints',
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
  scopes: {
    type: 'multiselect',
    label: '启用作用域',
    description:
      '仅在匹配下列 platform:sessionType 的会话中参与 turn 生命周期（建 checkpoint）。格式举例：`webui:*` / `onebot:group` / `*` 表示全部。默认仅 `webui:*`：onebot 等聊天平台不会为每条消息创建 checkpoint。留空数组 = 禁用 checkpoint（仅允许手动 rollback）。',
    options: [
      { label: '所有会话', value: '*' },
      { label: 'WebUI 会话（推荐）', value: 'webui:*' },
      { label: 'OneBot 群聊', value: 'onebot:group' },
      { label: 'OneBot 私聊', value: 'onebot:private' },
      { label: 'CLI', value: 'cli:*' },
    ],
    default: ['webui:*'],
  },
};

// ──────────── Plugin actions (供 WebUI 调用) ────────────

export const actions: PluginModule['actions'] = {
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
    if (!svc)
      return {
        ok: false,
        errors: [{ uri: '', reason: 'checkpoint 服务未启用' }],
        deletedMessages: 0,
        chatDeleted: false,
      };
    const sessionId = args.sessionId as string;
    const turnId = args.turnId as string;
    if (!sessionId || !turnId)
      return {
        ok: false,
        errors: [{ uri: '', reason: '缺少 sessionId 或 turnId' }],
        deletedMessages: 0,
        chatDeleted: false,
      };
    return svc.rollbackWithChat(sessionId, turnId);
  },
};

// ──────────── 插件入口 ────────────

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('checkpoint');
  const storage = createStorageGateway(ctx);

  const service = new CheckpointServiceImpl(config, logger, storage);
  ctx.provide('checkpoint', service);

  // 注入回滚后端：通过 storage gateway helper 按 URI 路由到各 root
  // 在 apply 阶段，storage 可能还没注册；gateway 本身是闭包，调用时才枚举 entry

  service.setBackend(
    async (uri, data) => {
      if (ctx.getAllServices<StorageService>('storage').length === 0) throw new Error('storage 服务不可用');
      await storage.writeFile(uri, data);
    },
    async uri => {
      if (ctx.getAllServices<StorageService>('storage').length === 0) throw new Error('storage 服务不可用');
      await storage.delete(uri);
    },
    async (fromUri, toUri) => {
      if (ctx.getAllServices<StorageService>('storage').length === 0) throw new Error('storage 服务不可用');
      if (!storage.move) throw new Error('storage 不支持 move');
      await storage.move(fromUri, toUri);
    },
  );

  // 注入 chat 回滚所需依赖：memory + 事件发出器（懒解析 memory，但事件发出器立即可用）
  const memoryProxy: MemoryService = new Proxy({} as MemoryService, {
    get(_t, prop) {
      const m = ctx.getService<MemoryService>('memory');
      if (!m) return undefined;
      const v = (m as unknown as Record<string | symbol, unknown>)[prop as string];
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(m) : v;
    },
  });
  service.setChatRollbackDeps({
    memory: memoryProxy,
    emitMessagesDeleted: (sessionId, timestamps) => {
      ctx
        .emit('memory:messages-deleted', { sessionId, timestamps })
        .catch(err => logger.debug(`emit memory:messages-deleted 失败: ${(err as Error).message}`));
    },
    emitHistoryChanged: sessionId => {
      ctx
        .emit('history:changed', { sessionId })
        .catch(err => logger.debug(`emit history:changed 失败: ${(err as Error).message}`));
    },
  });

  // ──────────── 回合生命周期 ────────────
  // agent:input:before：一次 LLM 回合开始（一个用户消息进来）
  // 仅对配置 scopes 匹配的会话参与回合生命周期，避免 onebot 等聊天平台为每条消息都创建空 checkpoint。
  const isScopeEnabled = (platform?: string, sessionType?: string): boolean => {
    if (config.scopes.length === 0) return false;
    const p = platform ?? '';
    const t = sessionType ?? '';
    for (const raw of config.scopes) {
      const [sp = '*', st = '*'] = raw.includes(':') ? raw.split(':', 2) : [raw, '*'];
      const platOk = sp === '*' || sp === '' || sp === p;
      const typeOk = st === '*' || st === '' || st === t;
      if (platOk && typeOk) return true;
    }
    return false;
  };

  ctx.middleware('agent:input:before', async (data, next) => {
    if (isScopeEnabled(data.message.platform, data.message.sessionType)) {
      service.beginTurn(data.message.sessionId);
    }
    await next();
  });

  // agent:turn:after：回合结束（按 sessionId 提交该会话回合；无对应回合则直接 return）
  ctx.middleware('agent:turn:after', async (data, next) => {
    await next();
    await service.endTurn(data.sessionId);
  });

  // 监听命令类工具调用，给该会话当前 turn 打 execUsed 标记（UI 显示 "部分未保护"）：
  // 这些工具的副作用（子进程改磁盘、装包、起服务）不经 storage，快照覆盖不到。
  ctx.middleware('agent:tool:before', async (data, next) => {
    const name = data.name;
    if (name === 'exec' || name === 'exec_background' || name.startsWith('run_')) {
      service.markExecUsed(data.toolCallContext.sessionId);
    }
    await next();
  });

  // ──────────── 参与统一的 memory:clear ────────────
  // /clear 与 session-manager.deleteSession 都通过 memory:clear hook 编排，
  // 之前 checkpoint 没监听，导致 checkpoint 目录无人清理，长期泄漏。
  ctx.middleware(
    'memory:clear',
    async (
      data: {
        scope: 'session' | 'all';
        types?: string[];
        sessionId?: string;
        results: Array<{ source: string; success: boolean; message: string }>;
      },
      next,
    ) => {
      if (data.types && !data.types.includes('checkpoint')) {
        await next();
        return;
      }
      try {
        if (data.scope === 'all') {
          const n = await service.clearAll();
          data.results.push({
            source: 'checkpoint',
            success: true,
            message: `所有 checkpoint 已清空（${n} 个 session）`,
          });
        } else if (data.sessionId) {
          const n = await service.clearSession(data.sessionId);
          data.results.push({
            source: 'checkpoint',
            success: true,
            message: n > 0 ? `当前会话 checkpoint 已清空（${n} 个 turn）` : '当前会话无 checkpoint',
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        data.results.push({ source: 'checkpoint', success: false, message: `checkpoint 清空失败: ${msg}` });
      }
      await next();
    },
  );

  // 进程退出前提交所有未结束的活跃回合，避免崩溃/重载时丢失（per-session 化后不再有"任意新回合 flush 旧回合"的兜底）
  ctx.onDispose(() => service.flushAll());

  logger.info(
    `checkpoint 服务就绪 rootUri=${config.rootUri} maxFileSize=${config.maxFileSize} scopes=${config.scopes.join('|') || '<空>'}`,
  );
}

export type {
  CheckpointFileRecord,
  CheckpointService,
  RollbackResult,
  RollbackWithChatResult,
  TurnManifest,
  TurnSummary,
} from './service.js';

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    checkpoint: import('./service.js').CheckpointService;
  }
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const checkpoint = defineService<import('./service.js').CheckpointService>('checkpoint');
