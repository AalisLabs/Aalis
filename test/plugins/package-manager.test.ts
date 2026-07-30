import { describe, expect, it, vi } from 'vitest';
import {
  createPackageManager,
  declaresPlugin,
  hasWorkspaceProtocol,
  layoutFromWorkspaceFile,
  type PackageManagerDeps,
  parsePackInfo,
  stripVersion,
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
const ROOT = '/abs';
const WORKSPACE_FILE = `${ROOT}/pnpm-workspace.yaml`;

interface Harness {
  deps: PackageManagerDeps;
  execCalls: Array<{ cmd: string; args: string[] }>;
  deleted: string[]; // rm 删除的路径
}

/**
 * 构造 mock 依赖。
 *
 * `layout` 决定形态探测的结果——实现读 `<root>/pnpm-workspace.yaml` 是否存在，
 * 故 workspace 形态需把该文件塞进 exists 集（默认即 workspace，保持既有用例语义不变）。
 * `json` 是 readJson 的假文件系统：绝对路径 → 解析后的对象。
 */
function makeHarness(
  opts: {
    exists?: Set<string>;
    packOut?: string;
    failOn?: string; // npm/mkdir/tar/pnpm
    rescan?: string[];
    layout?: 'workspace' | 'standalone';
    json?: Record<string, Record<string, unknown>>;
  } = {},
): Harness {
  const execCalls: Array<{ cmd: string; args: string[] }> = [];
  const deleted: string[] = [];
  const exists = new Set(opts.exists ?? []);
  if ((opts.layout ?? 'workspace') === 'workspace') exists.add(WORKSPACE_FILE);

  const proc = {
    execFile: vi.fn(async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
      execCalls.push({ cmd, args: [...args] });
      if (cmd === 'test') {
        // test -d|-f <path>：存在返回 0，否则 exit 1（抛错）
        if (exists.has(args[1])) return { stdout: '', stderr: '', code: 0 } as ExecResult;
        const e = new Error('test: 不存在') as Error & { result?: ExecResult };
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
    projectRoot: () => ROOT,
    readJson: async abs => opts.json?.[abs],
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

describe('纯函数判据', () => {
  it('layoutFromWorkspaceFile：有 pnpm-workspace.yaml 才是 workspace', () => {
    expect(layoutFromWorkspaceFile(true)).toBe('workspace');
    expect(layoutFromWorkspaceFile(false)).toBe('standalone'); // 脚手架不写该文件
  });

  it('hasWorkspaceProtocol：任一依赖块出现 workspace: 即为真', () => {
    expect(hasWorkspaceProtocol({ dependencies: { a: 'workspace:*' } })).toBe(true);
    expect(hasWorkspaceProtocol({ devDependencies: { a: 'workspace:>=0.5.0 <1.0.0' } })).toBe(true);
    expect(hasWorkspaceProtocol({ optionalDependencies: { a: 'workspace:^' } })).toBe(true);
    expect(hasWorkspaceProtocol({ dependencies: { a: '^1.0.0' } })).toBe(false);
    expect(hasWorkspaceProtocol({})).toBe(false);
    expect(hasWorkspaceProtocol(undefined)).toBe(false);
    // 非字符串值不应崩
    expect(hasWorkspaceProtocol({ dependencies: { a: null } as unknown as Record<string, unknown> })).toBe(false);
  });

  it('declaresPlugin：仅认 aalis-plugin 关键词（与两个加载器同一判据）', () => {
    expect(declaresPlugin({ keywords: ['aalis', 'aalis-plugin'] })).toBe(true);
    expect(declaresPlugin({ keywords: ['aalis', 'aalis-interface'] })).toBe(false);
    expect(declaresPlugin({ keywords: [] })).toBe(false);
    expect(declaresPlugin({})).toBe(false);
    expect(declaresPlugin(undefined)).toBe(false);
  });

  it('stripVersion：剥版本保 scope', () => {
    expect(stripVersion('@scope/foo@1.2.3')).toBe('@scope/foo');
    expect(stripVersion('@scope/foo')).toBe('@scope/foo'); // scope 的 @ 在下标 0，不当版本分隔
    expect(stripVersion('foo@1.2.3')).toBe('foo');
    expect(stripVersion('foo')).toBe('foo');
  });
});

describe('install — standalone（脚手架形态，第一等公民）', () => {
  const rootPkg = `${ROOT}/package.json`;

  it('走 npm install 写根依赖，不碰 packages/ 与 npm pack', async () => {
    const h = makeHarness({
      layout: 'standalone',
      rescan: ['@scope/foo'],
      json: { [rootPkg]: { dependencies: { '@aalis/core': '^0.9.0' } } },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(true);
    const npm = h.execCalls.filter(c => c.cmd === 'npm');
    expect(npm).toHaveLength(1);
    expect(npm[0].args[0]).toBe('install'); // 不是 pack
    expect(npm[0].args).toContain('@scope/foo');
    // 死目录路径的三件套一个都不该出现
    expect(h.execCalls.some(c => c.cmd === 'tar' || c.cmd === 'pnpm')).toBe(false);
  });

  it('硬护栏：根依赖含 workspace: 协议时拒绝执行 npm install', async () => {
    // 这是把 pnpm 工作区搅坏的路径——npm 会写出 package-lock.json 与扁平 node_modules。
    const h = makeHarness({
      layout: 'standalone',
      json: { [rootPkg]: { dependencies: { '@aalis/core': 'workspace:*' } } },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('workspace:');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false); // 一次都不能发
  });

  it('装完没发现新插件、且目标声明了 aalis-plugin → 显式失败（不再静默假成功）', async () => {
    const h = makeHarness({
      layout: 'standalone',
      rescan: [],
      json: {
        [rootPkg]: {},
        [`${ROOT}/node_modules/@scope/foo/package.json`]: { keywords: ['aalis', 'aalis-plugin'] },
      },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo@1.2.3');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未被加载');
  });

  it('装完没发现新插件、但目标本就不是插件（如 aalis-interface）→ 正常成功', async () => {
    const h = makeHarness({
      layout: 'standalone',
      rescan: [],
      json: {
        [rootPkg]: {},
        [`${ROOT}/node_modules/@scope/ui/package.json`]: { keywords: ['aalis', 'aalis-interface'] },
      },
    });
    const r = await createPackageManager(h.deps).install('@scope/ui');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('非插件包');
  });

  it('npm install 失败 → 返回失败而非抛出', async () => {
    const h = makeHarness({ layout: 'standalone', failOn: 'npm', json: { [rootPkg]: {} } });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('npm');
  });
});

describe('install — workspace 形态下的空 rescan', () => {
  it('声明了插件却没被发现 → 显式失败（旧行为是 ok:true 的静默假成功）', async () => {
    const h = makeHarness({
      rescan: [],
      json: { [`${PKG_DIR}/foo/package.json`]: { keywords: ['aalis-plugin'] } },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未被加载');
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

  it('standalone：走 npm uninstall 摘根依赖，而非 rm -rf packages/', async () => {
    // 只 dispose 运行时实例是不够的——依赖声明还在，下次启动加载器会把它装载回来。
    const h = makeHarness({ layout: 'standalone' });
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('根依赖');
    const npm = h.execCalls.filter(c => c.cmd === 'npm');
    expect(npm).toHaveLength(1);
    expect(npm[0].args[0]).toBe('uninstall');
    expect(npm[0].args).toContain('@scope/foo');
    expect(h.deleted).toHaveLength(0); // 不删任何目录
    expect(h.deps.unloadPlugin).toHaveBeenCalledWith('@scope/foo');
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith('@scope/foo');
  });

  it('拒绝路径穿越的插件名：绝不 rm packages 外目录', async () => {
    for (const evil of ['../../etc', '@x/../../etc', 'a/b', '..']) {
      const h = makeHarness({ exists: new Set([`${PKG_DIR}/${evil.replace(/^@[^/]+\//, '')}`]) });
      const r = await createPackageManager(h.deps).uninstall(evil);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('非法插件名');
      expect(h.deleted).toHaveLength(0); // 一次 rm 都不能发
      expect(h.deps.unloadPlugin).not.toHaveBeenCalled();
    }
  });
});
