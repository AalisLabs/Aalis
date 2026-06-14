import { describe, expect, it, vi } from 'vitest';
import {
  createPackageManager,
  type PackageManagerDeps,
  parsePackInfo,
} from '../../packages/plugin-package-manager/src/index.js';

// 从被测模块的依赖契约推导类型，避免测试直接 import api 包（knip unlisted-dep）
type ProcessService = PackageManagerDeps['proc'];
type ExecResult = Awaited<ReturnType<ProcessService['execFile']>>;

// ════════════════════════════════════════════════════════════
// package-manager — install/uninstall 集成测试（mock process 网关）
//
// createPackageManager(deps) 已从 ctx/网关解耦：所有文件操作走 process 子进程
// （npm/tar/mkdir/rm/test），目标是真实 <cwd>/packages（不经 storage 沙盒——
// 沙盒根是 workspace，够不到 packages，历史 bug 即源于此）。
// 覆盖成功 / 已存在 / 失败回滚 / pack 解析失败 / 卸载（含目录不存在仍移除）。
// ════════════════════════════════════════════════════════════

/** npm pack --json 的典型输出（含部分 npm 版本会前置的 notice） */
const PACK_JSON = (name: string, filename: string, notice = false): string =>
  `${notice ? 'npm notice \n' : ''}[{"id":"${name}@1.0.0","name":"${name}","version":"1.0.0","filename":"${filename}"}]`;

const PKG_DIR = '/abs/packages';

interface Harness {
  deps: PackageManagerDeps;
  execCalls: Array<{ cmd: string; args: string[] }>;
  deleted: string[]; // rm 删除的路径
}

/** 构造 mock 依赖；exists=test -d 为真的绝对路径集；failOn=该命令抛错 */
function makeHarness(
  opts: {
    exists?: Set<string>;
    packOut?: string;
    failOn?: string; // npm/mkdir/tar/pnpm
    rescan?: string[];
  } = {},
): Harness {
  const execCalls: Array<{ cmd: string; args: string[] }> = [];
  const deleted: string[] = [];
  const exists = opts.exists ?? new Set<string>();

  const proc = {
    execFile: vi.fn(async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
      execCalls.push({ cmd, args: [...args] });
      if (cmd === 'test') {
        // test -d <path>：存在返回 0，否则 exit 1（抛错）
        if (exists.has(args[1])) return { stdout: '', stderr: '', code: 0 } as ExecResult;
        const e = new Error('test: 非目录') as Error & { result?: ExecResult };
        e.result = { stdout: '', stderr: '', code: 1 } as ExecResult;
        throw e;
      }
      if (cmd === 'rm') {
        deleted.push(args[args.length - 1]); // rm -rf/-f <path>
        return { stdout: '', stderr: '', code: 0 } as ExecResult;
      }
      if (opts.failOn === cmd) {
        const err = new Error(`${cmd} 失败`) as Error & { result?: ExecResult };
        err.result = { stdout: '', stderr: `${cmd} 模拟失败`, code: 1 } as ExecResult;
        throw err;
      }
      const stdout = cmd === 'npm' ? (opts.packOut ?? PACK_JSON('@scope/foo', 'scope-foo-1.0.0.tgz')) : '';
      return { stdout, stderr: '', code: 0 } as ExecResult;
    }),
  } as unknown as ProcessService;

  const deps: PackageManagerDeps = {
    proc,
    log: { info: () => {}, error: () => {} },
    packagesDir: () => PKG_DIR,
    rescanPlugins: async () => opts.rescan ?? ['@scope/foo'],
    unloadPlugin: vi.fn(async () => {}),
    cleanupConfig: vi.fn(() => {}),
  };
  return { deps, execCalls, deleted };
}

describe('parsePackInfo（npm pack --json 解析）', () => {
  it('解析 filename + name', () => {
    expect(parsePackInfo(PACK_JSON('@scope/foo', 'scope-foo-1.0.0.tgz'))).toEqual({
      filename: 'scope-foo-1.0.0.tgz',
      name: '@scope/foo',
    });
  });
  it('容忍 JSON 前的 npm notice', () => {
    expect(parsePackInfo(PACK_JSON('foo', 'foo-1.0.0.tgz', true))?.filename).toBe('foo-1.0.0.tgz');
  });
  it('缺字段/非法输出返回 undefined', () => {
    expect(parsePackInfo('not json')).toBeUndefined();
    expect(parsePackInfo('[{"name":"foo"}]')).toBeUndefined(); // 缺 filename
    expect(parsePackInfo('[]')).toBeUndefined();
  });
});

describe('install', () => {
  it('成功：npm pack→tar→pnpm→rescan，返回已加载插件', async () => {
    const h = makeHarness({ rescan: ['@scope/foo'] });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('@scope/foo');
    // 关键步骤齐全（忽略中间 test/mkdir/rm 的辅助命令）
    expect(h.execCalls.map(c => c.cmd).filter(c => c === 'npm' || c === 'tar' || c === 'pnpm')).toEqual([
      'npm',
      'tar',
      'pnpm',
    ]);
    // pnpm --filter 用精确包名（npm pack 回报的 name）
    expect(h.execCalls.find(c => c.cmd === 'pnpm')?.args).toContain('@scope/foo');
    // 解压到真实 packages 目录（绝对路径，非 workspace 沙盒）
    expect(h.execCalls.find(c => c.cmd === 'tar')?.args).toContain(`${PKG_DIR}/foo`);
  });

  it('目录已存在：直接拒绝，不调 npm', async () => {
    const h = makeHarness({ exists: new Set([`${PKG_DIR}/foo`]) });
    const r = await createPackageManager(h.deps).install('foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已存在');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('pack 解析失败：返回错误，不继续 tar', async () => {
    const h = makeHarness({ packOut: 'garbage-not-json' });
    const r = await createPackageManager(h.deps).install('foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未能解析');
    expect(h.execCalls.some(c => c.cmd === 'tar')).toBe(false); // 止于 npm pack
  });

  it('tar 失败：回滚 rm -rf targetDir', async () => {
    const h = makeHarness({ failOn: 'tar' });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(h.deleted).toContain(`${PKG_DIR}/foo`); // 回滚删半成品目录
  });

  it('指定版本：@scope/foo@1.2.3 → 目录仍为 foo（去 scope 去版本）', async () => {
    const h = makeHarness({ packOut: PACK_JSON('@scope/foo', 'scope-foo-1.2.3.tgz') });
    const r = await createPackageManager(h.deps).install('@scope/foo@1.2.3');
    expect(r.ok).toBe(true);
    expect(h.execCalls.find(c => c.cmd === 'npm')?.args).toContain('@scope/foo@1.2.3');
  });
});

describe('uninstall', () => {
  it('删目录 + 从运行时移除(unload) + 清残留配置', async () => {
    const h = makeHarness({ exists: new Set([`${PKG_DIR}/foo`]) });
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(true);
    expect(h.deleted).toContain(`${PKG_DIR}/foo`); // 删的是真实 packages 目录
    expect(h.deps.unloadPlugin).toHaveBeenCalledWith('@scope/foo'); // 彻底移除而非仅禁用
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith('@scope/foo');
  });

  it('目录不存在：仍 unload + 清配置（修复"目录不存在就什么都不做"的旧 bug）', async () => {
    const h = makeHarness(); // exists 空
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('已从运行时移除');
    expect(h.deleted).toHaveLength(0); // 没目录可删
    expect(h.deps.unloadPlugin).toHaveBeenCalledWith('@scope/foo'); // 但仍从运行时移除
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith('@scope/foo');
  });
});
