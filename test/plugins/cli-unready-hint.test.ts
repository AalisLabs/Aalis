import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctor } from '../../packages/api-doctor/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type App, definePlugin, defineService, type Logger, provide } from '../../packages/core/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import doctorPlugin from '../../packages/plugin-doctor/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';
import { fakeTty } from '../helpers/tty.js';

// ════════════════════════════════════════════════════════════
// 终端界面起来、插件状态静置之后，有插件没起来时聊天页在欢迎行下面指路：数目与 /doctor 的「失败」「未就绪」两项之和一致
// （缺服务按 api-doctor 的共享判据，只在等别的插件启动的不算），有 doctor 指令时指向它，没有时指向日志页。
// 起真 TUI（假 TTY，收集 stdout 帧），插件状态与指令都是真的
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));

const broken = definePlugin({
  name: 'zz-broken',
  apply() {
    throw new Error('缺少配置项 apiKey');
  },
});
/** required 一个没人提供的服务：停在 pending */
const waiting = (name: string) =>
  definePlugin({ name, uses: { missing: defineService<object>('zz-missing') }, apply() {} });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/**
 * withDoctor：装上指令服务与诊断插件（有 /doctor）；否则只装指令服务。
 * beforeStart：启动之前最后一步，可以让一次激活停在半路
 */
async function boot(
  extra: ReturnType<typeof definePlugin>[],
  {
    withDoctor,
    beforeStart,
    slowThresholdMs,
  }: { withDoctor: boolean; beforeStart?: (app: App) => Promise<void>; slowThresholdMs?: number },
) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    writes.push(String(chunk));
    return true;
  });
  cleanups.push(fakeTty(30, 120).restore);
  const { app } = hostedApp({}, { logger: silent, slowThresholdMs });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, doctor });
  // plugin-commands 把 gateway 声明为 required；这里只要指令表，给一份只满足「在场」的桩
  host.provide.use(gateway, { ingressMessage: async () => {}, dispatchOutbound: async () => {} });
  await app.plugin(commandsPlugin, {});
  if (withDoctor) await app.plugin(doctorPlugin, {});
  for (const definition of extra) await app.plugin(definition, {});
  await app.plugin(cliPlugin, { startupView: 'chat' });
  await app.plugins.idle();
  if (app.plugins.getPlugin(cliPlugin.name)?.state !== 'active') throw new Error('plugin-cli 未激活');
  await beforeStart?.(app);
  await app.start();
  await settle();
  const frame = () => {
    const all = writes.join('');
    return all.slice(all.lastIndexOf(FRAME_SPLIT)).replace(ANSI_RE, '');
  };
  return { host, frame };
}

describe('终端欢迎行下面的指路', () => {
  it('有失败与未就绪的插件：写出两者之和，与 /doctor 的「失败」「未就绪」两项之和一致，指向 /doctor', async () => {
    const { host, frame } = await boot([broken, waiting('zz-waiting-a'), waiting('zz-waiting-b')], {
      withDoctor: true,
    });
    await vi.waitFor(() => expect(frame()).toContain('有 3 个插件没起来，输入 /doctor 查看原因与修法'));
    expect(frame()).toContain('欢迎使用 Aalis。按 Ctrl+G 查看快捷键。');
    const report = await host.doctor.use.runChecks();
    const listed = (id: string) => report.checks.find(check => check.id === id)?.detail?.split('\n').length ?? 0;
    expect(listed('plugins.errored') + listed('plugins.pending')).toBe(3);
  });

  it('只在等别的插件启动的不算：数目只含失败与缺服务，仍与 /doctor 两项之和一致', async () => {
    const slowService = defineService<object>('zz-slow-svc');
    const gate = deferred();
    const slow = definePlugin({
      name: 'zz-slow',
      provides: [slowService],
      uses: { provide },
      async apply({ provide }) {
        provide.use(slowService, {});
        await gate.promise;
      },
    });
    const patient = definePlugin({ name: 'zz-patient', uses: { slow: slowService }, apply() {} });
    const { host, frame } = await boot([broken, slow, patient], { withDoctor: true, slowThresholdMs: 20 });
    // 收尾按登记的反序：先放行慢激活，再停应用
    cleanups.push(() => gate.resolve());
    await vi.waitFor(() => expect(frame()).toContain('有 1 个插件没起来，输入 /doctor 查看原因与修法'));
    const report = await host.doctor.use.runChecks();
    const listed = (id: string) => report.checks.find(check => check.id === id)?.detail?.split('\n').length ?? 0;
    expect(listed('plugins.errored') + listed('plugins.pending')).toBe(1);
  });

  it('插件都起来了：只有欢迎行', async () => {
    const { frame } = await boot([], { withDoctor: true });
    // 指路在静置之后才判，等过几拍渲染再看它没出现
    await new Promise(r => setTimeout(r, 50));
    await settle();
    expect(frame()).toContain('欢迎使用 Aalis。');
    expect(frame()).not.toContain('没起来');
  });

  it('终端界面起来时还有插件在激活：等插件状态静置再数', async () => {
    const entered = deferred();
    const gate = deferred();
    const late = definePlugin({
      name: 'zz-late',
      async apply() {
        entered.resolve();
        await gate.promise;
        throw new Error('连不上上游');
      },
    });
    let activating: Promise<boolean> | undefined;
    const { frame } = await boot([], {
      withDoctor: true,
      beforeStart: async app => {
        activating = app.plugin(late, {});
        await entered.promise;
      },
    });
    await settle();
    expect(frame()).not.toContain('没起来');
    gate.resolve();
    await activating;
    await vi.waitFor(() => expect(frame()).toContain('有 1 个插件没起来，输入 /doctor 查看原因与修法'));
  });

  it('没有 doctor 指令：改为指向日志页', async () => {
    const { frame } = await boot([broken], { withDoctor: false });
    await vi.waitFor(() => expect(frame()).toContain('有 1 个插件没起来，按 Ctrl+L 看日志'));
    expect(frame()).not.toContain('/doctor');
  });
});
