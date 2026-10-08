// ════════════════════════════════════════════════════════════
// 后台任务：把后台任务登记（api-tools 的 backgroundTasks）投影成协议的形状，按它的变化推给 background/watch 的连接；
// 取输出、停止，以及按会话树全部停止。开始、结束、停止与删除立即推，任务所在会话连同各级父会话的摘要一起推；
// 只有最后一行与最后输出时间变了的攒起来，每秒推一次。
// ════════════════════════════════════════════════════════════

import type { AgentService } from '@aalis/api-agent';
import type { SessionInfo } from '@aalis/api-session-manager';
import type { BackgroundTask, SessionNotificationParams } from '@aalis/api-session-protocol';
import type {
  BackgroundTaskChange,
  BackgroundTaskService,
  BackgroundTaskStatus,
  BackgroundTask as RegisteredTask,
} from '@aalis/api-tools';
import type { ServiceRef } from '@aalis/core';
import { failure, type MethodHandlers } from './connection.js';
import type { DisplayOf } from './display.js';

/** 只有最后一行与最后输出时间变了的，攒起来按这个节拍推 */
const COALESCE_MS = 1000;

interface BackgroundDeps {
  tasks: ServiceRef<BackgroundTaskService>;
  agent: ServiceRef<AgentService>;
  /** 后台任务的展示，同工具卡 */
  displayOf: DisplayOf;
  requireSession(id: string): SessionInfo;
  /** 各级子会话 */
  descendantsOf(info: SessionInfo): SessionInfo[];
  /** 这个会话有没有回合在跑 */
  isRunning(sessionId: string): boolean;
  /** 推给 watch 了后台任务的连接；没有这样的连接时不调 build */
  notify(build: () => SessionNotificationParams<'background/changed'>): void;
  /** 任务进出：所在会话连同各级父会话推摘要 */
  sessionChanged(sessionId: string): void;
}

export function createBackground(deps: BackgroundDeps) {
  /** 最近推出的状态：与它相同的变化只是最后一行与最后输出时间变了 */
  const statuses = new Map<string, BackgroundTaskStatus>();
  /** 攒着等节拍的 */
  const pending = new Map<string, RegisteredTask>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const registry = (): BackgroundTaskService => {
    const service = deps.tasks.current;
    if (!service) throw failure('unsupported', '没有后台任务登记');
    return service;
  };

  /** 协议的形状：去掉模型给的参数与工具的结果，展示按工具声明从参数解析；退出码照登记，不随工具是否还在 */
  function project({ call, result: _result, ...task }: RegisteredTask): BackgroundTask {
    const display = deps.displayOf(call.tool, call.args);
    return {
      ...task,
      call: { tool: call.tool, turnId: call.turnId, callId: call.callId },
      ...(display ? { display } : {}),
    };
  }

  function flush(): void {
    timer = undefined;
    const upserts = [...pending.values()];
    pending.clear();
    if (upserts.length > 0) deps.notify(() => ({ upserts: upserts.map(project), removes: [] }));
  }

  /** background:changed */
  function changed(change: BackgroundTaskChange): void {
    if ('removed' in change) {
      statuses.delete(change.removed);
      pending.delete(change.removed);
      deps.notify(() => ({ upserts: [], removes: [change.removed] }));
      deps.sessionChanged(change.sessionId);
      return;
    }
    const { task } = change;
    if (statuses.get(task.id) === task.status) {
      pending.set(task.id, task);
      timer ??= setTimeout(flush, COALESCE_MS);
      return;
    }
    statuses.set(task.id, task.status);
    pending.delete(task.id);
    deps.notify(() => ({ upserts: [project(task)], removes: [] }));
    deps.sessionChanged(task.sessionId);
  }

  /** 各会话在跑的后台任务数 */
  function runningBySession(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const task of deps.tasks.current?.list() ?? []) {
      if (task.status === 'running') counts.set(task.sessionId, (counts.get(task.sessionId) ?? 0) + 1);
    }
    return counts;
  }

  /** 这次工具调用转到了后台时，它的任务 id */
  function taskOf(sessionId: string, turnId: string, callId: string): string | undefined {
    return deps.tasks.current
      ?.list({ sessionId })
      .find(task => task.call.turnId === turnId && task.call.callId === callId)?.id;
  }

  /**
   * 全部停止：先停各级子会话在跑的回合（经 agent 的 abort），再停本会话与各级子会话在跑的后台任务、等它们落定。
   * 本会话自己的回合不停。子会话有回合在跑、agent 却停不了回合时回 unsupported，什么都不停
   */
  async function stopAll(sessionId: string): Promise<void> {
    const session = deps.requireSession(sessionId);
    const below = deps.descendantsOf(session);
    const running = below.filter(info => deps.isRunning(info.id));
    const agent = deps.agent.current;
    if (running.length > 0) {
      if (!agent?.abort) throw failure('unsupported', '没有能停止回合的 agent 服务，子会话的回合停不了');
      for (const info of running) agent.abort(info.id);
    }
    const service = deps.tasks.current;
    if (!service) return;
    const ids = new Set([session.id, ...below.map(info => info.id)]);
    await Promise.all(
      service
        .list()
        .filter(task => task.status === 'running' && ids.has(task.sessionId))
        .map(task => service.stop(task.id)),
    );
  }

  const handlers: Pick<
    MethodHandlers,
    'background/list' | 'background/watch' | 'background/output' | 'background/stop' | 'background/stopAll'
  > = {
    'background/list': () => ({ tasks: registry().list().map(project) }),
    'background/watch': (_params, conn) => {
      conn.watchingBackground = true;
      return {};
    },
    'background/output': ({ taskId, after }) => {
      const output = registry().output(taskId, after);
      if (!output) throw failure('not-found', `后台任务不存在：${taskId}`);
      return output;
    },
    'background/stop': async ({ taskId }) => {
      if (!(await registry().stop(taskId))) throw failure('not-found', `后台任务不存在：${taskId}`);
      return {};
    },
    'background/stopAll': async ({ sessionId }) => {
      await stopAll(sessionId);
      return {};
    },
  };

  return {
    handlers,
    changed,
    runningBySession,
    taskOf,
    /** 停用时：攒着的不再推 */
    dispose: () => clearTimeout(timer),
  };
}
