import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// 守卫（authority 的人工确认）可能等很久：期间回合被 latest-wins / 手动 abort 掐掉后，
// 用户稍后按下的 y 不该替一个已死的回合执行写操作——工具服务在守卫放行后再看一眼 signal。
// ════════════════════════════════════════════════════════════

async function setup() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.idle();
  let executed = 0;
  const host = app.bind({ tools: toolsService });
  host.tools.register({
    definition: {
      type: 'function',
      function: { name: 'probe', description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => {
      executed++;
      return 'done';
    },
  });
  const tools = host.tools.current;
  if (!tools) throw new Error('tools 服务未注册');
  return { app, tools, executed: () => executed };
}

describe('工具执行与回合中止信号', () => {
  it('守卫等待期间回合中止：守卫放行后也不执行，返回「回合已中止」', async () => {
    const { app, tools, executed } = await setup();
    try {
      let release!: () => void;
      const gate = new Promise<void>(r => (release = r));
      let seenSignal: AbortSignal | undefined;
      tools.setExecutionGuard(async g => {
        seenSignal = g.signal; // 守卫拿得到信号（透传给 authority.requestAccess）
        await gate;
        return null; // 放行（相当于用户迟到按了 y）
      });
      const ac = new AbortController();
      const pending = tools.execute('probe', {}, { sessionId: 's', platform: 'cli', signal: ac.signal });
      await new Promise(r => setTimeout(r, 0));
      ac.abort();
      release();
      const result = await pending;
      expect(seenSignal).toBe(ac.signal);
      expect(JSON.parse(result.content).error).toContain('回合已中止');
      expect(executed()).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('未中止：守卫放行后照常执行', async () => {
    const { app, tools, executed } = await setup();
    try {
      tools.setExecutionGuard(async () => null);
      const ac = new AbortController();
      const result = await tools.execute('probe', {}, { sessionId: 's', platform: 'cli', signal: ac.signal });
      expect(result.content).toBe('done');
      expect(executed()).toBe(1);
    } finally {
      await app.stop();
    }
  });
});
