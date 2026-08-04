import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { ToolService } from '../../packages/api-tools/src/index.js';
import { useToolService } from '../../packages/api-tools/src/index.js';
import * as authorityModule from '../../packages/plugin-authority/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// authority 执行守卫 —— tools 侧端到端
//
// 与 authority-guard-e2e.test.ts（commands 侧）成对。补它是因为实测发现：
// 把 plugin-authority 里 **tools 侧**的 `setExecutionGuard` 注入整块摘掉，
// 1191 个用例零转红 —— 而 AI 调 shell.exec / 文件写删这类危险工具走的正是这半，
// commands 那半只覆盖用户手敲的斜杠指令。
//
// 这里同样不测 authorize 的数学（那有密集单测），只测三件接线事实：
//   1. restricted 工具对匿名/低等级用户执行不到
//   2. owner 能执行
//   3. public 工具不受影响（守卫没误伤）
// 另加一条：工具的身份取自 `ToolCallContext`，而 scheduler 触发的 AI 正是靠它把
// **创建者**的等级带过来的（plugin-agent 的 `incoming.actor?.userId ?? incoming.userId`）。
// 那条链在 commands 侧已被钉住，这里钉 tools 侧的入参形状。
// ════════════════════════════════════════════════════════════

async function makeApp() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(toolsModule as never, {});
  await app.ctx.useModule(authorityModule as never, {});
  await app.plugins.idle();
  return app;
}

/** 注册一个探针工具并执行，返回是否真跑到了 handler、以及返回串。 */
async function runTool(
  risk: 'safe' | 'sensitive' | 'dangerous' | undefined,
  caller: { platform: string; userId?: string },
): Promise<{ ran: boolean; out: string }> {
  const app = await makeApp();
  let ran = false;
  useToolService(app.ctx).register({
    groups: ['probe'],
    ...(risk ? { risk } : {}),
    definition: {
      type: 'function',
      function: { name: 'probe_tool', description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => {
      ran = true;
      return 'ran';
    },
  });

  const svc = app.ctx.getService<ToolService>('tools');
  if (!svc) throw new Error('tools 服务未注册');
  const out = await svc.execute('probe_tool', {}, { sessionId: 's1', ...caller });
  await app.stop();
  return { ran, out: String(out) };
}

describe('authority 执行守卫真的挂在 tools 上', () => {
  it('dangerous 工具：匿名用户执行不到（守卫 fail-open 时此断言会失败）', async () => {
    const { ran, out } = await runTool('dangerous', { platform: 'onebot', userId: 'anon' });
    expect(ran, 'dangerous 工具被 level-0 用户执行了 —— tools 侧守卫没生效').toBe(false);
    expect(out, '应返回拒绝信息').toContain('error');
  });

  it('sensitive 工具：匿名用户同样执行不到（挡 level-0 正是它的用途）', async () => {
    const { ran } = await runTool('sensitive', { platform: 'onebot', userId: 'anon' });
    expect(ran).toBe(false);
  });

  it('sensitive 工具：owner 可以执行（授权轴放行，且该档不附带确认）', async () => {
    const { ran } = await runTool('sensitive', { platform: 'webui', userId: 'console' });
    expect(ran, 'owner 被守卫误拦 —— 权限系统把自己锁死了').toBe(true);
  });

  it('dangerous 工具：**owner 也过不去**，因为该档附带 confirm 而本实例无确认通道', async () => {
    // 这不是缺陷，是设计：确认轴对 owner 同样生效（守卫注释：「owner 也吃，防注入借权」）。
    // 无 confirmHandler 时 requestAccess 直接 false —— cron 等无人值守上下文要靠
    // skipConfirm 显式豁免，而不是靠 owner 身份自动绕过。
    // 写成断言是为了钉住这条语义：哪天有人让 owner 自动跳过确认，这里会红。
    const { ran } = await runTool('dangerous', { platform: 'webui', userId: 'console' });
    expect(ran).toBe(false);
  });

  it('未声明 risk 的工具对普通用户照常可用（守卫不得误伤 public）', async () => {
    const { ran, out } = await runTool(undefined, { platform: 'onebot', userId: 'alice' });
    expect(ran, 'public 工具被误拦').toBe(true);
    expect(out).toBe('ran');
  });

  it('身份取自 ToolCallContext —— 换个身份结论就变（证明守卫读的是入参不是全局态）', async () => {
    const anon = await runTool('sensitive', { platform: 'onebot', userId: 'anon' });
    const owner = await runTool('sensitive', { platform: 'webui', userId: 'console' });
    expect([anon.ran, owner.ran], '两种身份得到同一结论 —— 守卫没在读 callCtx').toEqual([false, true]);
  });
});
