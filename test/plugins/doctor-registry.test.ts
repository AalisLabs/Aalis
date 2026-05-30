/**
 * plugin-doctor — DoctorRegistry 开放检查项注册中心单元测试
 *
 * 验证：
 * - registerCheck 收集 spec，重复注册以最后一次为准
 * - runChecks 依次执行所有 spec，单条结果与数组结果都被收纳
 * - spec.run 抛错时被收纳为 error 级别 check，不影响其它检查
 * - generatedAt / summary 正确生成
 * - formatReport 输出按 level 分组并包含换行（聊天栏可读性）
 */
import type { Context, Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { CheckResult, DoctorService } from '../../packages/plugin-doctor/src/index.js';
import { apply as applyDoctor, formatReport } from '../../packages/plugin-doctor/src/index.js';

// ===== helpers =====

function makeLogger(): Logger {
  const noop = () => undefined;
  const l: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

interface Captured {
  doctor?: DoctorService;
  webuiPages: unknown[];
  commands: Array<{ name: string; desc: string }>;
}

function makeWebuiService(captured: Captured) {
  return {
    registerPage(page: unknown) {
      captured.webuiPages.push(page);
      return () => undefined;
    },
  };
}

function makeCommandService(captured: Captured) {
  return {
    command(name: string, desc: string) {
      const node = { name, desc, action: (_fn: unknown) => node };
      captured.commands.push({ name, desc });
      return node;
    },
  };
}

// 在 ctx.getService 里塞入 webui / commands stub
function makeFullCtx(captured: Captured): Context {
  const baseProvideMap = new Map<string, unknown>();
  baseProvideMap.set('webui', makeWebuiService(captured));
  baseProvideMap.set('commands', makeCommandService(captured));

  const ctx = {
    id: 'plugin-doctor-test',
    logger: makeLogger(),
    provide<T>(name: string, svc: T): () => void {
      baseProvideMap.set(name, svc);
      if (name === 'doctor') captured.doctor = svc as unknown as DoctorService;
      return () => baseProvideMap.delete(name);
    },
    getService<T>(name: string): T | undefined {
      return baseProvideMap.get(name) as T | undefined;
    },
    whenService<T>(name: string, cb: (svc: T) => undefined | (() => void)): () => void {
      const svc = baseProvideMap.get(name);
      if (svc === undefined) return () => undefined;
      const cleanup = cb(svc as T);
      return () => cleanup?.();
    },
    onDispose: () => undefined,
    emit: async () => undefined,
    on: () => () => undefined,
  } as unknown as Context;
  return ctx;
}

// ===== tests =====

describe('plugin-doctor — 开放检查项注册中心', () => {
  it('apply() 注册 doctor 服务，并预装内置检查项', () => {
    const captured: Captured = { webuiPages: [], commands: [] };
    const ctx = makeFullCtx(captured);
    applyDoctor(ctx, {});
    expect(captured.doctor).toBeDefined();
    const ids = captured.doctor!.listChecks().map(c => c.id);
    expect(ids).toContain('env.node');
    expect(ids).toContain('env.platform');
    expect(ids).toContain('plugins.status');
    // fs.data 已迁出到 plugin-storage-local；commands.overrides 已迁出到 plugin-commands。
    // 它们不再由 doctor 自带，由所属插件通过 useDoctorService 自行注册。
    expect(ids).not.toContain('fs.data');
    expect(ids).not.toContain('commands.overrides');
    expect(captured.commands.some(c => c.name === 'doctor')).toBe(true);
  });

  it('第三方插件可注册自定义检查项，runChecks 全部执行', async () => {
    const captured: Captured = { webuiPages: [], commands: [] };
    const ctx = makeFullCtx(captured);
    applyDoctor(ctx, {});
    const doctor = captured.doctor!;

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
  });

  it('同 id 重复注册以最后一次为准', async () => {
    const captured: Captured = { webuiPages: [], commands: [] };
    const ctx = makeFullCtx(captured);
    applyDoctor(ctx, {});
    const doctor = captured.doctor!;

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
  });

  it('check.run 抛错被收纳为 error 级别，不影响其他检查', async () => {
    const captured: Captured = { webuiPages: [], commands: [] };
    const ctx = makeFullCtx(captured);
    applyDoctor(ctx, {});
    const doctor = captured.doctor!;

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
  });

  it('formatReport 按 level 分组，包含换行与汇总行', async () => {
    const captured: Captured = { webuiPages: [], commands: [] };
    const ctx = makeFullCtx(captured);
    applyDoctor(ctx, {});
    const doctor = captured.doctor!;
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
  });

  it('registerCheck 返回 dispose 函数可移除项', async () => {
    const captured: Captured = { webuiPages: [], commands: [] };
    const ctx = makeFullCtx(captured);
    applyDoctor(ctx, {});
    const doctor = captured.doctor!;
    const off = doctor.registerCheck({
      id: 'temp',
      category: 'other',
      run: () => ({ id: 'temp', category: 'other', level: 'ok', message: 'x' }),
    });
    expect(doctor.listChecks().some(c => c.id === 'temp')).toBe(true);
    off();
    expect(doctor.listChecks().some(c => c.id === 'temp')).toBe(false);
  });
});
