/**
 * plugin-doctor — DoctorRegistry 开放检查项注册中心单元测试
 *
 * 验证：
 * - registerCheck 收集 spec，重复注册以最后一次为准
 * - runChecks 依次执行所有 spec，单条结果与数组结果都被收纳
 * - spec.run 抛错时被收纳为 error 级别 check，不影响其它检查
 * - generatedAt / summary 正确生成
 * - formatReport 输出按 level 分组并包含换行（聊天栏可读性）
 * - plugins.pending 逐条列出缺的 required 服务（与 runtime 启动告警同一判据），仍在激活中的提供者归为等待
 * - plugins.slow 点名激活超过阈值、已转入后台的插件
 * - 诊断页过登记门槛；每次运行后推 invalidate，有错误或警告时发提示（跳到诊断页），全部通过后撤回
 */
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { type CheckResult, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, defineService, logger, provide, services } from '../../packages/core/src/index.js';
import doctorPlugin, { formatReport } from '../../packages/plugin-doctor/src/index.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ===== helpers =====

/** 极简 commands 替身：只记下声明了哪些指令，builder 的链式调用原样吞掉 */
function makeCommandService(recorded: Array<{ name: string; description?: string }>) {
  const builder = {
    alias: () => builder,
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

async function boot(options: { slowThresholdMs?: number } = {}) {
  const app = new App({ name: 'T', logLevel: 'error', ...options });
  const host = app.bind({ provide, services });
  const recordedCommands: Array<{ name: string; description?: string }> = [];
  const pages = pageHost();
  hosts.push(pages);
  host.provide(webuiServer, pages.service);
  host.provide(commands, makeCommandService(recordedCommands) as never);
  await app.plugins.register(doctorPlugin, {});
  await app.plugins.idle();
  return { app, pages, recordedCommands, doctor: host.services.get(doctor) as DoctorService };
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
    const text = formatReport(report);

    // 至少出现汇总行
    expect(text).toMatch(/汇总: ✓ \d+/);
    // ok 与 warn 分组都出现（数据保证两类都存在）
    expect(text).toMatch(/✓ 通过/);
    expect(text).toMatch(/! 警告/);
    // 多行（聊天栏不是一坨）
    expect(text.split('\n').length).toBeGreaterThan(5);
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
    const pending = report.checks.find(c => c.id === 'plugins.pending');
    expect(pending?.level).toBe('warn');
    expect(pending?.detail).toBe('zz-doctor-pending-probe: 缺少服务: zz-doctor-missing-a、zz-doctor-missing-b');
    await app.stop();
  });

  it('plugins.pending 把仍在激活中的插件声明提供的服务归为等待它激活完成，其余仍报缺少', async () => {
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
        provide(slowService, {});
        await gate;
      },
    });
    const probe = definePlugin({
      name: 'zz-doctor-waiting-probe',
      uses: { slow: slowService, missing: defineService<unknown>('zz-doctor-missing-c') },
      apply() {},
    });
    await app.plugins.register(provider, {});
    await app.plugins.register(probe, {});
    await app.plugins.idle();

    const pending = (await doctor.runChecks()).checks.find(c => c.id === 'plugins.pending');
    expect(pending?.detail).toBe(
      'zz-doctor-waiting-probe: 缺少服务: zz-doctor-missing-c；等待 zz-doctor-slow-provider 激活完成',
    );
    release();
    await app.stop();
  });

  it('plugins.slow 点名激活超过阈值、仍在后台进行的插件；没有时为 ok', async () => {
    const { app, doctor } = await boot({ slowThresholdMs: 20 });
    const quiet = await doctor.runChecks();
    expect(quiet.checks.find(c => c.id === 'plugins.slow')).toMatchObject({ level: 'ok', message: '无激活超时的插件' });

    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    await app.plugins.register(definePlugin({ name: 'zz-doctor-slow-probe', apply: () => gate }), {});
    await app.plugins.idle();
    const report = await doctor.runChecks();
    expect(report.checks.find(c => c.id === 'plugins.slow')).toMatchObject({
      level: 'warn',
      message: '1 个插件激活超过阈值，仍在后台进行',
      detail: 'zz-doctor-slow-probe',
    });
    release();
    await app.stop();
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
    expect(pages.view('doctor')).toMatchObject({ title: '系统诊断', placement: 'plugin', icon: 'activity' });
    expect(await pages.data('doctor', 'summary')).toEqual([{ label: '时间', value: '尚未运行' }]);
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
    expect((reply.body as { message: string }).message).toMatch(/^诊断完成：\d+ 项通过、0 项警告、1 项错误$/);
    const rows = await pages.data<Array<Record<string, unknown>>>('doctor', 'checks');
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
    expect(pages.notices()).toEqual([
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
    expect(pages.notices()).toMatchObject([{ id: 'checks', level: 'action', title: '诊断有 1 项警告' }]);
    doctor.registerCheck({
      id: 'zz.broken',
      category: 'other',
      run: () => ({ id: 'zz.broken', category: 'other', level: 'error', message: '坏了' }),
    });
    await doctor.runChecks();
    expect(pages.notices()).toMatchObject([{ id: 'checks', level: 'error', title: '诊断有 1 项错误、1 项警告' }]);
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
