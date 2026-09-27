import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BoundCommands, commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /clear 在跑 memory:clear 中间件链之前预检记忆后端（清不了消息历史就整条不执行），链上的中间件
// 可能要等一阵（在途落库、向量清空）。消息历史曾用预检时取到的实例清理：这期间 memory 胜者换了，
// 旧实例还活着时清的是旧库、回执照样报成功，新胜者里的消息还在；旧实例已关时报失败。
// 现在预检只决定执行与否，消息历史按链跑完时的胜者清理；那时记忆服务已下线，或全局清理时换上的
// 后端不支持 clearAll，就报消息历史清空失败。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function makeBackend(withClearAll: boolean) {
  return {
    clearSession: vi.fn(async (_sessionId: string) => {}),
    ...(withClearAll ? { clearAll: vi.fn(async () => {}) } : {}),
  };
}

function memoryProvider(name: string, backend: ReturnType<typeof makeBackend>, priority: number) {
  return definePlugin({
    name,
    provides: [memory],
    uses: { provide },
    apply({ provide }) {
      provide(memory, backend as unknown as MemoryService, { priority });
    },
  });
}

/** 装 plugin-commands、一个记忆后端 mem-a，以及一个把 memory:clear 链挂住、直到放行的中间件 */
async function world(memA: ReturnType<typeof makeBackend>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, commands: commandsService });
  host.provide(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  await app.plugin(memoryProvider('mem-a', memA, 0));

  let reached!: () => void;
  const chainReached = new Promise<void>(resolve => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  await app.plugin(
    definePlugin({
      name: 'clear-gate',
      uses: { hooks },
      apply({ hooks }) {
        hooks.middleware('memory:clear', async (_data, next) => {
          reached();
          await gate;
          await next();
        });
      },
    }),
  );
  await app.plugin(commandsPlugin, {});
  await app.plugins.idle();

  /** 执行 /clear 或 /clear all；链挂住期间调 during 换记忆后端，再放行 */
  async function runSwitching(name: 'clear' | 'clear.all', during: () => Promise<unknown>): Promise<string> {
    const cmd = (host.commands as BoundCommands).current?.getAll().find(c => c.name === name);
    if (!cmd?.handler) throw new Error(`/${name} 未注册`);
    const out = cmd.handler({
      session: { sessionId: 's-cur', platform: 'webui', userId: 'u1', sessionType: 'private', raw: `/${name}` },
      options: { type: ['context'] },
    });
    await chainReached;
    await during();
    await app.plugins.idle();
    release();
    return String(await out);
  }
  return { app, runSwitching };
}

describe('/clear：中间件链运行期间记忆后端更换', () => {
  it('旧后端仍在、更高优先级的后端上线：清新胜者，不清旧后端', async () => {
    const memA = makeBackend(true);
    const memB = makeBackend(true);
    const { app, runSwitching } = await world(memA);
    const out = await runSwitching('clear', () => app.plugin(memoryProvider('mem-b', memB, 10)));
    expect(out).toBe('✅ 当前会话消息历史已清空');
    expect(memB.clearSession).toHaveBeenCalledWith('s-cur');
    expect(memA.clearSession).not.toHaveBeenCalled();
  });

  it('记忆服务下线：报消息历史清空失败，不调用已下线的旧后端', async () => {
    const memA = makeBackend(true);
    const { app, runSwitching } = await world(memA);
    const out = await runSwitching('clear', () => app.plugins.unload('mem-a'));
    expect(out).toBe('⚠ 清空失败: 记忆服务在清理期间下线');
    expect(memA.clearSession).not.toHaveBeenCalled();
  });

  it('/clear all 时换上的后端不支持 clearAll：报失败，新旧后端都不清', async () => {
    const memA = makeBackend(true);
    const memB = makeBackend(false);
    const { app, runSwitching } = await world(memA);
    const out = await runSwitching('clear.all', () => app.plugin(memoryProvider('mem-b', memB, 10)));
    expect(out).toBe('⚠ 清空失败: 清理期间换上的记忆后端不支持全局清空');
    expect(memA.clearAll).not.toHaveBeenCalled();
    expect(memB.clearSession).not.toHaveBeenCalled();
  });
});
