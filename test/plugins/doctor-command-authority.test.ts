import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { commands as commandsService, type ExecutionInput } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import doctorPlugin from '../../packages/plugin-doctor/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /doctor 是受限指令（等级 2，不需确认）：报告带存储根的宿主路径与插件报错原文
// （其中可能有内网地址与端口），不能让群里任何人都跑得到。
//
// 走真实裁决路径：plugin-commands + plugin-authority 的执行守卫，按用户等级判。
// 等级 1 也要被拒，钉住门槛是 2（restricted），而不是 1（sensitive）。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

async function boot() {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, commands: commandsService, authority });
  // plugin-commands 把 gateway 声明为 required；本测直接调 execute，给一份只满足「在场」的桩
  host.provide(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  await app.plugin(commandsPlugin, {});
  await app.plugin(authorityPlugin, {});
  await app.plugin(doctorPlugin, {});
  await app.plugins.idle();
  // 守卫是 authority 激活时挂上去的：它没激活，下面的「被拒」就成了无守卫时的 fail-closed，测不到声明
  for (const p of [commandsPlugin, authorityPlugin, doctorPlugin]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  return { commands: host.commands.require(), authority: host.authority.require() };
}

const input = (userId: string): ExecutionInput => ({
  args: [],
  raw: '/doctor',
  sessionId: `onebot:group:${userId}`,
  platform: 'onebot',
  userId,
  sessionType: 'group',
});

describe('/doctor 需要等级 2', () => {
  it('等级 0 与等级 1 被拒，拿不到报告', async () => {
    const { commands, authority } = await boot();
    authority.setUserLevel({ platform: 'onebot', userId: 'lv1' }, 1);

    for (const [userId, level] of [
      ['anon', 0],
      ['lv1', 1],
    ] as const) {
      const out = await commands.execute('doctor', input(userId));
      expect(out, `等级 ${level} 跑到了 /doctor`).toContain(`权限不足: "command:doctor" 需等级 2（当前 ${level}）`);
      expect(out).not.toContain('汇总');
    }
  });

  it('等级 2 放行，不需确认', async () => {
    const { commands, authority } = await boot();
    authority.setUserLevel({ platform: 'onebot', userId: 'lv2' }, 2);

    // onebot 平台没有确认通道：指令若声明了 confirm，这里会被取消而不是出报告
    const out = await commands.execute('doctor', input('lv2'));
    expect(out).toMatch(/汇总: ✓ \d+/);
  });
});
