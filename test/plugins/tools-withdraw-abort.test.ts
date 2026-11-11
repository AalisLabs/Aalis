import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin } from '../../packages/core/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 普通（不可转后台的）工具调用随这条登记撤回中止：所属插件停用时，处理函数收到的信号随之断开，中止原因写明「工具 X 已撤回
// 登记」，回执是这句话，不是裸的 AbortError。处理函数是替身，一直不回，只在收到的信号断开时按中止原因落定。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('普通工具调用随撤回登记中止', () => {
  it('处理函数在跑、所属插件停用：它收到的信号已断，回执写明撤回登记', async () => {
    const { app } = hostedApp();
    apps.push(app);
    const host = app.bind({ tools });
    await app.plugins.register(toolsPlugin, {});
    const signals: Array<AbortSignal | undefined> = [];
    const owner = definePlugin({
      name: 'zz-tool-owner',
      uses: { tools },
      apply({ tools }) {
        tools.use.register({
          definition: {
            type: 'function',
            function: { name: 'zz_plain', description: 'zz', parameters: { type: 'object', properties: {} } },
          },
          handler: (_args, ctx) =>
            new Promise<string>((_, reject) => {
              signals.push(ctx.signal);
              ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true });
            }),
        });
      },
    });
    await app.plugins.register(owner, {});
    await app.plugins.idle();

    const pending = host.tools.use.execute('zz_plain', {}, toolRequest({ sessionId: 'zz-session' }));
    await expect.poll(() => signals.length).toBe(1);
    await app.plugins.disable(owner.name);
    expect(signals[0]?.aborted).toBe(true);
    expect(JSON.parse((await pending).content)).toEqual({ error: '工具 zz_plain 已撤回登记' });
  });
});
