import { describe, expect, it, vi } from 'vitest';
import {
  createPackageManager,
  type PackageManagerDeps,
  parsePackInfo,
} from '../../packages/plugin-package-manager/src/index.js';

// 从被测模块的依赖契约推导类型，避免测试直接 import api 包（knip unlisted-dep）
type ProcessService = PackageManagerDeps['proc'];
type StoragePick = PackageManagerDeps['storage'];
type ExecResult = Awaited<ReturnType<ProcessService['execFile']>>;

// ════════════════════════════════════════════════════════════
// package-manager — install/uninstall 集成测试（mock proc/storage）
//
// createPackageManager(deps) 已从 ctx/网关解耦：测试直接注入 mock 依赖，
// 覆盖成功 / 已存在 / 失败回滚 / pack 解析失败 / 卸载 等路径。
// ════════════════════════════════════════════════════════════

/** npm pack --json 的典型输出（含部分 npm 版本会前置的 notice） */
const PACK_JSON = (name: string, filename: string, notice = false): string =>
  `${notice ? 'npm notice \n' : ''}[{"id":"${name}@1.0.0","name":"${name}","version":"1.0.0","filename":"${filename}"}]`;

interface Harness {
  deps: PackageManagerDeps;
  execCalls: Array<{ cmd: string; args: string[] }>;
  deleted: string[];
}

/** 构造 mock 依赖；execImpl 决定每条命令的 stdout 或抛错（按调用序） */
function makeHarness(
  opts: {
    exists?: Set<string>; // dirExists=true 的 uri
    packOut?: string; // npm pack 的 stdout
    failOn?: string; // 在该命令（npm/mkdir/tar/pnpm）上抛错
    rescan?: string[]; // rescanPlugins 返回
  } = {},
): Harness {
  const execCalls: Array<{ cmd: string; args: string[] }> = [];
  const deleted: string[] = [];
  const exists = opts.exists ?? new Set<string>();

  const proc = {
    execFile: vi.fn(async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
      execCalls.push({ cmd, args: [...args] });
      if (opts.failOn === cmd) {
        const err = new Error(`${cmd} 失败`) as Error & { result?: ExecResult };
        err.result = { stdout: '', stderr: `${cmd} 模拟失败`, code: 1 } as ExecResult;
        throw err;
      }
      const stdout = cmd === 'npm' ? (opts.packOut ?? PACK_JSON('@scope/foo', 'scope-foo-1.0.0.tgz')) : '';
      return { stdout, stderr: '', code: 0 } as ExecResult;
    }),
  } as unknown as ProcessService;

  const storage = {
    stat: vi.fn(async (uri: string) => {
      if (!exists.has(uri)) throw new Error('not found');
      return {} as never;
    }),
    delete: vi.fn(async (uri: string) => {
      deleted.push(uri);
    }),
  } as unknown as StoragePick;

  const deps: PackageManagerDeps = {
    proc,
    storage,
    log: { info: () => {}, error: () => {} },
    packagesUri: () => 'workspace:/packages',
    packagesLocal: async () => '/abs/packages',
    rescanPlugins: async () => opts.rescan ?? ['@scope/foo'],
    disablePlugin: vi.fn(async () => {}),
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
    const cmds = h.execCalls.map(c => c.cmd);
    expect(cmds).toEqual(['npm', 'mkdir', 'tar', 'pnpm']);
    // pnpm --filter 用精确包名（npm pack 回报的 name）
    expect(h.execCalls[3].args).toContain('@scope/foo');
  });

  it('目录已存在：直接拒绝，不调 npm', async () => {
    const h = makeHarness({ exists: new Set(['workspace:/packages/foo']) });
    const r = await createPackageManager(h.deps).install('foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已存在');
    expect(h.execCalls).toHaveLength(0);
  });

  it('pack 解析失败：返回错误，不继续 tar', async () => {
    const h = makeHarness({ packOut: 'garbage-not-json' });
    const r = await createPackageManager(h.deps).install('foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未能解析');
    expect(h.execCalls.map(c => c.cmd)).toEqual(['npm']); // 止于 npm pack
  });

  it('tar 失败：回滚清理 targetDir', async () => {
    const h = makeHarness({ failOn: 'tar' });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    // 回滚删除 targetUri（半成品目录）
    expect(h.deleted).toContain('workspace:/packages/foo');
  });

  it('指定版本：@scope/foo@1.2.3 → 目录仍为 foo（去 scope 去版本）', async () => {
    const h = makeHarness({ packOut: PACK_JSON('@scope/foo', 'scope-foo-1.2.3.tgz') });
    const r = await createPackageManager(h.deps).install('@scope/foo@1.2.3');
    expect(r.ok).toBe(true);
    // npm pack 收到完整 spec（含版本）
    expect(h.execCalls[0].args).toContain('@scope/foo@1.2.3');
  });
});

describe('uninstall', () => {
  it('停用实例 + 删目录 + 清残留配置', async () => {
    const h = makeHarness({ exists: new Set(['workspace:/packages/foo']) });
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(true);
    expect(h.deps.disablePlugin).toHaveBeenCalledWith('@scope/foo');
    expect(h.deleted).toContain('workspace:/packages/foo');
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith('@scope/foo');
  });

  it('目录不存在：幂等成功', async () => {
    const h = makeHarness();
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('目录不存在');
    expect(h.deleted).toHaveLength(0);
  });
});
