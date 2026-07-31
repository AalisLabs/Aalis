import { describe, expect, it, vi } from 'vitest';
import {
  buildUpdateSpecs,
  createPackageManager,
  declaresPlugin,
  extractPeerConflicts,
  findUnmetPeers,
  hasWorkspaceProtocol,
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

interface Harness {
  deps: PackageManagerDeps;
  execCalls: Array<{ cmd: string; args: string[] }>;
  deleted: string[]; // rm 删除的路径
}

/**
 * 构造 mock 依赖。
 *
 * `json` 是 readJson 的假文件系统：绝对路径 → 解析后的对象。
 */
function makeHarness(
  opts: {
    exists?: Set<string>;
    packOut?: string;
    failOn?: string; // npm/mkdir/tar/pnpm
    rescan?: string[];
    /** 运行时注册表里已有的插件名——settleInstall 的真正判据。 */
    registered?: string[];
    json?: Record<string, Record<string, unknown>>;
    /** 原样返回的文本文件（优先于 json）；用于快照类断言。 */
    text?: Record<string, string>;
    restarts?: Array<{ reason: string; restore: Array<{ path: string; content: string }> }>;
  } = {},
): Harness {
  const execCalls: Array<{ cmd: string; args: string[] }> = [];
  const deleted: string[] = [];
  const exists = new Set(opts.exists ?? []);

  const proc = {
    // 预检在副本目录里跑，避免 --dry-run 污染 live tree 的 hidden lockfile
    makeTempDir: vi.fn(async () => ({ path: '/tmp/fake-preflight', cleanup: async () => {} })),
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
    readText: async abs => {
      if (opts.text && abs in opts.text) return opts.text[abs];
      const j = opts.json?.[abs];
      return j === undefined ? undefined : JSON.stringify(j);
    },
    rescanPlugins: async () => opts.rescan ?? ['@scope/foo'],
    // 默认认为目标已就位（多数用例走成功路径）；需要测失败态的用例显式传 registered: []
    isPluginRegistered: name => (opts.registered ?? ['@scope/foo', 'foo', '@scope/ui']).includes(name),
    unloadPlugin: vi.fn(async () => {}),
    cleanupConfig: vi.fn(() => {}),
    restartApp: vi.fn(r => {
      opts.restarts?.push(r);
    }),
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

describe('纯函数判据', () => {
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

  it('buildUpdateSpecs 按 argv **字节数**设闸，不按包个数', () => {
    // 真实约束是 execve 的 ARG_MAX（参数块总字节），与包数无关。按个数设闸曾把
    // 「最多 50 个包」定成产品限制，比真实约束低约 600 倍，挡死了协调发版这个主场景。
    const many = Array.from({ length: 2000 }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0' }));
    expect(buildUpdateSpecs(many).error, '两千个短名仍在预算内').toBeUndefined();
    expect(buildUpdateSpecs(many).specs).toHaveLength(2000);

    // 同样的包数、长得多的名字 → 超预算被拒。这正是按个数设闸看不见的那一维。
    const longName = `@scope/${'a'.repeat(180)}`;
    const heavy = Array.from({ length: 2000 }, (_, i) => ({ name: `${longName}${i}`, version: '1.0.0' }));
    const r = buildUpdateSpecs(heavy);
    expect(r.specs).toBeUndefined();
    expect(r.error).toContain('参数总长');
  });

  it('stripVersion：剥版本保 scope', () => {
    expect(stripVersion('@scope/foo@1.2.3')).toBe('@scope/foo');
    expect(stripVersion('@scope/foo')).toBe('@scope/foo'); // scope 的 @ 在下标 0，不当版本分隔
    expect(stripVersion('foo@1.2.3')).toBe('foo');
    expect(stripVersion('foo')).toBe('foo');
  });
});

describe('install（只有一条路径：写根依赖）', () => {
  const rootPkg = `${ROOT}/package.json`;

  it('走 npm install 写根依赖，不碰 packages/ 与 npm pack', async () => {
    const h = makeHarness({
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

  it('非法包名在**服务层**被拒，一次 npm 都不发', async () => {
    // 服务经 ctx.provide 公开，插件能绕过 HTTP 路由直接调——校验不能只放在路由上。
    // `foo@.` / `@a/b@..` 是 npm 的本地目录 spec，`--force` 是真实存在的可发布包名。
    for (const evil of ['--force', 'foo@.', '@a/b@..', '../../etc', '', 'a b']) {
      const h = makeHarness({ json: { [rootPkg]: { dependencies: {} } } });
      const r = await createPackageManager(h.deps).install(evil);
      expect(r.ok, evil).toBe(false);
      expect(r.message, evil).toContain('包名');
      expect(
        h.execCalls.some(c => c.cmd === 'npm'),
        evil,
      ).toBe(false);
    }
  });

  it('硬护栏：根依赖含 workspace: 协议时拒绝执行 npm install', async () => {
    // 这是把 pnpm 工作区搅坏的路径——npm 会写出 package-lock.json 与扁平 node_modules。
    const h = makeHarness({
      json: { [rootPkg]: { dependencies: { '@aalis/core': 'workspace:*' } } },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('workspace:');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false); // 一次都不能发
  });

  it('目标未进注册表、且声明了 aalis-plugin → 显式失败（不再静默假成功）', async () => {
    const h = makeHarness({
      registered: [],
      json: {
        [rootPkg]: {},
        [`${ROOT}/node_modules/@scope/foo/package.json`]: { keywords: ['aalis', 'aalis-plugin'] },
      },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo@1.2.3');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未被加载');
  });

  it('目标未进注册表、但本就不是插件（如 aalis-interface）→ 正常成功', async () => {
    const h = makeHarness({
      registered: [],
      json: {
        [rootPkg]: {},
        [`${ROOT}/node_modules/@scope/ui/package.json`]: { keywords: ['aalis', 'aalis-interface'] },
      },
    });
    const r = await createPackageManager(h.deps).install('@scope/ui');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('非插件包');
  });

  // ── 判据必须是「目标自身是否就位」，不能是 rescan 的返回值 ──
  // rescan 返回的是本次扫描**新加载的全部**插件（core 对已注册者直接跳过），与本次目标无对应。
  // 下面两条是对抗审计实测复现过的误判，用测试钉住。

  it('重装已注册的插件：rescan 恒为空，但目标在注册表里 → 成功（旧判据必然误报失败）', async () => {
    const h = makeHarness({
      rescan: [], // core 跳过已注册者
      registered: ['@scope/foo'], // 但它确实在跑
      json: { [rootPkg]: {} },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo@0.9.1');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('@scope/foo');
  });

  it('并发安装：不把别人的战果算作自己的（旧判据会谎报装了 B）', async () => {
    const h = makeHarness({
      rescan: ['@scope/foo', '@other/bar'], // 并发时 rescan 把两个都捞了
      registered: ['@scope/foo', '@other/bar'],
      json: { [rootPkg]: {} },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('@scope/foo');
    expect(r.message).not.toContain('@other/bar'); // 只报自己的
  });

  it('npm install 失败 → 返回失败而非抛出', async () => {
    const h = makeHarness({ failOn: 'npm', json: { [rootPkg]: {} } });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('npm');
  });
});

describe('update — 参数校验（纯函数）', () => {
  it('产出 name@version spec，保序', () => {
    const r = buildUpdateSpecs([
      { name: '@aalis/core', version: '0.9.2' },
      { name: 'foo', version: '1.0.0-beta.1' },
    ]);
    expect(r.specs).toEqual(['@aalis/core@0.9.2', 'foo@1.0.0-beta.1']);
  });

  it('拒绝空批次', () => {
    expect(buildUpdateSpecs([]).error).toContain('未指定');
  });

  it('拒绝会被 npm 当标志或目录 spec 的名字与版本', () => {
    // npm 把 `-` 开头当命令行标志，把 `.` / `..` 当本地目录 spec（能触发宿主 prepack 脚本）
    for (const bad of ['--force', '.', '..', './x', 'a b', 'a;rm -rf /', '', '@scope/']) {
      expect(buildUpdateSpecs([{ name: bad, version: '1.0.0' }]).error, bad).toContain('非法包名');
    }
    for (const bad of ['-1.0.0', '.', '../x', '1.0.0 && x', '']) {
      expect(buildUpdateSpecs([{ name: 'foo', version: bad }]).error, bad).toContain('非法版本号');
    }
  });

  it('拒绝同一包被指定多次（npm 会静默取最后一个）', () => {
    expect(
      buildUpdateSpecs([
        { name: 'foo', version: '1.0.0' },
        { name: 'foo', version: '2.0.0' },
      ]).error,
    ).toContain('多次');
  });

  // ── 退出码不够用 ──
  // 实测 npm 10.9.2：「改一个已被别人 peer 依赖的包的版本」（正是更新 core 的形状）
  // 只打 warn 且 exit 0，--strict-peer-deps 也不生效。必须再查 dry-run 的输出。
  it('findUnmetPeers 从 exit 0 的 dry-run 输出里揪出与目标相关的未满足 peer', () => {
    const out = [
      'npm warn Could not resolve dependency:',
      'npm warn peer react@"^18.3.1" from react-dom@18.3.1',
      'npm warn node_modules/react-dom',
      'change react 18.3.1 => 17.0.2',
    ].join('\n');
    expect(findUnmetPeers(out, ['react'])).toEqual(['react-dom@18.3.1 需要 react@^18.3.1']);
  });

  it('findUnmetPeers 只认与本次目标相关的：工程里原有的无关未满足 peer 不该阻断更新', () => {
    const out = 'npm warn peer other-lib@"^1.0.0" from someone@2.0.0';
    expect(findUnmetPeers(out, ['react'])).toEqual([]);
  });

  it('findUnmetPeers 去重（npm 会在不同上下文重复打印同一条）', () => {
    const out = [
      'npm warn peer react@"^18.3.1" from react-dom@18.3.1',
      'npm warn peer react@"^18.3.1" from react-dom@18.3.1',
    ].join('\n');
    expect(findUnmetPeers(out, ['react'])).toHaveLength(1);
  });

  it('findUnmetPeers 对无 peer 行的正常输出返回空', () => {
    expect(findUnmetPeers('added 1 package in 200ms', ['react'])).toEqual([]);
    expect(findUnmetPeers('', ['react'])).toEqual([]);
  });

  it('extractPeerConflicts 摘出要点并剥掉 npm 前缀', () => {
    const out = [
      'npm ERR! code ERESOLVE',
      'npm ERR! ERESOLVE could not resolve',
      'npm ERR! Found: @aalis/core@0.9.0',
      'npm ERR! Conflicting peer dependency: @aalis/core@0.10.0',
      'npm ERR! 无关噪声',
    ].join('\n');
    const c = extractPeerConflicts(out);
    expect(c).toContain('Found: @aalis/core@0.9.0');
    expect(c.some(l => l.includes('Conflicting peer'))).toBe(true);
    expect(c.some(l => l.startsWith('npm ERR!'))).toBe(false);
  });
});

describe('update — 流程', () => {
  const rootPkgPath = `${ROOT}/package.json`;
  const lockPath = `${ROOT}/package-lock.json`;
  /** 已装版本从 `node_modules/<name>/package.json` 读——降级守卫与回滚钉版本都吃这一路。 */
  const installedAt = (name: string, version: string) => ({
    [`${ROOT}/node_modules/${name}/package.json`]: JSON.stringify({ name, version }),
  });
  const okHarness = (extra: Record<string, unknown> = {}) =>
    makeHarness({
      text: {
        [rootPkgPath]: '{"dependencies":{"@aalis/core":"^0.9.0"}}',
        [lockPath]: '{"lockfileVersion":3}',
        ...installedAt('@aalis/core', '0.9.0'),
      },
      ...extra,
    });

  it('预检在副本目录里跑，真装在项目根——live tree 不被 --dry-run 触碰', async () => {
    const restarts: Array<{
      reason: string;
      restore: Array<{ path: string; content: string }>;
      postRestore?: { cmd: string; args: string[] };
    }> = [];
    const h = okHarness({ restarts });
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/core', version: '0.9.2' }]);
    expect(r.ok).toBe(true);
    expect(r.restarting).toBe(true);
    const npm = h.execCalls.filter(c => c.cmd === 'npm');
    expect(npm).toHaveLength(2);
    expect(npm[0].args).toContain('--dry-run'); // 先预检
    expect(npm[1].args).not.toContain('--dry-run'); // 再真装
    // 副本里跑：先把 package.json / lockfile cp 过去
    expect(h.execCalls.filter(c => c.cmd === 'cp').length).toBeGreaterThan(0);
    // --strict-peer-deps 已删：实测在副本里带不带都 exit 0，留着只会让人误以为有额外保障
    for (const call of npm) expect(call.args).not.toContain('--strict-peer-deps');
    // 回滚凭据带上 package.json 与 lockfile —— 只回退其一会得到「声明旧版、锁定新版」
    expect(restarts).toHaveLength(1);
    expect(restarts[0].restore.map(f => f.path)).toEqual([rootPkgPath, lockPath]);
    expect(restarts[0].restore[0].content).toContain('@aalis/core');
    // postRestore 必须钉**精确旧版**。裸 `npm install` 只能按还原后的 package.json 重解析，
    // 而 `^0.9.0` 覆盖刚崩掉的 0.9.2 —— npm 会把它原样装回来，回滚成为一句谎话。
    expect(restarts[0].postRestore?.args).toContain('@aalis/core@0.9.0');
    expect(restarts[0].postRestore?.args).toContain('--no-save'); // 别让 npm 把声明改写成 ^0.9.0
  });

  it('拒绝降级：目标版本不高于本地已装版本（registry 的 latest 可能被回滚 tag 到旧版）', async () => {
    const h = okHarness();
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/core', version: '0.8.0' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('降级');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false); // 一次 npm 都不发
  });

  it('拒绝同版本重装：字符串不等判据会放行，版本序判据不会', async () => {
    const h = okHarness();
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/core', version: '0.9.0' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('降级');
  });

  it('读不到本地已装版本 → 拒绝（无从判断方向就不动）', async () => {
    const h = makeHarness({
      text: { [rootPkgPath]: '{"dependencies":{"@aalis/core":"^0.9.0"}}' }, // 无 node_modules 记录
    });
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/core', version: '0.9.2' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未知');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('无 lockfile 时把 lockfile 标记为「更新前不存在」（回滚要删而非写空）', async () => {
    const restarts: Array<{ reason: string; restore: Array<{ path: string; deleteIfEmpty?: boolean }> }> = [];
    const h = makeHarness({
      text: { [rootPkgPath]: '{"dependencies":{"foo":"^1.0.0"}}', ...installedAt('foo', '1.0.0') },
      restarts,
    });
    const r = await createPackageManager(h.deps).update([{ name: 'foo', version: '1.1.0' }]);
    expect(r.ok).toBe(true);
    const lock = restarts[0].restore.find(f => f.path === lockPath);
    // 留着这个 npm 新建的 lockfile 会让 postRestore 判定 up-to-date，把回滚变成谎话
    expect(lock?.deleteIfEmpty).toBe(true);
  });

  it('拒绝更新传递依赖：npm 会提升进根依赖并留下嵌套第二份（两份 declare module 撞 TS2717）', async () => {
    // 闸在服务层而非路由——服务经 ctx.provide 公开，插件能绕过前端直接调
    const h = makeHarness({
      text: { [rootPkgPath]: '{"dependencies":{"@aalis/plugin-agent":"^0.9.0"}}' },
    });
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/schema-message', version: '0.6.0' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('第二份副本');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false); // 一次 npm 都不发
  });

  it('拒绝更新非 registry 来源（file:/git 等）', async () => {
    for (const spec of ['file:../local', 'link:../x', 'github:user/repo', 'https://example.com/a.tgz']) {
      const h = makeHarness({
        text: { [rootPkgPath]: JSON.stringify({ dependencies: { foo: spec } }) },
      });
      const r = await createPackageManager(h.deps).update([{ name: 'foo', version: '1.0.0' }]);
      expect(r.ok, spec).toBe(false);
      expect(
        h.execCalls.some(c => c.cmd === 'npm'),
        spec,
      ).toBe(false);
    }
  });

  it('预检失败 → 不改任何文件、不重启，返回冲突要点', async () => {
    const restarts: Array<never> = [];
    const h = okHarness({ failOn: 'npm', restarts });
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/core', version: '0.9.2' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('预检未通过');
    expect(h.execCalls.filter(c => c.cmd === 'npm')).toHaveLength(1); // 止于预检，没跑真装
    expect(h.deps.restartApp).not.toHaveBeenCalled();
    expect(restarts).toHaveLength(0);
  });

  it('根依赖含 workspace: 协议 → 拒绝（与 install 同一护栏）', async () => {
    const h = makeHarness({
      text: { [rootPkgPath]: '{"dependencies":{"@aalis/core":"workspace:*"}}' },
    });
    const r = await createPackageManager(h.deps).update([{ name: 'foo', version: '1.0.0' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('workspace:');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('宿主未提供重启能力 → 提前拒绝，不跑任何 npm', async () => {
    const h = okHarness();
    h.deps.restartApp = undefined;
    const r = await createPackageManager(h.deps).update([{ name: 'foo', version: '1.0.0' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('重启');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// 串行闸
//
// install / uninstall / update 都改**同一个**根 package.json，而 npm 是「读整份 →
// 改内存 → 整份写回」。并行 = 丢失更新：后写者整份覆盖，先写者新增的依赖消失，而包的
// 文件已落进 node_modules —— 加载器只遍历根依赖的键、从不扫目录，那个包就此永不加载。
//
// 拒绝而非排队：update 成功后进程立即重启，排在后面的操作必然被腰斩在半路。
// ════════════════════════════════════════════════════════════

describe('串行闸（一次只允许一个包管理操作）', () => {
  const rootPkgPath = `${ROOT}/package.json`;

  /** 让 npm 命令挂起到我们放行为止，好制造「操作进行中」的窗口。 */
  function gatedHarness() {
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const h = makeHarness({
      text: { [rootPkgPath]: '{"dependencies":{"foo":"^1.0.0","bar":"^1.0.0"}}' },
    });
    const orig = h.deps.proc.execFile;
    h.deps.proc.execFile = (async (cmd: string, args: readonly string[], opts: unknown) => {
      if (cmd === 'npm') await gate;
      return (orig as (...a: unknown[]) => unknown)(cmd, args, opts);
    }) as typeof h.deps.proc.execFile;
    return { h, release };
  }

  it('安装进行中时，第二个安装被拒绝而非排队', async () => {
    const { h, release } = gatedHarness();
    const pm = createPackageManager(h.deps);
    const first = pm.install('foo');
    // 让第一个走到挂起的 npm 调用
    await new Promise(r => setTimeout(r, 0));
    const second = await pm.install('bar');
    expect(second.ok).toBe(false);
    expect(second.message).toContain('正在进行中');
    release();
    expect((await first).ok).toBe(true);
  });

  it('闸跨操作类型生效：安装进行中时卸载与更新同样被拒', async () => {
    const { h, release } = gatedHarness();
    const pm = createPackageManager(h.deps);
    const first = pm.install('foo');
    await new Promise(r => setTimeout(r, 0));
    expect((await pm.uninstall('bar')).message).toContain('正在进行中');
    expect((await pm.update([{ name: 'foo', version: '1.0.1' }])).message).toContain('正在进行中');
    release();
    await first;
  });

  it('操作结束后释放，后续可正常进行', async () => {
    const { h, release } = gatedHarness();
    const pm = createPackageManager(h.deps);
    const first = pm.install('foo');
    await new Promise(r => setTimeout(r, 0));
    release();
    await first;
    const second = await pm.install('bar');
    expect(second.ok).toBe(true); // 闸已放开
  });

  it('失败也释放：不会因一次报错就把闸永久卡死', async () => {
    const h = makeHarness({
      failOn: 'npm',
      text: { [rootPkgPath]: '{"dependencies":{"foo":"^1.0.0"}}' },
    });
    const pm = createPackageManager(h.deps);
    expect((await pm.install('foo')).ok).toBe(false);
    const again = await pm.install('foo');
    expect(again.message).not.toContain('正在进行中'); // 闸已释放，是真的又跑了一次
  });

  it('update 成功后**不释放**：重启是延迟发生的，此窗口内的新操作会被 process.exit 腰斩', async () => {
    const h = makeHarness({
      text: {
        [rootPkgPath]: '{"dependencies":{"foo":"^1.0.0"}}',
        [`${ROOT}/node_modules/foo/package.json`]: '{"name":"foo","version":"1.0.0"}',
      },
    });
    const pm = createPackageManager(h.deps);
    const r = await pm.update([{ name: 'foo', version: '1.0.1' }]);
    expect(r.ok).toBe(true);
    expect(r.restarting).toBe(true);
    const after = await pm.install('bar');
    expect(after.ok).toBe(false);
    expect(after.message).toContain('正在进行中');
  });
});

describe('uninstall', () => {
  const rootPkgPath = `${ROOT}/package.json`;
  /** 目标包的 package.json（决定类型闸）+ 根依赖声明（决定来源闸）。 */
  const harness = (keywords: string[], request = '^1.0.0') =>
    makeHarness({
      text: {
        [rootPkgPath]: JSON.stringify({ dependencies: { '@scope/foo': request } }),
        [`${ROOT}/node_modules/@scope/foo/package.json`]: JSON.stringify({ name: '@scope/foo', keywords }),
      },
    });

  it('插件：npm uninstall 摘根依赖 + unload + 清残留配置', async () => {
    // 只 dispose 运行时实例是不够的——依赖声明还在，下次启动加载器会把它装载回来。
    const h = harness(['aalis', 'aalis-plugin']);
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(true);
    const npm = h.execCalls.filter(c => c.cmd === 'npm');
    expect(npm).toHaveLength(1);
    expect(npm[0].args[0]).toBe('uninstall');
    expect(npm[0].args).toContain('@scope/foo');
    expect(h.deleted, '不再 rm -rf 任何目录——那条路径能删掉用户自己的源码').toHaveLength(0);
    expect(h.deps.unloadPlugin).toHaveBeenCalledWith('@scope/foo');
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith('@scope/foo');
  });

  it('前端界面包同样可卸（与插件并列为「用户主动装」的两类）', async () => {
    const h = harness(['aalis', 'aalis-interface']);
    expect((await createPackageManager(h.deps).uninstall('@scope/foo')).ok).toBe(true);
  });

  // ── 闸一：类型 ──
  it.each([
    ['aalis-core', '内核'],
    ['aalis-runtime', '宿主'],
    ['aalis-api', '服务契约'],
    ['aalis-schema', '数据规范'],
    ['aalis-util', '工具库'],
  ])('拒卸 %s（%s 不是插件，不在市场职权内）', async (kw, label) => {
    const h = harness(['aalis', kw]);
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain(label);
    // 措辞必须指出带外途径：owner 权限很高，拦的不是权限而是「这个操作会销毁你用来撤销它的通道」
    expect(r.message).toContain('npm uninstall');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
    expect(h.deps.unloadPlugin).not.toHaveBeenCalled();
  });

  // ── 闸二：来源 ──
  it.each([
    ['workspace:*', 'git'],
    ['file:../local', '源码'],
    ['github:u/r', '依赖声明'],
    ['npm:other@^1', '依赖声明'],
  ])('拒卸非 registry 来源 %s', async (request, hint) => {
    const h = harness(['aalis', 'aalis-plugin'], request);
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok, request).toBe(false);
    expect(r.message, request).toContain(hint);
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('传递依赖（不在根依赖里）→ 拒绝，说明它随父包被自动剪枝', async () => {
    const h = makeHarness({
      text: {
        [rootPkgPath]: '{"dependencies":{}}',
        [`${ROOT}/node_modules/@scope/foo/package.json`]: '{"name":"@scope/foo","keywords":["aalis-plugin"]}',
      },
    });
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('剪枝');
  });

  it('读不到目标 package.json → 拒绝（无从确认它是什么就不动）', async () => {
    const h = makeHarness({ text: { [rootPkgPath]: '{"dependencies":{"@scope/foo":"^1.0.0"}}' } });
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('无法确认');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('非法包名在服务层被拒，一次 npm 都不发', async () => {
    for (const evil of ['../../etc', '@x/../../etc', 'a/b', '..', '--force']) {
      const h = harness(['aalis-plugin']);
      const r = await createPackageManager(h.deps).uninstall(evil);
      expect(r.ok, evil).toBe(false);
      expect(r.message, evil).toContain('非法包名');
      expect(
        h.execCalls.some(c => c.cmd === 'npm'),
        evil,
      ).toBe(false);
      expect(h.deps.unloadPlugin).not.toHaveBeenCalled();
    }
  });
});
