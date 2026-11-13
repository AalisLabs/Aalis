import { describe, expect, it } from 'vitest';
import type { ExecutionGuardContext } from '../../packages/api-authority/src/index.js';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import authority from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideEvents, registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 守卫上下文的参与者（tools、commands → guard → authority）：
//   1. plugin-tools 把这次调用的参与者原样交给守卫，platform 保持会话值（审批的发起类别等按会话平台判）；
//   2. plugin-commands 的参与者是发出者本人（指令一路已经把授权身份并进 platform 与 userId），没有账号的是无主体；
//   3. plugin-authority 的等级裁决按参与者：物理发言者匿名、参与者是 owner 的能执行门槛 1 的工具，参与者是无主体的不能。
// ════════════════════════════════════════════════════════════

describe('守卫上下文的参与者', () => {
  it('plugin-tools 把参与者交给守卫，platform 保持会话值', async () => {
    const app = new App({ logLevel: 'error' });
    provideEvents(app);
    await app.plugins.register(toolsPlugin, {});
    await app.plugins.idle();
    const { tools } = app.bind({ tools: toolsService });
    let seen: ExecutionGuardContext | undefined;
    tools.use.setExecutionGuard(async g => {
      seen = g;
      return { ok: true };
    });
    tools.use.register({
      definition: {
        type: 'function',
        function: { name: 'probe_g', description: '探针', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => 'ok',
    });
    const participants = [
      { platform: 'webui', userId: 'console' },
      { platform: 'onebot', userId: '30001' },
    ];
    await tools.use.execute('probe_g', {}, { sessionId: 's1', platform: 'onebot', participants });
    await app.stop();
    expect(seen?.participants).toEqual(participants);
    expect(seen?.platform, '审批的发起类别等按会话平台判，不得被参与者覆盖').toBe('onebot');
  });

  it('plugin-commands：参与者是发出者本人，没有账号的是无主体；放行不带批的人', async () => {
    const app = new App({ logLevel: 'error' });
    await registerHubs(app);
    await app.plugin(gatewayPlugin);
    await app.plugin(commandsPlugin);
    await app.plugins.idle();
    const { commands } = app.bind({ commands: commandsService });
    const seen: ExecutionGuardContext[] = [];
    commands.use.setExecutionGuard(async g => {
      seen.push(g);
      return { ok: true };
    });
    commands.use.command('probe', '探针').action(async () => 'ok');
    const input = { sessionId: 's1', platform: 'onebot', args: [], raw: '/probe' };
    expect(await commands.use.execute('probe', { ...input, userId: '30001' })).toBe('ok');
    expect(await commands.use.execute('probe', input)).toBe('ok');
    await app.stop();
    expect(seen.map(g => g.participants)).toEqual([
      [{ platform: 'onebot', userId: '30001' }],
      [{ platform: 'onebot', userId: '' }],
    ]);
  });

  it('等级裁决按参与者：物理发言者匿名、参与者是 owner 的可执行门槛 1 的工具，参与者是无主体的不能', async () => {
    const run = async (participant: { platform: string; userId: string }): Promise<boolean> => {
      // authority 裁决要读配置文档（owners 等），宿主经 host-config 提供
      const { app } = hostedApp();
      provideEvents(app);
      await app.plugins.register(toolsPlugin, {});
      await app.plugins.register(authority, {});
      await app.plugins.idle();
      let ran = false;
      const { tools } = app.bind({ tools: toolsService });
      tools.use.register({
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
      await tools.use.execute('probe_s', {}, { sessionId: 's1', platform: 'onebot', participants: [participant] });
      await app.stop();
      return ran;
    };
    // cli:console 是 authority-manager 硬编码的 owner 快速通道（webui/cli + console）
    expect(await run({ platform: 'cli', userId: 'console' }), '参与者是 owner 应放行').toBe(true);
    expect(await run(selfInitiatedActor('onebot')), '参与者是无主体应被挡').toBe(false);
  });
});
