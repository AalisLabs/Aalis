import { describe, expect, it } from 'vitest';
import type { ExecutionGuardContext } from '../../packages/api-authority/src/index.js';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import authority from '../../packages/plugin-authority/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// actor 的守卫侧接线（tools → guard → authority）——与
// agent-actor-consumption（agent → callCtx）成对，合起来钉死整条消费链。
//
//   1. plugin-tools 把 callCtx.actor 原样交给守卫，platform 保持会话值
//      （confirm 通道按 platform 选路，覆盖即错发）；
//   2. plugin-authority 的等级裁决按 actor：物理匿名 + actor=owner 能执行
//      sensitive 工具；无 actor 的物理匿名不能——即等级真的「跟人走」。
// ════════════════════════════════════════════════════════════

describe('tools 守卫的 actor 接线', () => {
  it('plugin-tools 透传 actor 给守卫，platform 保持会话值', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    await app.plugins.register(toolsPlugin, {});
    await app.plugins.idle();
    const { tools } = app.bind({ tools: toolsService });
    const svc = tools.current;
    if (!svc) throw new Error('tools 服务未注册');
    let seen: ExecutionGuardContext | undefined;
    svc.setExecutionGuard(async g => {
      seen = g;
      return null;
    });
    tools.register({
      definition: {
        type: 'function',
        function: { name: 'probe_g', description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => 'ok',
    });
    await svc.execute(
      'probe_g',
      {},
      {
        sessionId: 's1',
        platform: 'onebot',
        actor: { platform: 'webui', userId: 'console' },
      },
    );
    await app.stop();
    expect(seen?.actor).toEqual({ platform: 'webui', userId: 'console' });
    expect(seen?.platform, 'confirm 选路依赖会话平台，不得被 actor 覆盖').toBe('onebot');
  });

  it('authority 等级裁决按 actor：物理匿名 + owner actor 可执行 sensitive 工具，无 actor 则不能', async () => {
    const run = async (actor?: { platform: string; userId: string }): Promise<boolean> => {
      // authority 裁决要读配置文档（owners 等），宿主经 host-config 提供
      const { app } = hostedApp();
      await app.plugins.register(toolsPlugin, {});
      await app.plugins.register(authority, {});
      await app.plugins.idle();
      let ran = false;
      const { tools } = app.bind({ tools: toolsService });
      tools.register({
        risk: 'sensitive',
        definition: {
          type: 'function',
          function: { name: 'probe_s', description: '探针', parameters: { type: 'object', properties: {} } },
        },
        handler: async () => {
          ran = true;
          return 'ok';
        },
      });
      const svc = tools.current;
      if (!svc) throw new Error('tools 服务未注册');
      await svc.execute('probe_s', {}, { sessionId: 's1', platform: 'onebot', ...(actor ? { actor } : {}) });
      await app.stop();
      return ran;
    };
    // cli:console 是 authority-manager 硬编码的 owner 快速通道（webui/cli + console）
    expect(await run({ platform: 'cli', userId: 'console' }), 'owner actor 应放行').toBe(true);
    expect(await run(undefined), '物理匿名无 actor 应被挡').toBe(false);
  });
});
