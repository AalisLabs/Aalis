import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { createPackageManager, type PackageManagerDeps } from '../../packages/plugin-package-manager/src/index.js';

const pexec = promisify(execFile);

// ════════════════════════════════════════════════════════════
// 安装链 — 对着**真实 npm 子进程**的集成测试
//
// 为什么必须真跑 npm：本仓库是 workspace 形态，走的是 createFsPluginLoader；而
// standalone（脚手架，第一等公民）那条路——写根 dependencies、npm uninstall 摘依赖、
// dry-run 预检——在 monorepo 里一次都不会被执行。mock 掉 npm 的单测能验分支选择，
// 验不了「npm 到底把 package.json 改成什么样」。
//
// 尤其是 peer 预检：曾误信 `--strict-peer-deps` 能挡住「改被别人 peer 依赖的包的版本」，
// 直到真跑才发现 npm 对命令行显式 spec 只 warn 且 exit 0。那条只有真 npm 能证伪。
//
// 联网不可用时整组跳过，不让 CI 因网络红。
// ════════════════════════════════════════════════════════════

// 探测必须在**顶层**做，不能放 beforeAll：`it.runIf(cond)` 在收集阶段就求值，
// 那时 beforeAll 还没跑，条件恒为初始值，联网用例会被无声跳过（踩过一次）。
const root = mkdtempSync(join(tmpdir(), 'aalis-install-chain-'));

/** 真实 process 网关：直接 spawn，不 mock。 */
const realProc = {
  async execFile(cmd: string, args: readonly string[], opts?: { cwd?: string; timeout?: number }) {
    try {
      const { stdout, stderr } = await pexec(cmd, [...args], {
        cwd: opts?.cwd,
        timeout: opts?.timeout,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0 };
    } catch (e) {
      const err = new Error((e as Error).message) as Error & { result?: unknown };
      const ex = e as { stdout?: string; stderr?: string; code?: number };
      err.result = { stdout: ex.stdout ?? '', stderr: ex.stderr ?? '', code: ex.code ?? 1 };
      throw err;
    }
  },
  async readExternalFile(p: string) {
    return new Uint8Array(readFileSync(p));
  },
  /** 预检要在项目副本里跑（不碰 live tree），这里给真实临时目录。 */
  async makeTempDir(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), `aalis-${prefix}-`));
    return { path: dir, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
  },
} as unknown as PackageManagerDeps['proc'];

function makePm(projectRoot: string, restarts: unknown[] = []) {
  return createPackageManager({
    proc: realProc,
    log: { info: () => {}, error: () => {} },
    packagesDir: () => join(projectRoot, 'packages'),
    projectRoot: () => projectRoot,
    readText: async p => {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return undefined;
      }
    },
    rescanPlugins: async () => [],
    isPluginRegistered: () => false,
    unloadPlugin: async () => {},
    cleanupConfig: () => {},
    restartApp: r => {
      restarts.push(r);
    },
  });
}

const deps = (p: string): Record<string, string> =>
  (JSON.parse(readFileSync(join(p, 'package.json'), 'utf-8')).dependencies ?? {}) as Record<string, string>;

