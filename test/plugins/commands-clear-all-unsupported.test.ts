import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BoundCommands, commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// clearAll 是记忆后端的可选方法。后端没实现时，/clear all 曾静默退化为只清当前会话，
// 还回报「当前会话消息历史已清空」：用户要的是全局清空，得到的是另一件事，且被报成成功。
// 之后改成回报失败，但各插件的 memory:clear 中间件先于消息清理运行，已按全局清掉摘要、待办、
// 附件等，留下「消息还在、其余已清」的半截状态。现在消息历史清不了（后端没有 clearAll，
// 或记忆服务缺席）就整条不执行；不含 context 的类型照常清理；会话级 /clear 不受影响。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 记忆后端替身：只有 clearSession，没有 clearAll；withMemory=false 时不提供记忆服务 */
async function world(withMemory = true) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, commands: commandsService });
  const clearSession = vi.fn(async (_sessionId: string) => {});
  if (withMemory) host.provide(memory, { clearSession } as unknown as MemoryService);
  host.provide(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  // 记下每次 memory:clear 中间件被调用时的 scope：代表其它插件的清理是否已经发生
  const middlewareRuns: string[] = [];
  await app.plugin(
    definePlugin({
      name: 'clear-probe',
      uses: { hooks },
      apply({ hooks }) {
        hooks.middleware('memory:clear', async (data, next) => {
          middlewareRuns.push(data.scope);
          await next();
        });
      },
    }),
  );
  await app.plugin(commandsPlugin, {});
  await app.plugins.idle();

  async function run(name: 'clear' | 'clear.all', type?: string[]): Promise<string> {
    const cmd = (host.commands as BoundCommands).current?.getAll().find(c => c.name === name);
    if (!cmd?.handler) throw new Error(`/${name} 未注册`);
    const out = await cmd.handler({
      session: { sessionId: 's-cur', platform: 'webui', userId: 'u1', sessionType: 'private', raw: `/${name}` },
      options: type ? { type } : {},
    });
    return String(out);
  }
  return { run, clearSession, middlewareRuns };
}

describe('/clear all：记忆后端不支持 clearAll', () => {
  it('含 context（含不带类型）：整条拒绝，不清任何会话，其它类型的中间件也不运行', async () => {
    const { run, clearSession, middlewareRuns } = await world();
    for (const type of [['context'], ['context', 'vector'], undefined]) {
      expect(await run('clear.all', type), JSON.stringify(type)).toBe(
        '⚠ 记忆后端不支持全局清空消息历史，本次未清理任何内容。可用 -t 指定 context 以外的类型单独清理。',
      );
    }
    expect(clearSession).not.toHaveBeenCalled();
    expect(middlewareRuns).toEqual([]);
  });

  it('不含 context 的类型照常全局清理', async () => {
    const { run, middlewareRuns } = await world();
    await run('clear.all', ['vector']);
    expect(middlewareRuns).toEqual(['all']);
  });

  it('会话级 /clear 照常清当前会话', async () => {
    const { run, clearSession, middlewareRuns } = await world();
    expect(await run('clear', ['context'])).toBe('✅ 当前会话消息历史已清空');
    expect(clearSession).toHaveBeenCalledWith('s-cur');
    expect(middlewareRuns).toEqual(['session']);
  });
});

describe('/clear：记忆服务缺席', () => {
  it('含 context：整条拒绝，其它类型的中间件不运行；不含 context 的类型照常清理', async () => {
    const { run, middlewareRuns } = await world(false);
    for (const [name, type] of [
      ['clear', undefined],
      ['clear', ['context']],
      ['clear.all', undefined],
    ] as const) {
      expect(await run(name, type ? [...type] : undefined)).toBe('⚠ 记忆服务不可用，本次未清理任何内容。');
    }
    expect(middlewareRuns).toEqual([]);

    await run('clear', ['vector']);
    expect(middlewareRuns).toEqual(['session']);
  });
});
