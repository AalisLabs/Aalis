import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { CommandService, ExecutionInput } from '../../packages/api-commands/src/index.js';
import * as authorityModule from '../../packages/plugin-authority/src/index.js';
import * as commandsModule from '../../packages/plugin-commands/src/index.js';

// ════════════════════════════════════════════════════════════
// authority 执行守卫 —— 端到端（装上去之后真的拦不拦）
//
// 补的是一个实测确认的**假绿**：把 `plugin-authority/src/index.ts` 里整个守卫闭包
// 改成 `return null`（即全部 fail-open），全量 1188 个测试照样全绿；把
// `authority-manager.ts` 的 `userId === 'console'` owner 快速通道删掉，同样全绿。
//
// 原因是覆盖面的形状：`authorize()` 有密集单测，但**把它接到 commands/tools 上的那段闭包
// 零断言**。单测证明的是「裁决函数算得对」，不是「裁决函数真的被挂上去了」——
// 而历史上出事的恰恰是后者（挂错轴、挂漏路径、被 skipConfirm 整块绕过）。
//
// 所以这里不测 authorize 的数学，只测三件接线事实：
//   1. restricted 指令对匿名用户真的执行不到
//   2. owner 真的能执行
//   3. public 指令不受影响（守卫没有误伤）
// ════════════════════════════════════════════════════════════

async function makeApp() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.ctx.useModule(commandsModule as never, {});
  await app.ctx.useModule(authorityModule as never, {});
  await app.plugins.idle();
  const commands = app.ctx.getService<CommandService>('commands');
  if (!commands) throw new Error('commands 服务未注册');
  return { app, commands };
}

const input = (over: Partial<ExecutionInput> = {}): ExecutionInput => ({
  args: [],
  raw: '/probe',
  sessionId: 's1',
  platform: 'onebot',
  userId: 'anon',
  sessionType: 'private',
  ...over,
});

describe('authority 执行守卫真的挂在 commands 上', () => {
  it('restricted 指令：匿名用户执行不到（守卫 fail-open 时此断言会失败）', async () => {
    const { app, commands } = await makeApp();
    let ran = false;
    commands.command('probe', '探针', { visibility: 'restricted' }).action(async () => {
      ran = true;
      return 'ran';
    });

    const out = await commands.execute('probe', input());
    await app.stop();

    expect(ran, 'restricted 指令被匿名用户执行了 —— 守卫没生效').toBe(false);
    expect(out, '应返回拒绝文案而非 undefined').toBeTruthy();
  });

  it('restricted 指令：owner（webui:console）可以执行', async () => {
    const { app, commands } = await makeApp();
    let ran = false;
    commands.command('probe', '探针', { visibility: 'restricted' }).action(async () => {
      ran = true;
      return 'ran';
    });

    await commands.execute('probe', input({ platform: 'webui', userId: 'console' }));
    await app.stop();

    expect(ran, 'owner 被守卫误拦 —— 权限系统把自己锁死了').toBe(true);
  });

  it('public 指令：匿名用户照常执行（守卫不得误伤）', async () => {
    const { app, commands } = await makeApp();
    let ran = false;
    commands.command('open', '公开指令').action(async () => {
      ran = true;
      return 'ok';
    });

    const out = await commands.execute('open', input({ raw: '/open' }));
    await app.stop();

    expect(ran, 'public 指令被误拦').toBe(true);
    expect(out).toBe('ok');
  });
});
