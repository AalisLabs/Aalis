import { events, type Logger, provide } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { commands as commandsService, type ExecutionInput } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import {
  assertAddressesSafe,
  assertPortAllowed,
  setNetworkPolicy,
} from '../../packages/util-network-guard/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

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
  const { app } = hostedApp();
  await registerHubs(app);
  // 宿主侧按根激活取绑定接口：探针指令的登记与真实插件走同一条门面
  const host = app.bind({ provide, commands: commandsService });
  // plugin-commands 把 gateway 声明为 required（指令结果经它出站）。本测直接调 execute，
  // 不走出站管道，给一份只满足「在场」的桩即可让它过激活闸。
  host.provide.use(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  await app.plugin(commandsPlugin, {});
  await app.plugin(authorityPlugin, {});
  await app.plugins.idle();
  // 守卫是 authority 激活时挂上去的：它若停在 pending，下面三条会一起退化成「无守卫」下的恒真
  for (const p of [commandsPlugin, authorityPlugin]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  return { app, commands: host.commands };
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
    commands.use.command('probe', '探针', { visibility: 'restricted' }).action(async () => {
      ran = true;
      return 'ran';
    });

    const out = await commands.use.execute('probe', input());
    await app.stop();

    expect(ran, 'restricted 指令被匿名用户执行了 —— 守卫没生效').toBe(false);
    expect(out, '应返回拒绝文案而非 undefined').toBeTruthy();
  });

  it('restricted 指令：owner（webui:console）可以执行', async () => {
    const { app, commands } = await makeApp();
    let ran = false;
    commands.use.command('probe', '探针', { visibility: 'restricted' }).action(async () => {
      ran = true;
      return 'ran';
    });

    await commands.use.execute('probe', input({ platform: 'webui', userId: 'console' }));
    await app.stop();

    expect(ran, 'owner 被守卫误拦 —— 权限系统把自己锁死了').toBe(true);
  });

  it('public 指令：匿名用户照常执行（守卫不得误伤）', async () => {
    const { app, commands } = await makeApp();
    let ran = false;
    commands.use.command('open', '公开指令').action(async () => {
      ran = true;
      return 'ok';
    });

    const out = await commands.use.execute('open', input({ raw: '/open' }));
    await app.stop();

    expect(ran, 'public 指令被误拦').toBe(true);
    expect(out).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════════
// 网络出口闸的策略注入：权限插件把宿主配置的 network 注入进程级出网策略，宿主文档变了（change 带 document）再注入。
// 写错时权限插件照常激活，出网一律报配置有误，每次注入写错都记一条 warn；改对即时恢复。
// 策略是进程级单例，每例后复位；这里导入的出网闸与插件里的 @aalis/util-network-guard 经 vitest 的别名是同一份模块。
// ════════════════════════════════════════════════════════════

describe('权限插件注入网络出口策略', () => {
  afterEach(() => setNetworkPolicy({}));

  /** 宿主文档的 network 为 network 时启动权限插件；changeNetwork 照热重载的路径先换文档、再发 host-config:changed */
  async function startAuthority(network: unknown) {
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
      error() {},
      child: () => logger,
    };
    const { app, store } = hostedApp({ network } as never, { logger });
    await app.plugin(authorityPlugin, {});
    await app.plugins.idle();
    const changeNetwork = async (next: unknown): Promise<void> => {
      store.set('network', next as never);
      await app.bind({ events }).events.use.emit('host-config:changed', { document: true });
    };
    return { app, changeNetwork, policyWarns: () => warns.filter(w => w.includes('网络策略')) };
  }

  it('network 段写错时权限插件照常激活，出网一律报配置有误并记 warn；改对、再改都即时生效', async () => {
    const { app, changeNetwork, policyWarns } = await startAuthority({
      allowedPorts: [80, 443],
      denyCidrs: ['1.1.1.0/24', 8],
    });
    try {
      expect(app.plugins.getPlugin(authorityPlugin.name)?.state).toBe('active');
      expect(() => assertPortAllowed(443)).toThrow(/^网络策略配置有误：denyCidrs 的 8 /);
      expect(policyWarns()).toEqual([expect.stringContaining('网络策略配置有误：denyCidrs 的 8 ')]);

      await changeNetwork({ allowedPorts: [80, 443], denyCidrs: ['1.1.1.0/24'] });
      expect(() => assertPortAllowed(443)).not.toThrow();
      expect(() => assertPortAllowed(6379)).toThrow('不在允许列表');
      expect(() => assertAddressesSafe('x', ['1.1.1.1'])).toThrow(/受限网段/);
      await changeNetwork({});
      expect(() => assertAddressesSafe('x', ['1.1.1.1'])).not.toThrow();
      expect(policyWarns()).toHaveLength(1); // 写对的注入不记
    } finally {
      await app.stop();
    }
  });
});
