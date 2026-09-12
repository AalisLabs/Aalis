import { describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as userProfileModule from '../../packages/plugin-user-profile/src/index.js';

// ════════════════════════════════════════════════════════════
// inbound:message:archived 上的 witness 路径是 interactionCount / lastInteractionAt
// 的唯一写点。它曾被 relationIncrementWitness > 0 设门：把「旁观加分」关掉的配置
// 连带关掉计数与时戳 → relationScore 只升不降（衰减基准恒为空）、互动次数恒 0、
// 最近互动排序全 0。计数与加分必须解耦。
// ════════════════════════════════════════════════════════════

const PROFILE_NS = 'user:profile';

async function setup(config: Record<string, unknown>) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  app.ctx.provide('llm', { chat: async () => ({ content: '' }) });
  await app.ctx.useModule(memoryInMemoryModule);
  const memory = app.ctx.getService<MemoryService>('memory');
  if (!memory) throw new Error('memory 服务未就绪');
  await app.ctx.useModule(userProfileModule, { extractEveryNMessages: 0, ...config });
  await app.plugins.idle();
  return { app, memory };
}

async function inbound(app: App, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await app.ctx.emit('inbound:message:archived', {
      sessionId: 'onebot:g1',
      incoming: { userId: 'u1', platform: 'onebot', nickname: '小明' },
    } as never);
  }
  await new Promise<void>(r => setTimeout(r, 20));
}

describe('plugin-user-profile: 旁观计数与旁观加分解耦', () => {
  it('relationIncrementWitness=0：不加分，但互动次数与最近互动时戳照记', async () => {
    const { app, memory } = await setup({ relationIncrementWitness: 0 });
    await inbound(app, 3);

    const profile = await memory.getMetadata(PROFILE_NS, 'onebot:u1');
    expect(profile, '档案应被写出（计数写点必须落）').toBeTruthy();
    expect(profile?.interactionCount, '互动次数不该恒 0').toBe(3);
    expect(Number(profile?.lastInteractionAt ?? 0), '最近互动时戳不该为 0').toBeGreaterThan(0);
    expect(Number(profile?.relationScore ?? -1), '增量为 0 时确实不加分').toBe(0);
    await app.stop();
  });

  it('relationIncrementWitness>0：照旧加分且计数递增', async () => {
    const { app, memory } = await setup({ relationIncrementWitness: 0.1 });
    await inbound(app, 2);

    const profile = await memory.getMetadata(PROFILE_NS, 'onebot:u1');
    expect(profile?.interactionCount).toBe(2);
    expect(Number(profile?.relationScore ?? 0)).toBeCloseTo(0.2, 5);
    await app.stop();
  });
});
