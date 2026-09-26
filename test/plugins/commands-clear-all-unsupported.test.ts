import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BoundCommands, commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// clearAll 是记忆后端的可选方法。后端没实现时，/clear all 曾静默退化为只清当前会话，
// 还回报「当前会话消息历史已清空」：用户要的是全局清空，得到的是另一件事，且被报成成功。
// 改后回一条失败结果，不清任何会话；会话级 /clear 不受影响。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 记忆后端替身：只有 clearSession，没有 clearAll */
async function world() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, commands: commandsService });
  const clearSession = vi.fn(async (_sessionId: string) => {});
  host.provide(memory, { clearSession } as unknown as MemoryService);
  host.provide(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  await app.plugin(commandsPlugin, {});
  await app.plugins.idle();

  async function run(name: 'clear' | 'clear.all'): Promise<string> {
    const cmd = (host.commands as BoundCommands).current?.getAll().find(c => c.name === name);
    if (!cmd?.handler) throw new Error(`/${name} 未注册`);
    const out = await cmd.handler({
      session: { sessionId: 's-cur', platform: 'webui', userId: 'u1', sessionType: 'private', raw: `/${name}` },
      options: { type: ['context'] },
    });
    return String(out);
  }
  return { run, clearSession };
}

describe('/clear all：记忆后端不支持 clearAll', () => {
  it('回报失败，不清任何会话', async () => {
    const { run, clearSession } = await world();
    expect(await run('clear.all')).toBe('⚠ 记忆后端不支持全局清空，消息历史未清理');
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('会话级 /clear 照常清当前会话', async () => {
    const { run, clearSession } = await world();
    expect(await run('clear')).toBe('✅ 当前会话消息历史已清空');
    expect(clearSession).toHaveBeenCalledWith('s-cur');
  });
});
