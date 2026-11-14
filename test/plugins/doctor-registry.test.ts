/**
 * plugin-doctor — DoctorRegistry 开放检查项注册中心单元测试
 *
 * 验证：
 * - registerCheck 收集 spec，重复注册以最后一次为准
 * - runChecks 依次执行所有 spec，单条结果与数组结果都被收纳
 * - spec.run 抛错时被收纳为 error 级别 check，不影响其它检查
 * - generatedAt / summary 正确生成
 * - formatReport 输出按 level 分组并包含换行（聊天栏可读性）
 * - plugins.pending 逐条列出缺服务的插件，沿链追到根（api-doctor 的共享判据，与 runtime 启动告警、WebUI 同一份）；
 *   只在等提供者启动的不算未就绪，列在 plugins.waiting
 * - plugins.slow 点名激活超过阈值、已转入后台的插件；plugins.lingering 点名旧实例超过宽限仍未停下的插件
 * - env.node 按最低版本 24.15.0 判定，不够时写明需要的版本与升级方法
 * - 诊断页过登记门槛；每次运行后推 invalidate，有错误或警告时发提示（跳到诊断页），全部通过后撤回
 */

import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { type CheckResult, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import {
  App,
  definePlugin,
  defineService,
  lifecycle,
  logger,
  optional,
  type PluginDefinition,
  provide,
  services,
} from '../../packages/core/src/index.js';
import doctorPlugin, { formatReport } from '../../packages/plugin-doctor/src/index.js';
import { missingConfigError } from '../../packages/schema-config/src/index.js';
import {
  defineTexts,
  localize,
  resolveSource,
  resolveText,
  TextError,
  textLines,
  toSource,
} from '../../packages/schema-i18n/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ===== helpers =====

/** 极简 commands 替身：只记下声明了哪些指令，builder 的链式调用原样吞掉 */
function makeCommandService(recorded: Array<{ name: string; description?: string }>) {
  const builder = {
    option: () => builder,
    action: () => builder,
    usage: () => builder,
    example: () => builder,
  };
  return {
    command(name: string, description?: string) {
      recorded.push({ name, description });
      return builder;
    },
    unregister: () => undefined,
  };
}

const hosts: PageHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

async function boot(
  options: { slowThresholdMs?: number; disposeTimeoutMs?: number; before?: PluginDefinition[] } = {},
) {
  const { before = [], ...appOptions } = options;
  const app = new App({ name: 'T', logLevel: 'error', ...appOptions });
  provideEvents(app);
  const host = app.bind({ provide, services });
  const recordedCommands: Array<{ name: string; description?: string }> = [];
  const pages = pageHost();
  hosts.push(pages);
  host.provide.use(webuiServer, pages.service);
  host.provide.use(commands, makeCommandService(recordedCommands) as never);
  for (const definition of before) await app.plugins.register(definition, {});
  await app.plugins.register(doctorPlugin, {});
  await app.plugins.idle();
  return { app, pages, recordedCommands, doctor: host.services.use.get(doctor) as DoctorService };
}

// ===== tests =====

describe('plugin-doctor — 开放检查项注册中心', () => {
  it('装载后提供 doctor 服务，并预装内置检查项', async () => {
    const { app, recordedCommands, doctor } = await boot();
    expect(doctor).toBeDefined();
    const ids = doctor.listChecks().map(c => c.id);
    expect(ids).toContain('env.node');
    expect(ids).toContain('env.platform');
    expect(ids).toContain('plugins.status');
    // fs.data 已迁出到 plugin-storage-local，由它经 doctor 契约自行注册；
    // commands.overrides 已随指令覆盖存储一并删除。二者都不再由 doctor 自带。
    expect(ids).not.toContain('fs.data');
    expect(ids).not.toContain('commands.overrides');
    expect(recordedCommands.some(c => c.name === 'doctor')).toBe(true);
    await app.stop();
  });

  it('先于 doctor 激活的插件登记的检查项排在内置检查项之后', async () => {
    const early = definePlugin({
      name: 'zz-doctor-early',
      uses: { doctor: optional(doctor) },
      apply({ doctor }) {
        doctor.use.registerCheck({
          id: 'zz.early',
          category: 'other',
          run: () => ({ id: 'zz.early', category: 'other', level: 'ok', message: 'ok' }),
        });
      },
    });
    const { app, doctor: service } = await boot({ before: [early] });
    const ids = service.listChecks().map(c => c.id);
    expect(ids.indexOf('env.node')).toBeLessThan(ids.indexOf('zz.early'));
    await app.stop();
  });

  it('第三方插件可注册自定义检查项，runChecks 全部执行', async () => {
    const { app, doctor } = await boot();

    doctor.registerCheck({
      id: 'custom.single',
      category: 'service',
      pluginName: 'plugin-x',
      run: () => ({ id: 'custom.single', category: 'service', level: 'ok', message: '一切正常' }),
    });
    doctor.registerCheck({
      id: 'custom.multi',
      category: 'other',
      pluginName: 'plugin-y',
      run: async () =>
        [
          { id: 'custom.multi.a', category: 'other', level: 'ok', message: 'A 通过' },
          { id: 'custom.multi.b', category: 'other', level: 'warn', message: 'B 警告' },
        ] satisfies CheckResult[],
    });

    const report = await doctor.runChecks();
    const ids = report.checks.map(c => c.id);
    expect(ids).toContain('custom.single');
    expect(ids).toContain('custom.multi.a');
    expect(ids).toContain('custom.multi.b');
    expect(report.summary.ok).toBeGreaterThan(0);
    expect(report.summary.warn).toBeGreaterThanOrEqual(1);
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await app.stop();
  });

  it('同 id 重复注册以最后一次为准', async () => {
    const { app, doctor } = await boot();

    doctor.registerCheck({
      id: 'dup',
      category: 'other',
      run: () => ({ id: 'dup', category: 'other', level: 'ok', message: '第一次' }),
    });
    doctor.registerCheck({
      id: 'dup',
      category: 'other',
      run: () => ({ id: 'dup', category: 'other', level: 'warn', message: '第二次' }),
    });

    const report = await doctor.runChecks();
    const dup = report.checks.find(c => c.id === 'dup');
    expect(dup?.message).toBe('第二次');
    expect(dup?.level).toBe('warn');
    await app.stop();
  });

  it('check.run 抛错被收纳为 error 级别，不影响其他检查', async () => {
    const { app, doctor } = await boot();

    doctor.registerCheck({
      id: 'broken',
      category: 'other',
      run: () => {
        throw new Error('炸了');
      },
    });

    const report = await doctor.runChecks();
    const broken = report.checks.find(c => c.id === 'broken');
    expect(broken).toBeDefined();
    expect(broken!.level).toBe('error');
    expect(broken!.detail).toContain('炸了');
    // 其它内置检查仍然存在
    expect(report.checks.some(c => c.id === 'env.node')).toBe(true);
    await app.stop();
  });

  it('formatReport 按 level 分组，包含换行与汇总行', async () => {
    const { app, doctor } = await boot();
    doctor.registerCheck({
      id: 'warn.one',
      category: 'other',
      run: () => ({ id: 'warn.one', category: 'other', level: 'warn', message: '小心' }),
    });
    const report = await doctor.runChecks();
    const text = toSource(formatReport(report));

    // 至少出现汇总行
    expect(text).toMatch(/汇总：通过 \d+/);
    // ok 与 warn 分组都出现（数据保证两类都存在）
    expect(text).toMatch(/__通过__/);
    expect(text).toMatch(/__警告__/);
    // 多行（聊天栏不是一坨）
    expect(text.split('\n').length).toBeGreaterThan(5);
    await app.stop();
  });

  it.each([
    [{ ok: 19, warn: 2, error: 2 }, 'Summary: 19 passed, 2 warnings, 2 errors', '汇总：通过 19　警告 2　错误 2'],
    [{ ok: 1, warn: 1, error: 1 }, 'Summary: 1 passed, 1 warning, 1 error', '汇总：通过 1　警告 1　错误 1'],
  ])('formatReport 的汇总行：英文三段用逗号隔开、按单复数写（空白折叠后照样读得通），中文用全角空格隔开', (summary, en, zh) => {
    const report = formatReport({ generatedAt: new Date(0).toISOString(), summary, checks: [] });
    expect(resolveText(report, ['en']).split('\n')).toContain(en);
    expect(resolveSource(report).split('\n')).toContain(zh);
  });

  it('formatReport：两个以上插件缺服务时，详情的每一行都缩进（原文与英文）', async () => {
    const { app, doctor } = await boot();
    for (const name of ['zz-doctor-lacking-a', 'zz-doctor-lacking-b']) {
      const missing = defineService<unknown>(`${name}-service`);
      await app.plugins.register(definePlugin({ name, uses: { missing }, apply() {} }), {});
    }
    await app.plugins.idle();
    const report = formatReport(await doctor.runChecks());
    for (const shown of [resolveSource(report), resolveText(report, ['en'])]) {
      const details = shown.split('\n').filter(line => line.includes('zz-doctor-lacking-'));
      expect(details).toEqual([
        expect.stringMatching(/^ {4}zz-doctor-lacking-a: /),
        expect.stringMatching(/^ {4}zz-doctor-lacking-b: /),
      ]);
    }
    await app.stop();
  });

  it('plugins.pending 逐条列出缺的 required 服务，已有提供者的服务不列', async () => {
    const { app, doctor } = await boot();
    const probe = definePlugin({
      name: 'zz-doctor-pending-probe',
      uses: {
        logger,
        a: defineService<unknown>('zz-doctor-missing-a'),
        b: defineService<unknown>('zz-doctor-missing-b'),
      },
      apply() {},
    });
    await app.plugins.register(probe, {});
    await app.plugins.idle();

    const report = await doctor.runChecks();
    expect(toSource(report.checks.find(c => c.id === 'plugins.pending'))).toMatchObject({
      level: 'warn',
      message: '1 个插件缺服务，未就绪',
      detail:
        'zz-doctor-pending-probe: 缺少服务 zz-doctor-missing-a（没有已装的插件提供）；缺少服务 zz-doctor-missing-b（没有已装的插件提供）',
    });
    await app.stop();
  });

  it('失败的说明是文字对象时原样交给出口：检查项抛出的、插件失败的都按读者语言显示', async () => {
    const { app, doctor } = await boot();
    const t = defineTexts({
      ns: 'test/doctor-registry',
      language: 'zh-CN',
      source: { down: '探针掉线' },
      locales: { en: { down: 'Probe down' } },
    });
    doctor.registerCheck({
      id: 'zz.thrown',
      category: 'other',
      run: () => {
        throw new TextError(t('down'));
      },
    });
    await app.plugins.register(
      definePlugin({
        name: 'zz-doctor-unconfigured',
        apply() {
          throw missingConfigError('apiKey');
        },
      }),
      {},
    );
    await app.plugins.idle();

    const { checks } = await doctor.runChecks();
    const english = (id: string) => resolveText(textLines([checks.find(c => c.id === id)?.detail ?? '']), ['en']);
    expect(english('zz.thrown')).toBe('Probe down');
    expect(english('plugins.errored')).toBe(
      'zz-doctor-unconfigured: Missing config item apiKey; set it in the WebUI or the config file to apply',
    );
    await app.stop();
  });

  it('plugins.pending 沿链追到根：缺的服务由失败的插件提供时写出它与它的失败说明', async () => {
    const { app, doctor } = await boot();
    const rootService = defineService<object>('zz-doctor-root-svc');
    const broken = definePlugin({
      name: 'zz-doctor-broken',
      provides: [rootService],
      apply() {
        throw new Error('缺少配置项 apiKey');
      },
    });
    const probe = definePlugin({ name: 'zz-doctor-chained', uses: { root: rootService }, apply() {} });
    await app.plugins.register(broken, {});
    await app.plugins.register(probe, {});
    await app.plugins.idle();

    const report = await doctor.runChecks();
    expect(toSource(report.checks.find(c => c.id === 'plugins.pending')?.detail)).toBe(
      'zz-doctor-chained: 缺少服务 zz-doctor-root-svc（zz-doctor-broken 失败：缺少配置项 apiKey）',
    );
    await app.stop();
  });

  it('plugins.pending 把仍在激活中的插件声明提供的服务归为等待它启动；只在等的不算未就绪，列在 plugins.waiting', async () => {
    const { app, doctor } = await boot({ slowThresholdMs: 20 });
    const slowService = defineService<object>('zz-doctor-slow-svc');
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const provider = definePlugin({
      name: 'zz-doctor-slow-provider',
      provides: [slowService],
      uses: { provide },
      async apply({ provide }) {
        provide.use(slowService, {});
        await gate;
      },
    });
    const probe = definePlugin({
      name: 'zz-doctor-waiting-probe',
      uses: { slow: slowService, missing: defineService<unknown>('zz-doctor-missing-c') },
      apply() {},
    });
    const patient = definePlugin({ name: 'zz-doctor-patient', uses: { slow: slowService }, apply() {} });
    await app.plugins.register(provider, {});
    await app.plugins.register(probe, {});
    await app.plugins.register(patient, {});
    await app.plugins.idle();

    const checks = (await doctor.runChecks()).checks;
    expect(toSource(checks.find(c => c.id === 'plugins.pending'))).toMatchObject({
      message: '1 个插件缺服务，未就绪',
      detail:
        'zz-doctor-waiting-probe: 缺少服务 zz-doctor-missing-c（没有已装的插件提供）；等待 zz-doctor-slow-provider 启动',
    });
    expect(toSource(checks.find(c => c.id === 'plugins.waiting'))).toEqual({
      id: 'plugins.waiting',
      category: 'plugins',
      level: 'ok',
      message: '1 个插件在等别的插件启动',
      detail: 'zz-doctor-patient: 等待 zz-doctor-slow-provider 启动',
    });
    release();
    await app.stop();
  });

  it('只有在等的插件：plugins.pending 为 ok', async () => {
    const { app, doctor } = await boot({ slowThresholdMs: 20 });
    const slowService = defineService<object>('zz-doctor-slow-only');
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const provider = definePlugin({
      name: 'zz-doctor-slow-only-provider',
      provides: [slowService],
      uses: { provide },
      async apply({ provide }) {
        provide.use(slowService, {});
        await gate;
      },
    });
    await app.plugins.register(provider, {});
    await app.plugins.register(
      definePlugin({ name: 'zz-doctor-patient', uses: { slow: slowService }, apply() {} }),
      {},
    );
    await app.plugins.idle();

    const checks = (await doctor.runChecks()).checks;
    expect(toSource(checks.find(c => c.id === 'plugins.pending'))).toMatchObject({
      level: 'ok',
      message: '无缺服务的插件',
    });
    expect(toSource(checks.find(c => c.id === 'plugins.waiting')?.detail)).toBe(
      'zz-doctor-patient: 等待 zz-doctor-slow-only-provider 启动',
    );
    release();
    await app.stop();
  });

  it('plugins.slow 点名激活超过阈值、仍在后台进行的插件，英文按个数分单复数；没有时为 ok', async () => {
    const { app, doctor } = await boot({ slowThresholdMs: 20 });
    const quiet = await doctor.runChecks();
    expect(toSource(quiet.checks.find(c => c.id === 'plugins.slow'))).toMatchObject({
      level: 'ok',
      message: '无激活超时的插件',
    });

    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const slowCheck = async () => (await doctor.runChecks()).checks.find(c => c.id === 'plugins.slow');
    await app.plugins.register(definePlugin({ name: 'zz-doctor-slow-probe', apply: () => gate }), {});
    await app.plugins.idle();
    const one = await slowCheck();
    expect(toSource(one)).toMatchObject({
      level: 'warn',
      message: '1 个插件激活超过阈值，仍在后台进行',
      detail:
        'zz-doctor-slow-probe\n等它完成即可；长时间不完成时看它的日志（多为在等网络或外部服务），停用再启用可重试',
    });
    expect(localize(one, text => resolveText(text, ['en']))).toMatchObject({
      message: '1 plugin has been activating past the threshold, still running in the background',
      detail:
        'zz-doctor-slow-probe\nJust wait for it to finish; if it takes long, check its logs (usually it is waiting on the network or an external service); disabling and re-enabling it retries',
    });
    await app.plugins.register(definePlugin({ name: 'zz-doctor-slow-probe-b', apply: () => gate }), {});
    await app.plugins.idle();
    expect(localize((await slowCheck())?.message, text => resolveText(text, ['en']))).toBe(
      '2 plugins have been activating past the threshold, still running in the background',
    );
    release();
    await app.stop();
  });

  it('plugins.lingering 点名旧实例超过宽限仍未停下的插件，说法与依赖链的根一致（原文与英文）；没有时不出这一项', async () => {
    const { app, doctor } = await boot({ disposeTimeoutMs: 20 });
    expect((await doctor.runChecks()).checks.some(c => c.id === 'plugins.lingering')).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let applies = 0;
    await app.plugins.register(
      definePlugin({
        name: 'zz-doctor-slowstop',
        uses: { lifecycle },
        apply: ({ lifecycle }) => void (++applies === 1 && lifecycle.use.onDispose(() => gate)),
      }),
      {},
    );
    await app.plugins.bounce('zz-doctor-slowstop');
    const report = await doctor.runChecks();
    // 新实例停在 pending、只在等旧实例停下：不缺服务，plugins.pending 不写「无未就绪插件」，原因只在 plugins.lingering 报一次
    expect(app.plugins.getPlugin('zz-doctor-slowstop')?.state).toBe('pending');
    expect(toSource(report.checks.find(c => c.id === 'plugins.pending'))).toMatchObject({
      level: 'ok',
      message: '无缺服务的插件',
    });
    expect(report.checks.some(c => c.id === 'plugins.waiting')).toBe(false);
    const lingering = report.checks.find(c => c.id === 'plugins.lingering');
    expect(toSource(lingering)).toMatchObject({
      level: 'warn',
      message: '1 个插件的旧实例超过宽限仍未停下',
      detail:
        '等待 zz-doctor-slowstop 的旧实例停下\n停下后按目标态继续；一直不停时看它的日志（多为清理在等网络或外部进程），重启进程可解决',
    });
    expect(localize(lingering, text => resolveText(text, ['en']))).toMatchObject({
      message: '1 plugin has an old instance still not stopped after the grace period',
      detail:
        'Waiting for the old instance of zz-doctor-slowstop to stop\nOnce it stops, things continue toward the target state; if it never stops, check its logs (usually cleanup is waiting on the network or an external process); restarting the process resolves it',
    });
    release();
    await app.stop();
  });

  it('env.node：低于 24.15.0 报错并写明需要的版本与升级方法，24.15.0 起通过', async () => {
    const { app, doctor } = await boot();
    const realVersion = process.version;
    const checkAt = async (version: string) => {
      Object.defineProperty(process, 'version', { value: version });
      syncBuiltinESMExports();
      return toSource((await doctor.runChecks()).checks.find(c => c.id === 'env.node'));
    };
    try {
      expect(await checkAt('v24.14.9')).toMatchObject({
        level: 'error',
        message: 'Node v24.14.9',
        // 经 npm 装的项目里没有 docs/：指向文档站上那一节
        detail: '需要 Node 24.15.0 起；升级方法见 https://aalis.acenyan.com/guide/first-run#upgrade-node',
      });
      // 按字符串比较会排在 v24.15.0 之后
      expect(await checkAt('v24.9.0')).toMatchObject({ level: 'error' });
      expect(await checkAt('v24.15.0')).toEqual({
        id: 'env.node',
        category: 'env',
        level: 'ok',
        message: 'Node v24.15.0',
      });
      expect(await checkAt('v26.0.0')).toMatchObject({ level: 'ok' });
    } finally {
      Object.defineProperty(process, 'version', { value: realVersion });
      syncBuiltinESMExports();
      await app.stop();
    }
  });

  it('registerCheck 返回 dispose 函数可移除项', async () => {
    const { app, doctor } = await boot();
    const off = doctor.registerCheck({
      id: 'temp',
      category: 'other',
      run: () => ({ id: 'temp', category: 'other', level: 'ok', message: 'x' }),
    });
    expect(doctor.listChecks().some(c => c.id === 'temp')).toBe(true);
    off();
    expect(doctor.listChecks().some(c => c.id === 'temp')).toBe(false);
    await app.stop();
  });
});

describe('plugin-doctor — 诊断页与提示', () => {
  it('诊断页过登记门槛；没运行过时写明尚未运行，结果表为空', async () => {
    const { app, pages } = await boot();
    expect(pages.logs).toEqual([]);
    expect(toSource(pages.view('doctor'))).toMatchObject({ title: '系统诊断', placement: 'plugin', icon: 'activity' });
    expect(toSource(await pages.data('doctor', 'summary'))).toEqual([{ label: '时间', value: '尚未运行' }]);
    expect(await pages.data('doctor', 'checks')).toEqual([]);
    await app.stop();
  });

  it('「立即运行」经页面动作跑一次：回一句汇总，结果表按级别标状态', async () => {
    const { app, pages, doctor } = await boot();
    doctor.registerCheck({
      id: 'zz.broken',
      category: 'other',
      run: () => ({ id: 'zz.broken', category: 'other', level: 'error', message: '坏了', detail: '原因' }),
    });
    const reply = await pages.act('doctor', 'runDiagnostics');
    expect(reply.status).toBe(200);
    expect(toSource((reply.body as { message: unknown }).message)).toMatch(
      /^诊断完成：\d+ 项通过、0 项警告、1 项错误$/,
    );
    const rows = toSource(await pages.data<Array<Record<string, unknown>>>('doctor', 'checks'));
    expect(rows.find(row => row.id === 'zz.broken')).toMatchObject({
      level: { text: '错误', state: 'error' },
      message: '坏了',
      detail: '原因',
    });
    expect(rows.find(row => row.id === 'env.platform')).toMatchObject({ level: { text: '通过' } });
    await app.stop();
  });

  it('每次运行后推 invalidate；有错误发出提示并跳到诊断页，修好后再运行就撤回', async () => {
    const { app, pages, doctor } = await boot();
    const off = doctor.registerCheck({
      id: 'zz.broken',
      category: 'other',
      run: () => ({ id: 'zz.broken', category: 'other', level: 'error', message: '坏了' }),
    });
    await doctor.runChecks();
    expect(pages.invalidations).toEqual([{ instance: '@aalis/plugin-doctor', pageKey: 'doctor' }]);
    expect(toSource(pages.notices())).toEqual([
      {
        instance: '@aalis/plugin-doctor',
        id: 'checks',
        level: 'error',
        title: '诊断有 1 项错误',
        open: { page: 'doctor' },
      },
    ]);
    off();
    await doctor.runChecks();
    expect(pages.invalidations).toHaveLength(2);
    expect(pages.notices()).toEqual([]);
    await app.stop();
  });

  it('只有警告时提示是「需要处理」，标题写明几项；错误与警告都有时一并写明', async () => {
    const { app, pages, doctor } = await boot();
    doctor.registerCheck({
      id: 'zz.warn',
      category: 'other',
      run: () => ({ id: 'zz.warn', category: 'other', level: 'warn', message: '小心' }),
    });
    await doctor.runChecks();
    expect(toSource(pages.notices())).toMatchObject([{ id: 'checks', level: 'action', title: '诊断有 1 项警告' }]);
    doctor.registerCheck({
      id: 'zz.broken',
      category: 'other',
      run: () => ({ id: 'zz.broken', category: 'other', level: 'error', message: '坏了' }),
    });
    await doctor.runChecks();
    expect(toSource(pages.notices())).toMatchObject([
      { id: 'checks', level: 'error', title: '诊断有 1 项错误、1 项警告' },
    ]);
    await app.stop();
  });

  it('停用后页面与提示一并撤回', async () => {
    const { app, pages, doctor } = await boot();
    doctor.registerCheck({
      id: 'zz.broken',
      category: 'other',
      run: () => ({ id: 'zz.broken', category: 'other', level: 'error', message: '坏了' }),
    });
    await doctor.runChecks();
    expect(pages.notices()).toHaveLength(1);
    await app.plugins.unload('@aalis/plugin-doctor');
    expect(pages.pages()).toEqual([]);
    expect(pages.notices()).toEqual([]);
    await app.stop();
  });
});
