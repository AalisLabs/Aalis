import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { type AccessConfirmHandler, authority } from '../../packages/api-authority/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { selfInitiatedActor } from '../../packages/schema-message/src/index.js';

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

async function makeApp(appConfig: Record<string, unknown> = {}) {
  // authority 读的是顶层宿主配置（restrictedPolicy / owners / confirmOverrides 等），不是插件入参
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {}, ...appConfig } as never });
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.register(authorityPlugin, {});
  await app.plugins.idle();
  return app;
}

/** 注册一个探针工具并执行，返回是否真跑到了 handler、以及返回串。 */
async function runTool(
  risk: 'safe' | 'sensitive' | 'dangerous' | undefined,
  caller: { platform: string; userId?: string; actor?: { platform: string; userId: string } },
  opts: { appConfig?: Record<string, unknown>; confirm?: 'always'; confirmHandler?: AccessConfirmHandler } = {},
): Promise<{ ran: boolean; out: string }> {
  const app = await makeApp(opts.appConfig);
  // 宿主侧按根激活取绑定接口：探针工具的登记与真实插件走同一条门面
  const host = app.bind({ tools, authority });
  let ran = false;
  host.tools.register({
    groups: ['probe'],
    ...(risk ? { risk } : {}),
    ...(opts.confirm ? { confirm: opts.confirm } : {}),
    definition: {
      type: 'function',
      function: { name: 'probe_tool', description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => {
      ran = true;
      return 'ran';
    },
  });

  if (opts.confirmHandler) host.authority.current?.setConfirmHandler('*', opts.confirmHandler);
  const svc = host.tools.current;
  if (!svc) throw new Error('tools 服务未注册');
  const out = await svc.execute('probe_tool', {}, { sessionId: 's1', ...caller });
  await app.stop();
  return { ran, out: out.content };
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
    const { ran, out } = await runTool('dangerous', { platform: 'webui', userId: 'console' });
    expect(ran).toBe(false);
    // 拒绝原因要指出「无处询问」，否则用户会以为是自己点了取消
    expect(out).toContain('没有确认通道');
  });

  it('有确认通道但被拒：只说「需确认后执行」，不误报「没有确认通道」', async () => {
    const { ran, out } = await runTool(
      'dangerous',
      { platform: 'webui', userId: 'console' },
      { confirmHandler: async () => false },
    );
    expect(ran).toBe(false);
    expect(out).toContain('需确认后执行');
    expect(out).not.toContain('没有确认通道');
  });

  it('有确认通道且确认：owner 执行 dangerous 工具', async () => {
    const { ran } = await runTool(
      'dangerous',
      { platform: 'webui', userId: 'console' },
      { confirmHandler: async () => true },
    );
    expect(ran).toBe(true);
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

  it('无主体 actor（AI 自发回合）：物理发言者是 owner 也不放行 sensitive——等级按默认、owner 判定不命中空串', async () => {
    // interval 触发复用的是恰好撞阈值的那条真人消息；trigger-policy 回填 selfInitiatedActor，
    // 授权轴据此不再让「最后发言者」（陌生人或 owner）决定 AI 自发行为的工具能力。
    const { ran, out } = await runTool('sensitive', {
      platform: 'webui',
      userId: 'console',
      actor: selfInitiatedActor('webui'),
    });
    expect(ran, '无主体 actor 被当成 owner 放行了 —— 空 userId 命中了 owner/等级查表').toBe(false);
    expect(out).toContain('error');
  });

  it('救援闸不替被覆盖的身份解围：owner 配了 restrictedPolicy 白名单、又恰好是物理发言者，无主体 actor 仍拒且不跳过 confirm', async () => {
    // 对抗审计复现（2026-09）：authorize 按无主体 actor 拒 → 守卫落进 isPreApproved(accessBase)，
    // 而 accessBase.userId 是物理发言者（owner）→ 白名单命中 → return null，连 always 档 confirm 也一并跳过。
    const appConfig = { restrictedPolicy: { allow: ['tool:*'] } };
    const selfInitiated = await runTool(
      'dangerous',
      { platform: 'webui', userId: 'console', actor: selfInitiatedActor('webui') },
      { appConfig, confirm: 'always' },
    );
    expect(selfInitiated.ran, '白名单借物理发言者（owner）身份替无主体回合解围').toBe(false);
    // 对照：同一配置下 owner 本人（无 actor 覆盖）走授权轴放行 → always 档无确认通道 → 拒，行为不变
    const ownerSelf = await runTool(
      'dangerous',
      { platform: 'webui', userId: 'console' },
      { appConfig, confirm: 'always' },
    );
    expect(ownerSelf.ran).toBe(false);
    expect(ownerSelf.out).toContain('需确认');
    // 对照：白名单对 owner 本人的 sensitive（无 confirm）照常放行——救援闸本身没被封死
    const ownerSensitive = await runTool('sensitive', { platform: 'webui', userId: 'console' }, { appConfig });
    expect(ownerSensitive.ran).toBe(true);
  });
});