// 脚手架形态：有 package.json，**无** pnpm-workspace.yaml、无 packages/
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ name: 'probe', version: '1.0.0', private: true, dependencies: {} }, null, 2),
);
/** registry 可达吗——真装一个极小的包来判。不可达则整组联网用例跳过，不让 CI 因网络红。 */
const npmUsable = await (async () => {
  try {
    await pexec('npm', ['install', 'is-odd@3.0.0', '--no-audit', '--no-fund'], { cwd: root, timeout: 180_000 });
    return existsSync(join(root, 'node_modules/is-odd/package.json'));
  } catch {
    return false;
  }
})();

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('安装链（真实 npm）', () => {
  it.runIf(npmUsable)(
    'standalone 卸载：把包从根 dependencies 里摘掉（只 dispose 运行时实例不够，重启后会复活）',
    async () => {
      expect(deps(root)['is-odd']).toBeDefined();
      const r = await makePm(root).uninstall('is-odd');
      expect(r.ok).toBe(true);
      expect(deps(root)['is-odd']).toBeUndefined();
    },
    240_000,
  );

  it.runIf(npmUsable)(
    'standalone 安装：写根 dependencies + node_modules，且不建 packages/ 死目录',
    async () => {
      const r = await makePm(root).install('is-odd@3.0.1');
      expect(r.ok).toBe(true);
      expect(deps(root)['is-odd']).toBeDefined();
      expect(existsSync(join(root, 'node_modules/is-odd/package.json'))).toBe(true);
      // 旧实现会解包到 packages/<dir>，而 node_modules 加载器只读根 dependencies → 永不加载
      expect(existsSync(join(root, 'packages'))).toBe(false);
    },
    240_000,
  );

  it.runIf(npmUsable)(
    '批量更新：真装 + 回滚凭据快照 package.json 与 lockfile（只回其一会得到「声明旧版、锁定新版」）',
    async () => {
      const restarts: Array<{ restore: Array<{ path: string; content: string }> }> = [];
      const before = readFileSync(join(root, 'package.json'), 'utf-8');
      const r = await makePm(root, restarts).update([{ name: 'is-odd', version: '3.0.0' }]);
      expect(r.ok).toBe(true);
      expect(r.restarting).toBe(true);
      expect(restarts).toHaveLength(1);
      const paths = restarts[0].restore.map(f => f.path);
      expect(paths).toContain(join(root, 'package.json'));
      expect(paths).toContain(join(root, 'package-lock.json'));
      expect(restarts[0].restore[0].content).toBe(before); // 快照是更新前的内容
    },
    240_000,
  );

  it.runIf(npmUsable)(
    'peer 冲突被预检挡住：零文件改动、不重启（npm 对显式 spec 只 warn 且 exit 0，退出码不可信）',
    async () => {
      const p = mkdtempSync(join(tmpdir(), 'aalis-peer-'));
      try {
        writeFileSync(
          join(p, 'package.json'),
          JSON.stringify(
            { name: 'peer', version: '1.0.0', private: true, dependencies: { react: '18.3.1', 'react-dom': '18.3.1' } },
            null,
            2,
          ),
        );
        await pexec('npm', ['install', '--no-audit', '--no-fund'], { cwd: p, timeout: 240_000 });
        const before = readFileSync(join(p, 'package.json'), 'utf-8');
        const restarts: unknown[] = [];
        // react-dom@18.3.1 的 peer 要 react@^18.3.1，把 react 降到 17 必须被挡下
        const r = await makePm(p, restarts).update([{ name: 'react', version: '17.0.2' }]);
        expect(r.ok).toBe(false);
        expect(r.conflicts?.some(c => c.includes('react-dom'))).toBe(true);
        expect(restarts).toHaveLength(0);
        expect(readFileSync(join(p, 'package.json'), 'utf-8')).toBe(before);
        expect(JSON.parse(readFileSync(join(p, 'node_modules/react/package.json'), 'utf-8')).version).toBe('18.3.1');
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it.runIf(npmUsable)(
    '用户 .npmrc 有 legacy-peer-deps=true 时仍拦得住（预检在副本里跑 + 环境变量压制）',
    async () => {
      // 这是「预检必须隔离到副本」的核心理由之一：legacy-peer-deps=true 是 React 生态
      // 常见 workaround，它会让 npm **完全不报** peer 告警——若预检在项目根跑，唯一的
      // 护栏就此静默失效，冲突被放行。
      const p = mkdtempSync(join(tmpdir(), 'aalis-legacy-'));
      try {
        writeFileSync(
          join(p, 'package.json'),
          JSON.stringify(
            { name: 'lg', version: '1.0.0', private: true, dependencies: { react: '18.3.1', 'react-dom': '18.3.1' } },
            null,
            2,
          ),
        );
        writeFileSync(join(p, '.npmrc'), 'legacy-peer-deps=true\n');
        await pexec('npm', ['install', '--no-audit', '--no-fund'], { cwd: p, timeout: 240_000 });
        const before = readFileSync(join(p, 'package.json'), 'utf-8');
        const r = await makePm(p, []).update([{ name: 'react', version: '17.0.2' }]);
        expect(r.ok).toBe(false);
        expect(r.conflicts?.some(c => c.includes('react-dom'))).toBe(true);
        expect(readFileSync(join(p, 'package.json'), 'utf-8')).toBe(before);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it.runIf(npmUsable)(
    '更新真的换掉了 node_modules 里的代码（预检的 --dry-run 会写脏 hidden lockfile，不清则真装被跳过）',
    async () => {
      // 这条只有真跑 npm 才能证伪。实测（npm 10.9.2）：`--dry-run` 不碰 package.json 与
      // package-lock.json，却会把 node_modules/.package-lock.json 写成「目标版本已装」；
      // 紧接着的真装读到它就 `up to date` 什么都不做。症状是 package.json 与 lockfile
      // 都成了新版、node_modules 里仍是旧代码，而旧代码起得来 → 重启成功 → 回滚永不触发
      // → 更新全程空转却报成功，且 lockfile 从此在撒谎（日后 npm ci 会无看守地跳版）。
      const p = mkdtempSync(join(tmpdir(), 'aalis-dryrun-'));
      try {
        writeFileSync(
          join(p, 'package.json'),
          JSON.stringify({ name: 'd', version: '1.0.0', private: true, dependencies: { 'is-odd': '3.0.0' } }, null, 2),
        );
        await pexec('npm', ['install', '--no-audit', '--no-fund'], { cwd: p, timeout: 240_000 });
        const installed = () =>
          JSON.parse(readFileSync(join(p, 'node_modules/is-odd/package.json'), 'utf-8')).version as string;
        expect(installed()).toBe('3.0.0');

        const r = await makePm(p, []).update([{ name: 'is-odd', version: '3.0.1' }]);
        expect(r.ok).toBe(true);
        // 三者必须一致——只要有一个还停在 3.0.0，就是「声明新版、跑旧代码」
        expect(installed()).toBe('3.0.1');
        expect(deps(p)['is-odd']).toContain('3.0.1');
        expect(
          JSON.parse(readFileSync(join(p, 'package-lock.json'), 'utf-8')).packages['node_modules/is-odd'].version,
        ).toBe('3.0.1');
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it.runIf(npmUsable)(
    '原本无 lockfile 时，回滚凭据标记「该文件更新前不存在」（留着它会让重装判定 up-to-date，回滚变谎话）',
    async () => {
      const p = mkdtempSync(join(tmpdir(), 'aalis-nolock-'));
      try {
        // 模拟 pnpm/yarn 装出来的工程：有 node_modules 与 package.json，但无 package-lock.json
        writeFileSync(
          join(p, 'package.json'),
          JSON.stringify({ name: 'n', version: '1.0.0', private: true, dependencies: { 'is-odd': '^3.0.0' } }, null, 2),
        );
        await pexec('npm', ['install', '--no-audit', '--no-fund'], { cwd: p, timeout: 240_000 });
        rmSync(join(p, 'package-lock.json'), { force: true });

        const restarts: Array<{ restore: Array<{ path: string; deleteIfEmpty?: boolean }> }> = [];
        const r = await makePm(p, restarts).update([{ name: 'is-odd', version: '3.0.1' }]);
        expect(r.ok).toBe(true);
        const lockEntry = restarts[0].restore.find(f => f.path.endsWith('package-lock.json'));
        expect(lockEntry?.deleteIfEmpty).toBe(true); // 回滚时删除而非写空
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    },
    480_000,
  );

  it('工作区护栏：根依赖含 workspace: 协议时拒绝跑 npm（不联网也能验）', async () => {
    const p = mkdtempSync(join(tmpdir(), 'aalis-ws-'));
    try {
      writeFileSync(
        join(p, 'package.json'),
        JSON.stringify({ name: 'w', version: '1.0.0', private: true, dependencies: { foo: 'workspace:*' } }, null, 2),
      );
      const pm = makePm(p);
      expect((await pm.install('is-odd')).ok).toBe(false);
      expect((await pm.update([{ name: 'is-odd', version: '3.0.1' }])).ok).toBe(false);
      // npm 一次都不该被执行：它会在 pnpm 仓库根写出 package-lock.json 与扁平 node_modules
      expect(existsSync(join(p, 'node_modules'))).toBe(false);
      expect(existsSync(join(p, 'package-lock.json'))).toBe(false);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  }, 60_000);

  it('工作区形态拒绝市场更新：包来自本地 packages/，升级走 git（不联网也能验）', async () => {
    const p = mkdtempSync(join(tmpdir(), 'aalis-wsl-'));
    try {
      mkdirSync(join(p, 'packages'), { recursive: true });
      writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'w', version: '1.0.0', private: true }));
      writeFileSync(join(p, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      const r = await makePm(p).update([{ name: 'is-odd', version: '3.0.1' }]);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('工作区');
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  }, 60_000);
});
