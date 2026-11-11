import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type App, services } from '../../packages/core/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import { startSubtaskHub } from '../fixtures/subtask.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 子任务停用时，收尾段等已到点、正在往下走的那次到期销毁做完（写回报、删子会话）再撤回：停用落定之后不再有写入；还没到点的
// 定时器照旧清掉。删子会话卡在一道闸上，用例放行；order 记下写入开始、写完与停用落定的先后。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
});

describe('子任务停用时等在途的到期销毁', () => {
  it('到期销毁删子会话途中停用：停用等它做完才落定，之后不再有写入', async () => {
    const hub = await startSubtaskHub({ config: { idleDeleteHours: 0 } });
    apps.push(hub.app);
    const parent = await hub.sm.createSession({ name: '<父会话>' });
    const child = await hub.sm.createChildSession(parent.id, { name: '<子任务>', inputContext: '<任务>' });
    const order: string[] = [];
    const gate = deferred<void>();
    let reached = false;
    const provider = hub.app.bind({ services }).services.use.get(sessionManager) as SessionManagerService;
    const remove = provider.deleteSession.bind(provider);
    vi.spyOn(provider, 'deleteSession').mockImplementation(async (...args) => {
      order.push('写入开始');
      reached = true;
      await gate.promise;
      const result = await remove(...args);
      order.push('写完');
      return result;
    });
    await hub.turn(child.id, 'replied');
    await vi.waitFor(() => expect(reached).toBe(true));
    const disabled = hub.app.plugins.disable(subtask.name).then(() => {
      order.push('停用落定');
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    gate.resolve();
    await disabled;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual(['写入开始', '写完', '停用落定']);
  });
});
