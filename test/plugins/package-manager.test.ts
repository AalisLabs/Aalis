import { getEventListeners } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { packageManager } from '../../packages/api-package-manager/src/index.js';
import { pluginSource } from '../../packages/api-plugin-source/src/index.js';
import {
  type App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  type PluginState,
  provide,
  services,
} from '../../packages/core/src/index.js';
import packageManagerPlugin, {
  buildUpdateSpecs,
  createPackageManager,
  describeNpmFailure,
  extractPeerConflicts,
  findServiceDependents,
  findUnmetPeers,
  hasWorkspaceProtocol,
  nonMarketKind,
  type PackageManagerDeps,
  stripVersion,
  validatePackageSpec,
} from '../../packages/plugin-package-manager/src/index.js';
import { createNodeModulesPluginLoader } from '../../packages/runtime/src/node-modules-loader.js';
import { createPluginDiscovery } from '../../packages/runtime/src/plugin-discovery.js';
import { isTextRef, resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { deferred } from '../helpers/deferred.js';

// 从被测模块的依赖契约推导类型，避免测试直接 import api 包（knip unlisted-dep）
type ProcessService = PackageManagerDeps['proc'];
type ExecResult = Awaited<ReturnType<ProcessService['execFile']>>;

// ════════════════════════════════════════════════════════════
// package-manager — install/uninstall 集成测试（mock process 服务）
//
// createPackageManager(deps) 只吃一张显式依赖表：所有文件操作走 process 子进程
// （npm/cp/test），目标是项目根 package.json 与 node_modules（不经 storage 沙盒）。
// ════════════════════════════════════════════════════════════

const ROOT = '/abs';

/** 一个插件的状态快照（服务依赖者闸读的几项）：requires 是它 uses 里 required 的服务 */
function snap(name: string, state: PluginState, { provides = [] as string[], requires = [] as string[] } = {}) {
  return {
    name,
    instanceId: name,
    state,
    provides,
    uses: requires.map(service => ({ key: service, service, kind: 'required' as const })),
  };
}

interface Harness {
  deps: PackageManagerDeps;
  execCalls: Array<{ cmd: string; args: string[]; env?: Record<string, string | undefined> }>;
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
    /** `npm view <spec> keywords --json` 的原样输出（装前类型闸读它）；缺省为插件关键词。 */
    viewOut?: string;
    failOn?: string; // npm/cp/test
    /** failOn 命中时的 stderr；缺省为「<cmd> 模拟失败」。 */
    failStderr?: string;
    /** `npm view` 失败时的 stderr（装前类型闸连不上源）；不给则照 viewOut 应答。 */
    failView?: string;
    rescan?: string[];
    /** 运行时注册表里已有的插件名 */
    registered?: string[];
    json?: Record<string, Record<string, unknown>>;
    /** 原样返回的文本文件（优先于 json）；用于快照类断言。 */
    text?: Record<string, string>;
    restarts?: Array<{ reason: string; restore: Array<{ path: string; content: string }> }>;
    /** 收集 log.error：npm 的整段输出记在这里。 */
    errors?: string[];
  } = {},
): Harness {
  const execCalls: Harness['execCalls'] = [];
  const deleted: string[] = [];
  const exists = new Set(opts.exists ?? []);

  const proc = {
    // 预检在副本目录里跑，避免 --dry-run 污染 live tree 的 hidden lockfile
    makeTempDir: vi.fn(async () => ({ path: '/tmp/fake-preflight', cleanup: async () => {} })),
    execFile: vi.fn(
      async (cmd: string, args: readonly string[], o?: { env?: Record<string, string> }): Promise<ExecResult> => {
        execCalls.push({ cmd, args: [...args], env: o?.env });
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
        if (cmd === 'npm' && args[0] === 'view') {
          if (opts.failView !== undefined) {
            const err = new Error('npm view 失败') as Error & { result?: ExecResult };
            err.result = { stdout: '', stderr: opts.failView, code: 1 } as ExecResult;
            throw err;
          }
          return { stdout: opts.viewOut ?? '["aalis","aalis-plugin"]', stderr: '', code: 0 } as ExecResult;
        }
        if (opts.failOn === cmd) {
          const err = new Error(`${cmd} 失败`) as Error & { result?: ExecResult };
          err.result = { stdout: '', stderr: opts.failStderr ?? `${cmd} 模拟失败`, code: 1 } as ExecResult;
          throw err;
        }
        return { stdout: '', stderr: '', code: 0 } as ExecResult;
      },
    ),
  } as unknown as ProcessService;

  const deps: PackageManagerDeps = {
    proc,
    log: {
      info: () => {},
      warn: () => {},
      error: (msg: string) => {
        opts.errors?.push(msg);
      },
    },
    signal: new AbortController().signal,
    projectRoot: () => ROOT,
    readText: async abs => {
      if (opts.text && abs in opts.text) return opts.text[abs];
      const j = opts.json?.[abs];
      return j === undefined ? undefined : JSON.stringify(j);
    },
    rescanPlugins: async () => opts.rescan ?? ['@scope/foo'],
    // 默认认为目标已就位（多数用例走成功路径）；需要测失败态的用例显式传 registered: []
    isPluginRegistered: name => (opts.registered ?? ['@scope/foo', 'foo', '@scope/ui']).includes(name),
    loaded: name => (opts.registered ?? ['@scope/foo', 'foo', '@scope/ui']).includes(name),
    pluginStatus: () => [],
    availableServices: () => [],
    idle: async () => {},
    unloadPlugin: vi.fn(async () => {}),
    recoveryChannelProviders: () => [],
    cleanupConfig: vi.fn(async () => {}),
    restartApp: vi.fn(r => {
      opts.restarts?.push(r);
    }),
  };
  return { deps, execCalls, deleted };
}

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
    expect(toSource(r.error)).toContain('参数总长');
  });

  it('nonMarketKind：只有插件与前端界面归市场装卸，其余给出种类码', () => {
    expect(nonMarketKind(['aalis', 'aalis-plugin'])).toBeUndefined();
    expect(nonMarketKind(['aalis', 'aalis-interface'])).toBeUndefined();
    expect(nonMarketKind(['aalis-core'])).toBe('core');
    expect(nonMarketKind(['aalis-runtime'])).toBe('runtime');
    expect(nonMarketKind(['aalis-api'])).toBe('api');
    expect(nonMarketKind(['aalis-schema'])).toBe('schema');
    expect(nonMarketKind(['aalis-util'])).toBe('util');
    expect(nonMarketKind(['odd', 'even'])).toBe('other');
    expect(nonMarketKind(undefined)).toBe('other');
    expect(nonMarketKind('aalis-plugin'), '非数组的 keywords 不算声明').toBe('other');
  });

  describe('findServiceDependents（卸载护栏：断服务依赖检测）', () => {
    const status = [
      snap('@aalis/plugin-llm-openai', 'active', { provides: ['llm'] }),
      snap('@aalis/plugin-agent', 'active', { provides: ['agent'], requires: ['llm'] }),
      snap('@aalis/plugin-llm-deepseek', 'active', { provides: ['llm'] }),
    ];

    it('删了某服务的唯一提供者 → 列出受影响的依赖方', () => {
      const onlyProvider = [status[0], status[1]]; // 仅 openai 提供 llm，agent 需要 llm
      expect(findServiceDependents('@aalis/plugin-llm-openai', onlyProvider, ['llm'])).toEqual(['@aalis/plugin-agent']);
    });

    it.each(['active', 'activating'] as const)('还有别的提供者（%s）→ 删了不致命，无依赖方阻断', state => {
      // openai 与 deepseek 都提供 llm；删 openai，deepseek 仍在提供
      const [openai, agent, deepseek] = status;
      expect(
        findServiceDependents('@aalis/plugin-llm-openai', [openai, agent, { ...deepseek, state }], ['llm']),
      ).toEqual([]);
    });

    it('目标不提供任何服务 → 空', () => {
      expect(findServiceDependents('@aalis/plugin-agent', status, ['llm', 'agent'])).toEqual([]);
    });

    it.each([
      'disabled',
      'error',
      'pending',
    ] as const)('另一个提供者为 %s（没在提供）→ 不算替代，照样列出依赖方', state => {
      const [openai, agent, deepseek] = status;
      expect(
        findServiceDependents('@aalis/plugin-llm-openai', [openai, agent, { ...deepseek, state }], ['llm']),
      ).toEqual(['@aalis/plugin-agent']);
    });

    it.each(['disabled', 'disposed'] as const)('依赖方为 %s，不会被打断 → 不列出', state => {
      const [openai, agent] = status;
      expect(findServiceDependents('@aalis/plugin-llm-openai', [openai, { ...agent, state }], ['llm'])).toEqual([]);
    });

    it.each(['error', 'disabled'] as const)('目标自己为 %s（没在提供）→ 卸掉它断不了谁，不列出依赖方', state => {
      const [openai, agent] = status;
      expect(
        findServiceDependents(
          '@aalis/plugin-llm-openai',
          [
            { ...openai, state },
            { ...agent, state: 'pending' },
          ],
          [],
        ),
      ).toEqual([]);
    });

    it('目标 pending 而缺服务（按共享判据，它自己起不来）→ 卸掉它断不了谁，不列出依赖方', () => {
      const target = snap('@aalis/plugin-memory-vector', 'pending', {
        provides: ['semantic-memory'],
        requires: ['embedding'],
      });
      const dependent = snap('@aalis/plugin-recall', 'pending', { requires: ['semantic-memory'] });
      expect(findServiceDependents('@aalis/plugin-memory-vector', [target, dependent], [])).toEqual([]);
    });

    it('目标 pending 而只是在等（它要的在启动，起来就提供）→ 照常列出依赖方', () => {
      const target = snap('@aalis/plugin-memory-vector', 'pending', {
        provides: ['semantic-memory'],
        requires: ['embedding'],
      });
      const upstream = snap('@aalis/plugin-embedding-ollama', 'activating', { provides: ['embedding'] });
      const dependent = snap('@aalis/plugin-recall', 'pending', { requires: ['semantic-memory'] });
      expect(findServiceDependents('@aalis/plugin-memory-vector', [target, upstream, dependent], [])).toEqual([
        '@aalis/plugin-recall',
      ]);
    });

    it.each([
      ['disabled', 'active'],
      ['error', 'active'],
      ['active', 'error'],
    ] as const)('目标两个实例为 %s、%s：任一实例在提供就列出依赖方，与实例的先后无关', (first, second) => {
      const name = '@aalis/plugin-memory-sqlite';
      const main = snap(name, first, { provides: ['memory'] });
      const extra = { ...snap(name, second, { provides: ['memory'] }), instanceId: `${name}:b` };
      const dependent = snap('@aalis/plugin-session-manager', 'active', { requires: ['memory'] });
      expect(findServiceDependents(name, [main, extra, dependent], ['memory'])).toEqual([
        '@aalis/plugin-session-manager',
      ]);
    });
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
    const npm = h.execCalls.filter(c => c.cmd === 'npm' && c.args[0] !== 'view'); // view 是装前类型闸
    expect(npm).toHaveLength(1);
    expect(npm[0].args[0]).toBe('install'); // 不是 pack
    expect(npm[0].args).toContain('@scope/foo');
    // 死目录路径的三件套一个都不该出现
    expect(h.execCalls.some(c => c.cmd === 'tar' || c.cmd === 'pnpm')).toBe(false);
  });

  // ── 装前类型闸：与卸载同一判据，只装插件与前端界面 ──
  it.each([
    ['["aalis","aalis-core"]', '内核', '(core)', 'put in place by the scaffold'],
    ['["aalis","aalis-api"]', '服务契约', '(service contract)', 'put in place by the scaffold'],
    ['["aalis","aalis-util"]', '工具库', '(utility library)', 'put in place by the scaffold'],
    ['["odd","even"]', '非插件包', '(non-plugin package)', 'only installs packages with'],
    ['', '非插件包', '(non-plugin package)', 'only installs packages with'], // 包没有 keywords 字段时 npm view 什么都不输出
  ])('装前类型闸拒装 keywords=%s（%s），不跑 npm install；种类名与说明按读者语言', async (viewOut, label, en, hint) => {
    const h = makeHarness({ viewOut, json: { [rootPkg]: { dependencies: {} } } });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain(label);
    expect(isTextRef(r.message) && resolveText(r.message, ['en'])).toContain(`@scope/foo ${en} is not a plugin`);
    expect(isTextRef(r.message) && resolveText(r.message, ['en'])).toContain(hint);
    expect(h.execCalls.find(c => c.cmd === 'npm')?.args).toEqual(['view', '@scope/foo', 'keywords', '--json']);
    expect(h.execCalls.some(c => c.cmd === 'npm' && c.args[0] === 'install')).toBe(false);
  });

  it('装前类型闸：前端界面包放行', async () => {
    const h = makeHarness({ viewOut: '["aalis","aalis-interface"]', json: { [rootPkg]: {} } });
    const r = await createPackageManager(h.deps).install('@scope/ui');
    expect(r.ok, toSource(r.message)).toBe(true);
    expect(h.execCalls.some(c => c.cmd === 'npm' && c.args[0] === 'install')).toBe(true);
  });

  it('装前类型闸：版本范围匹配到多个版本时逐版本判，任一版本不归市场即拒', async () => {
    // spec 是范围时 npm view 按版本给出二维数组
    const h = makeHarness({ viewOut: '[["aalis-plugin"],["aalis-api"]]', json: { [rootPkg]: {} } });
    const r = await createPackageManager(h.deps).install('foo@1');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('服务契约');
    expect(h.execCalls.some(c => c.cmd === 'npm' && c.args[0] === 'install')).toBe(false);
  });

  it('npm install 压掉 legacy-peer-deps（与更新预检同一护栏）', async () => {
    const h = makeHarness({ json: { [rootPkg]: {} } });
    expect((await createPackageManager(h.deps).install('@scope/foo')).ok).toBe(true);
    const install = h.execCalls.find(c => c.cmd === 'npm' && c.args[0] === 'install');
    expect(install?.env?.npm_config_legacy_peer_deps).toBe('false');
  });

  it('非法包名在**服务层**被拒，一次 npm 都不发', async () => {
    // 服务经 provide 公开，插件能绕过 HTTP 路由直接调——校验不能只放在路由上。
    // `foo@.` / `@a/b@..` 是 npm 的本地目录 spec，`--force` 是真实存在的可发布包名。
    for (const evil of ['--force', 'foo@.', '@a/b@..', '../../etc', '', 'a b']) {
      const h = makeHarness({ json: { [rootPkg]: { dependencies: {} } } });
      const r = await createPackageManager(h.deps).install(evil);
      expect(r.ok, evil).toBe(false);
      expect(toSource(r.message), evil).toContain('包名');
      expect(
        h.execCalls.some(c => c.cmd === 'npm'),
        evil,
      ).toBe(false);
    }
  });

  it('装与更新认同一套版本写法：带构建元数据（+）的版本两边都收，带路径与标志字符的两边都拒', async () => {
    for (const version of ['1.0.0+build.5', '1.0.0-beta.1', 'next']) {
      expect(validatePackageSpec(`@scope/foo@${version}`), version).toBeUndefined();
      expect(buildUpdateSpecs([{ name: '@scope/foo', version }]).error, version).toBeUndefined();
    }
    for (const version of ['.', '..', '-1.0.0', '1.0.0/x', '^1.0.0', '']) {
      expect(validatePackageSpec(`@scope/foo@${version}`), version).toBeDefined();
      expect(buildUpdateSpecs([{ name: '@scope/foo', version }]).error, version).toBeDefined();
    }
  });

  it('硬护栏：根依赖含 workspace: 协议时拒绝执行 npm install', async () => {
    // 这是把 pnpm 工作区搅坏的路径——npm 会写出 package-lock.json 与扁平 node_modules。
    const h = makeHarness({
      json: { [rootPkg]: { dependencies: { '@aalis/core': 'workspace:*' } } },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('workspace:');
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
    expect(toSource(r.message)).toContain('未被加载');
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
    expect(toSource(r.message)).toContain('非插件包');
    expect(r.plugin, '不进插件列表的包没有插件可指').toBeUndefined();
  });

  it('本就不是插件的包：注册表里有宿主直接登记的同名插件，照样报非插件包，不指向那个插件', async () => {
    const h = makeHarness({
      registered: ['@scope/ui'],
      json: {
        [rootPkg]: {},
        [`${ROOT}/node_modules/@scope/ui/package.json`]: { keywords: ['aalis', 'aalis-interface'] },
      },
    });
    h.deps.loaded = () => false;
    const r = await createPackageManager(h.deps).install('@scope/ui');
    expect(r.ok).toBe(true);
    expect(toSource(r.message)).toContain('非插件包');
    expect(r.plugin).toBeUndefined();
  });

  // ── 判据必须是「目标自身是否就位」，不能是 rescan 的返回值 ──
  // rescan 返回的是本次扫描**新加载的全部**插件（core 对已注册者直接跳过），与本次目标无对应。
  // 下面两条是实测复现过的误判，用测试钉住。

  it('重装已注册的插件：rescan 恒为空，但目标在注册表里 → 成功（旧判据必然误报失败）', async () => {
    const h = makeHarness({
      rescan: [], // core 跳过已注册者
      registered: ['@scope/foo'], // 但它确实在跑
      json: { [rootPkg]: {} },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo@0.9.1');
    expect(r.ok).toBe(true);
    expect(toSource(r.message)).toContain('@scope/foo');
  });

  it('并发安装：不把别人的战果算作自己的（旧判据会谎报装了 B）', async () => {
    const h = makeHarness({
      rescan: ['@scope/foo', '@other/bar'], // 并发时 rescan 把两个都捞了
      registered: ['@scope/foo', '@other/bar'],
      json: { [rootPkg]: {} },
    });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(true);
    expect(toSource(r.message)).toContain('@scope/foo');
    expect(toSource(r.message)).not.toContain('@other/bar'); // 只报自己的
  });

  it('npm install 失败 → 返回失败而非抛出', async () => {
    const h = makeHarness({ failOn: 'npm', json: { [rootPkg]: {} } });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('npm');
  });

  const entry = (instanceId: string, state: PluginState, error?: string) => ({
    name: '@scope/foo',
    instanceId,
    state,
    error,
    provides: [],
    uses: [],
  });

  it('目标已进注册表、但主实例激活失败 → 仍回 ok（包已装上），message 按实际状态说明原因', async () => {
    const h = makeHarness({ registered: ['@scope/foo'], json: { [rootPkg]: {} } });
    h.deps.pluginStatus = () => [entry('@scope/foo', 'error', '缺少配置项 apiKey')];
    expect(toSource(await createPackageManager(h.deps).install('@scope/foo'))).toEqual({
      ok: true,
      message: '已安装 @scope/foo，但激活失败，已转为 error 态（缺少配置项 apiKey）',
      plugin: '@scope/foo',
    });

    // 只看主实例：同名的后缀实例出错不算这次安装的结果
    h.deps.pluginStatus = () => [entry('@scope/foo:b', 'error', '坏配置'), entry('@scope/foo', 'active')];
    expect(toSource(await createPackageManager(h.deps).install('@scope/foo'))).toEqual({
      ok: true,
      message: '已安装并加载：@scope/foo',
      plugin: '@scope/foo',
    });
  });

  it('主实例激活失败的原因与插件页同一说法：core 自己的失败按 code 给说明，英文读者看到英文', async () => {
    const h = makeHarness({ registered: ['@scope/foo'], json: { [rootPkg]: {} } });
    const failure = Object.assign(new Error('core 的诊断句'), { code: 'exclusive-conflict', service: 'llm' });
    h.deps.pluginStatus = () => [{ ...entry('@scope/foo', 'error', 'core 的诊断句'), failure }];
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(toSource(r.message)).toBe(
      '已安装 @scope/foo，但激活失败，已转为 error 态（服务 llm 为独占登记，不能再添加提供者）',
    );
    expect(isTextRef(r.message) && resolveText(r.message, ['en'])).toBe(
      'Installed @scope/foo, but activation failed and it is now in the error state (Service llm is registered exclusively; no other provider can be added)',
    );
  });

  it('读主实例状态前等重算落定；落定后仍在后台激活或在等依赖的，如实说明尚未激活', async () => {
    const h = makeHarness({ registered: ['@scope/foo'], json: { [rootPkg]: {} } });
    // rescan 撞上在飞的重算时登记只排队：落定之前主实例是 pending，落定之后才转 error
    let settled = false;
    h.deps.idle = async () => {
      settled = true;
    };
    h.deps.pluginStatus = () => [
      settled ? entry('@scope/foo', 'error', '缺少配置项 apiKey') : entry('@scope/foo', 'pending'),
    ];
    expect(toSource(await createPackageManager(h.deps).install('@scope/foo'))).toEqual({
      ok: true,
      message: '已安装 @scope/foo，但激活失败，已转为 error 态（缺少配置项 apiKey）',
      plugin: '@scope/foo',
    });

    for (const [state, message] of [
      ['activating', '已安装 @scope/foo，仍在激活（超过慢激活阈值，已转入后台），结果以插件列表为准'],
      ['pending', '已安装 @scope/foo，尚未激活，正在等待 required 依赖满足'],
    ] as const) {
      h.deps.pluginStatus = () => [entry('@scope/foo', state)];
      expect(toSource(await createPackageManager(h.deps).install('@scope/foo'))).toEqual({
        ok: true,
        message,
        plugin: '@scope/foo',
      });
    }
  });
});

// ════════════════════════════════════════════════════════════
// npm 失败：回执只写认出的原因与修法（市场把它显示在提示里），npm 的整段输出记进日志
// ════════════════════════════════════════════════════════════

const NETWORK_DOWN = [
  'npm error code ENOTFOUND',
  'npm error syscall getaddrinfo',
  'npm error errno ENOTFOUND',
  'npm error network request to https://registry.npmjs.org/@scope%2ffoo failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
  'npm error A complete log of this run can be found in: /home/u/.npm/_logs/2026-10-09T00_00_00_000Z-debug-0.log',
].join('\n');
const NETWORK_REASON =
  '连不上 npm 源（ENOTFOUND）：检查网络与代理后重试；默认源不通时在终端执行 npm config set registry <源地址> 换一个源';

describe('npm 失败的回执：写认出的原因与修法，整段输出进日志', () => {
  const rootPkg = `${ROOT}/package.json`;

  it.each([
    ['npm error code ENOSPC\nnpm error syscall write', '磁盘空间不够（ENOSPC）：腾出空间后重试'],
    [
      'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /abs/node_modules/foo',
      '没有写入权限（EACCES）：把项目目录与 npm 的缓存目录（npm config get cache 查看）改回运行 Aalis 的用户所有后重试，不要用 sudo',
    ],
    [
      'npm error code EBADPLATFORM\nnpm error notsup Unsupported platform for @lancedb/lancedb-darwin-x64@0.27.1: wanted {"os":"darwin","cpu":"x64"}',
      '依赖 @lancedb/lancedb-darwin-x64 不支持这台机器的系统或 CPU 架构（EBADPLATFORM），这个插件在这里装不了',
    ],
    [
      'npm error code EBADPLATFORM\nnpm error notsup Unsupported platform',
      '有一个依赖不支持这台机器的系统或 CPU 架构（EBADPLATFORM），这个插件在这里装不了',
    ],
    [
      'npm error code ERESOLVE\nnpm error peer react@"^19.0.0" from react-dom@19.0.0',
      'peer 依赖冲突（市场安装不沿用 .npmrc 里的 legacy-peer-deps）：code ERESOLVE；peer react@"^19.0.0" from react-dom@19.0.0',
    ],
    [
      'npm error path /abs/node_modules/puppeteer\nnpm error command failed\nnpm error Error: Failed to set up chrome v130.0.6723.58!',
      '下载浏览器失败：这个插件装的时候要下载 Chrome。把镜像地址（环境变量 PUPPETEER_CHROME_DOWNLOAD_BASE_URL）设进启动 Aalis 的环境，重新启动 Aalis 后再装（应用内的重启沿用原来的环境变量）',
    ],
    [
      'npm error path /abs/node_modules/zz-native-addon\nnpm error command failed\nnpm error gyp ERR! stack Error: not found: make',
      '原生模块 zz-native-addon 编译失败：本机缺 C/C++ 编译工具。macOS 执行 xcode-select --install；Linux 装 build-essential 与 python3；Windows 装 Visual Studio 的「使用 C++ 的桌面开发」，装好后重试',
    ],
    [
      'npm error command failed\nnpm error gyp ERR! stack Error: not found: make',
      '有一个原生模块编译失败：本机缺 C/C++ 编译工具。macOS 执行 xcode-select --install；Linux 装 build-essential 与 python3；Windows 装 Visual Studio 的「使用 C++ 的桌面开发」，装好后重试',
    ],
    [
      'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@scope%2fnope - Not found',
      '源上没有这个包或这个版本（E404）：核对包名与版本；用的是镜像源时它可能还没同步，稍后重试',
    ],
    [
      'npm error code ETARGET\nnpm error notarget No matching version found for foo@9.9.9.',
      '源上没有这个包或这个版本（ETARGET）：核对包名与版本；用的是镜像源时它可能还没同步，稍后重试',
    ],
    [NETWORK_DOWN, NETWORK_REASON],
    ['npm error code ETIMEDOUT\nnpm error errno ETIMEDOUT', NETWORK_REASON.replace('ENOTFOUND', 'ETIMEDOUT')],
    ['npm error code ECONNRESET', NETWORK_REASON.replace('ENOTFOUND', 'ECONNRESET')],
  ])('认出的类别 %#', (output, reason) => {
    expect(toSource(describeNpmFailure(output))).toBe(reason);
  });

  it('认不出的写 npm 最后一条报错，并指向日志与排障页', () => {
    const output = [
      'npm warn deprecated foo@1.0.0: old',
      'npm error code EUNKNOWNTHING',
      'npm error something odd happened',
      'npm error A complete log of this run can be found in: /home/u/.npm/_logs/x-debug-0.log',
    ].join('\n');
    expect(toSource(describeNpmFailure(output))).toBe(
      'npm 出错：something odd happened。完整输出在日志里，常见原因与修法见 https://aalis.acenyan.com/guide/troubleshooting',
    );
  });

  it('install：装前类型闸连不上源 → 回执是认出的原因，不带整段输出；整段输出进日志', async () => {
    const errors: string[] = [];
    const h = makeHarness({ failView: NETWORK_DOWN, errors, json: { [rootPkg]: {} } });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(toSource(r)).toEqual({ ok: false, message: NETWORK_REASON });
    expect(errors.join('\n')).toContain('npm error A complete log of this run');
    expect(h.execCalls.some(c => c.cmd === 'npm' && c.args[0] === 'install')).toBe(false);
  });

  it('install：npm install 失败 → 同上', async () => {
    const errors: string[] = [];
    const h = makeHarness({ failOn: 'npm', failStderr: NETWORK_DOWN, errors, json: { [rootPkg]: {} } });
    const r = await createPackageManager(h.deps).install('@scope/foo');
    expect(toSource(r)).toEqual({ ok: false, message: NETWORK_REASON });
    expect(errors.join('\n')).toContain('npm error A complete log of this run');
  });

  it('uninstall：npm uninstall 失败 → 回执写原因，插件不卸下', async () => {
    const errors: string[] = [];
    const h = makeHarness({
      failOn: 'npm',
      failStderr: 'npm error code EACCES\nnpm error syscall rename',
      errors,
      json: {
        [`${ROOT}/node_modules/@scope/foo/package.json`]: { name: '@scope/foo', keywords: ['aalis', 'aalis-plugin'] },
        [rootPkg]: { dependencies: { '@scope/foo': '^1.0.0' } },
      },
    });
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toMatch(/^没有写入权限（EACCES）：/);
    expect(errors.join('\n')).toContain('npm error syscall rename');
    expect(h.deps.unloadPlugin).not.toHaveBeenCalled();
  });

  const updateText = {
    [`${ROOT}/package.json`]: '{"dependencies":{"foo":"^1.0.0"}}',
    [`${ROOT}/node_modules/foo/package.json`]: '{"name":"foo","version":"1.0.0"}',
  };

  it('update：预检遇到不是 peer 冲突的失败（连不上源）→ 写原因，不说「预检未通过」', async () => {
    const h = makeHarness({ failOn: 'npm', failStderr: NETWORK_DOWN, text: updateText });
    const r = await createPackageManager(h.deps).update([{ name: 'foo', version: '1.0.1' }]);
    expect(toSource(r)).toEqual({ ok: false, message: `依赖预检没跑成：${NETWORK_REASON}` });
    expect(h.deps.restartApp).not.toHaveBeenCalled();
  });

  it('update：真装失败 → 工程未重启，回执写原因', async () => {
    const h = makeHarness({ text: updateText });
    let installs = 0;
    const execFile = h.deps.proc.execFile;
    h.deps.proc.execFile = vi.fn(async (cmd: string, args: readonly string[], o?: never) => {
      // 预检（--dry-run）放行，真装那一次连不上源
      if (cmd === 'npm' && args[0] === 'install' && !args.includes('--dry-run') && installs++ === 0) {
        const err = new Error('npm install 失败') as Error & { result?: ExecResult };
        err.result = { stdout: '', stderr: NETWORK_DOWN, code: 1 } as ExecResult;
        throw err;
      }
      return execFile(cmd, args, o);
    }) as never;
    const r = await createPackageManager(h.deps).update([{ name: 'foo', version: '1.0.1' }]);
    expect(toSource(r)).toEqual({ ok: false, message: `安装失败（工程未重启，可重试）：${NETWORK_REASON}` });
    expect(h.deps.restartApp).not.toHaveBeenCalled();
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
    expect(toSource(buildUpdateSpecs([]).error)).toContain('未指定');
  });

  it('拒绝会被 npm 当标志或目录 spec 的名字与版本', () => {
    // npm 把 `-` 开头当命令行标志，把 `.` / `..` 当本地目录 spec（能触发宿主 prepack 脚本）
    for (const bad of ['--force', '.', '..', './x', 'a b', 'a;rm -rf /', '', '@scope/']) {
      expect(toSource(buildUpdateSpecs([{ name: bad, version: '1.0.0' }]).error), bad).toContain('非法包名');
    }
    for (const bad of ['-1.0.0', '.', '../x', '1.0.0 && x', '']) {
      expect(toSource(buildUpdateSpecs([{ name: 'foo', version: bad }]).error), bad).toContain('非法版本号');
    }
  });

  it('拒绝同一包被指定多次（npm 会静默取最后一个）', () => {
    expect(
      toSource(
        buildUpdateSpecs([
          { name: 'foo', version: '1.0.0' },
          { name: 'foo', version: '2.0.0' },
        ]).error,
      ),
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
    expect(toSource(findUnmetPeers(out, ['react']))).toEqual(['react-dom@18.3.1 需要 react@^18.3.1']);
  });

  it('findUnmetPeers 只认与本次目标相关的：工程里原有的无关未满足 peer 不该阻断更新', () => {
    const out = 'npm warn peer other-lib@"^1.0.0" from someone@2.0.0';
    expect(toSource(findUnmetPeers(out, ['react']))).toEqual([]);
  });

  it('findUnmetPeers 去重（npm 会在不同上下文重复打印同一条）', () => {
    const out = [
      'npm warn peer react@"^18.3.1" from react-dom@18.3.1',
      'npm warn peer react@"^18.3.1" from react-dom@18.3.1',
    ].join('\n');
    expect(toSource(findUnmetPeers(out, ['react']))).toHaveLength(1);
  });

  it('findUnmetPeers 对无 peer 行的正常输出返回空', () => {
    expect(toSource(findUnmetPeers('added 1 package in 200ms', ['react']))).toEqual([]);
    expect(toSource(findUnmetPeers('', ['react']))).toEqual([]);
  });

  it('extractPeerConflicts 保留根项目的声明行与完整报告路径，看得出冲突由哪条根依赖引起', () => {
    // npm 10 的 ERESOLVE 输出（节选）
    const out = [
      'npm error code ERESOLVE',
      'npm error ERESOLVE unable to resolve dependency tree',
      'npm error',
      'npm error Found: @aalis/core@0.9.0',
      'npm error node_modules/@aalis/core',
      'npm error   @aalis/core@"^0.9.0" from the root project',
      'npm error',
      'npm error Could not resolve dependency:',
      'npm error peer @aalis/core@">=0.10.0 <1.0.0" from @aalis/plugin-x@0.3.0',
      'npm error node_modules/@aalis/plugin-x',
      'npm error   @aalis/plugin-x@"*" from the root project',
      'npm error For a full report see:',
      'npm error /home/user/.npm/_logs/2026-01-01T00_00_00_000Z-eresolve-report.txt',
    ].join('\n');
    const c = extractPeerConflicts(out);
    expect(c).toContain('@aalis/core@"^0.9.0" from the root project');
    expect(c).toContain('@aalis/plugin-x@"*" from the root project');
    expect(c).toContain('/home/user/.npm/_logs/2026-01-01T00_00_00_000Z-eresolve-report.txt');
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
    expect(toSource(r.message)).toContain('降级');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false); // 一次 npm 都不发
  });

  it('拒绝同版本重装：字符串不等判据会放行，版本序判据不会', async () => {
    const h = okHarness();
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/core', version: '0.9.0' }]);
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('降级');
  });

  it('读不到本地已装版本 → 拒绝（无从判断方向就不动）', async () => {
    const h = makeHarness({
      text: { [rootPkgPath]: '{"dependencies":{"@aalis/core":"^0.9.0"}}' }, // 无 node_modules 记录
    });
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/core', version: '0.9.2' }]);
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('未知');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('无 lockfile 时把 lockfile 标记为「更新前不存在」（回滚要删而非写空）', async () => {
    const restarts: Array<{
      reason: string;
      restore: Array<{ path: string; content: string; deleteIfEmpty?: boolean }>;
    }> = [];
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
    // 闸在服务层而非路由——服务经 provide 公开，插件能绕过前端直接调
    const h = makeHarness({
      text: { [rootPkgPath]: '{"dependencies":{"@aalis/plugin-agent":"^0.9.0"}}' },
    });
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/schema-message', version: '0.6.0' }]);
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('第二份副本');
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
    const h = okHarness({
      failOn: 'npm',
      failStderr:
        'npm error code ERESOLVE\nnpm error Could not resolve dependency:\nnpm error peer @aalis/core@"<0.9.0" from foo@1.0.0',
      restarts,
    });
    const r = await createPackageManager(h.deps).update([{ name: '@aalis/core', version: '0.9.2' }]);
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('预检未通过');
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
    expect(toSource(r.message)).toContain('workspace:');
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
    expect(toSource(second.message)).toContain('正在进行中');
    release();
    expect((await first).ok).toBe(true);
  });

  it('闸跨操作类型生效：安装进行中时卸载与更新同样被拒', async () => {
    const { h, release } = gatedHarness();
    const pm = createPackageManager(h.deps);
    const first = pm.install('foo');
    await new Promise(r => setTimeout(r, 0));
    expect(toSource((await pm.uninstall('bar')).message)).toContain('正在进行中');
    expect(toSource((await pm.update([{ name: 'foo', version: '1.0.1' }])).message)).toContain('正在进行中');
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
    expect(toSource(again.message)).not.toContain('正在进行中'); // 闸已释放，是真的又跑了一次
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
    expect(toSource(after.message)).toContain('正在进行中');
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

  it('插件：npm uninstall 摘根依赖 + unload；配置默认留着，回执写明', async () => {
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
    // 与在终端里 npm uninstall 一致：配置段与密钥留着，只清停用标记
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith(['@scope/foo'], false);
    expect(toSource(r.message)).toBe(
      '插件 @scope/foo 已卸载（已从根依赖与 node_modules 移除）。它的配置留在配置文件里，重装后照原配置启动；' +
        '写在数据目录 state/ 等处的数据不会删除，需要时请手动清理。',
    );
  });

  it('选了同时删除配置：交给 cleanupConfig 删配置段，回执写明只有它用的密钥一并删除', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    const r = await createPackageManager(h.deps).uninstall('@scope/foo', { removeConfig: true });
    expect(r.ok, toSource(r.message)).toBe(true);
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith(['@scope/foo'], true);
    expect(toSource(r.message)).toBe(
      '插件 @scope/foo 已卸载（已从根依赖与 node_modules 移除）。它的配置已从配置文件删除，只有它用的密钥一并删除；' +
        '写在数据目录 state/ 等处的数据不会删除，需要时请手动清理。',
    );
  });

  it('配置文件没写成：包已卸掉，回执仍 ok，写明原因与要手动处理的残留', async () => {
    for (const removeConfig of [false, true]) {
      const h = harness(['aalis', 'aalis-plugin']);
      h.deps.cleanupConfig = vi.fn(async () => {
        throw new Error('写盘失败');
      });
      const r = await createPackageManager(h.deps).uninstall('@scope/foo', { removeConfig });
      expect(toSource(r)).toEqual({
        ok: true,
        message:
          '插件 @scope/foo 已卸载（已从根依赖与 node_modules 移除），但配置文件没写成（写盘失败）：' +
          `需要时手动删掉配置文件里它的${removeConfig ? '配置段与' : ''}停用标记。`,
      });
    }
  });

  it('卸载按定义 name 枚举全部 instanceId（主 + name:suffix），逐个 unload，配置一次整理全部实例', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    h.deps.pluginStatus = () =>
      ['@scope/foo', '@scope/foo:one', '@scope/foo:two'].map(instanceId => ({
        ...snap('@scope/foo', 'active'),
        instanceId,
      }));
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok, toSource(r.message)).toBe(true);
    expect(h.deps.unloadPlugin).toHaveBeenCalledTimes(3);
    expect(h.deps.unloadPlugin).toHaveBeenCalledWith('@scope/foo');
    expect(h.deps.unloadPlugin).toHaveBeenCalledWith('@scope/foo:one');
    expect(h.deps.unloadPlugin).toHaveBeenCalledWith('@scope/foo:two');
    expect(h.deps.cleanupConfig).toHaveBeenCalledTimes(1);
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith(['@scope/foo', '@scope/foo:one', '@scope/foo:two'], false);
  });

  it('插件名被宿主直接登记的插件占着：只卸包，不卸那个插件的实例、不过服务依赖者闸、不整理配置，回执写明', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    h.deps.isPluginRegistered = name => name === '@scope/foo';
    h.deps.loaded = () => false;
    // 宿主登记的那个插件是 svc 唯一的提供者，有插件 required 它
    h.deps.pluginStatus = () => [
      snap('@scope/foo', 'active', { provides: ['svc'] }),
      snap('consumer', 'active', { requires: ['svc'] }),
    ];
    const pm = createPackageManager(h.deps);
    expect(pm.serviceDependents('@scope/foo'), '卸载前的预警与卸载闸同一份判定').toEqual([]);
    const r = await pm.uninstall('@scope/foo', { removeConfig: true });
    expect(toSource(r)).toEqual({
      ok: true,
      message:
        '@scope/foo 已卸载（已从根依赖与 node_modules 移除）。宿主直接登记了同名的插件，这个包没有加载过，' +
        '那个插件与配置文件都没有改动。',
    });
    expect(h.execCalls.filter(c => c.cmd === 'npm' && c.args[0] === 'uninstall')).toHaveLength(1);
    expect(h.deps.unloadPlugin).not.toHaveBeenCalled();
    expect(h.deps.cleanupConfig).not.toHaveBeenCalled();
  });

  it('包没有加载上、插件名也没被占着：照常整理以它的名字登记的配置段与停用标记', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    h.deps.isPluginRegistered = () => false;
    h.deps.loaded = () => false;
    const r = await createPackageManager(h.deps).uninstall('@scope/foo', { removeConfig: true });
    expect(r.ok, toSource(r.message)).toBe(true);
    expect(h.deps.cleanupConfig).toHaveBeenCalledWith(['@scope/foo'], true);
    expect(toSource(r.message)).toContain('它的配置已从配置文件删除');
  });

  it('前端界面包可卸——只要它不承载当前的撤销通道', async () => {
    const h = harness(['aalis', 'aalis-interface']);
    h.deps.recoveryChannelProviders = () => ['@scope/other-ui'];
    expect((await createPackageManager(h.deps).uninstall('@scope/foo')).ok).toBe(true);
  });

  // **自锁闸**：市场页要能用靠三样同时在——页面本身 / 托管它的服务端 / 装卸能力本身。
  // 少任何一样用户就只能开 shell。上一版只拦了「活跃前端」，漏掉后两个：它们带的是
  // aalis-plugin 关键词，类型闸照常放行，而卸掉它们同样销毁撤销通道。
  it.each([
    ['前端界面', ['aalis', 'aalis-interface']],
    ['WebUI 服务端', ['aalis', 'aalis-plugin']],
    ['包管理器自身', ['aalis', 'aalis-plugin']],
  ])('自锁闸拦住承载撤销通道的 %s', async (_label, kw) => {
    const h = harness(kw as string[]);
    h.deps.recoveryChannelProviders = () => ['@scope/foo'];
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('承载市场');
    expect(toSource(r.message), '要给出可操作的出路，而不是只说不行').toContain('切换');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('查不到承载者时不误挡（未启用 WebUI 的部署）', async () => {
    const h = harness(['aalis', 'aalis-interface']);
    h.deps.recoveryChannelProviders = () => [];
    expect((await createPackageManager(h.deps).uninstall('@scope/foo')).ok).toBe(true);
  });

  it('不在承载名单里的普通插件照常可卸', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    h.deps.recoveryChannelProviders = () => ['@aalis/plugin-webui-server'];
    expect((await createPackageManager(h.deps).uninstall('@scope/foo')).ok).toBe(true);
  });

  // ── 闸三：服务依赖者（与市场卸载前预警同一份判定）──
  it('卸掉某服务的唯一提供者会打断 required 它的插件 → 服务层拒绝，不跑 npm', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    h.deps.pluginStatus = () => [
      snap('@scope/foo', 'active', { provides: ['llm'] }),
      snap('@scope/agent', 'active', { provides: ['agent'], requires: ['llm'] }),
    ];
    const pm = createPackageManager(h.deps);
    expect(pm.serviceDependents('@scope/foo'), '预警查询与闸同一份判定').toEqual(['@scope/agent']);
    const r = await pm.uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('@scope/agent');
    expect(toSource(r.message), '已禁用的依赖方不算，停用它们即可放行').toContain(
      '请先停用它们，或启用 / 安装替代提供者',
    );
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
    expect(h.deps.unloadPlugin).not.toHaveBeenCalled();
  });

  it('唯一提供者自己激活失败（如待配置）→ 依赖方本来就缺这个服务，闸放行，换一个提供者不用先停用依赖方', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    h.deps.pluginStatus = () => [
      snap('@scope/foo', 'error', { provides: ['embedding'] }),
      snap('@scope/vector', 'pending', { provides: ['semantic-memory'], requires: ['embedding'] }),
    ];
    const pm = createPackageManager(h.deps);
    expect(pm.serviceDependents('@scope/foo'), '卸载前预警同一份判定').toEqual([]);
    expect((await pm.uninstall('@scope/foo')).ok).toBe(true);
    expect(h.execCalls.some(c => c.cmd === 'npm' && c.args[0] === 'uninstall')).toBe(true);
  });

  it('唯一提供者 pending 而只是在等（它要的服务的提供者在激活，宿主提供的服务算在）→ 马上就提供，照常拦下并列出依赖方', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    h.deps.pluginStatus = () => [
      snap('@scope/foo', 'pending', { provides: ['semantic-memory'], requires: ['embedding', 'host-config'] }),
      snap('@scope/embed', 'activating', { provides: ['embedding'] }),
      snap('@scope/recall', 'pending', { requires: ['semantic-memory'] }),
    ];
    h.deps.availableServices = () => ['host-config'];
    const pm = createPackageManager(h.deps);
    expect(pm.serviceDependents('@scope/foo'), '卸载前预警同一份判定').toEqual(['@scope/recall']);
    const r = await pm.uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain('@scope/recall');
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('服务还有别的提供者 → 服务依赖者闸放行', async () => {
    const h = harness(['aalis', 'aalis-plugin']);
    h.deps.pluginStatus = () => [
      snap('@scope/foo', 'active', { provides: ['llm'] }),
      snap('@scope/other-llm', 'active', { provides: ['llm'] }),
      snap('@scope/agent', 'active', { provides: ['agent'], requires: ['llm'] }),
    ];
    expect((await createPackageManager(h.deps).uninstall('@scope/foo')).ok).toBe(true);
  });

  // ── 闸一：类型 ──
  it.each([
    ['aalis-core', '内核', '(core)', 'cannot start'],
    ['aalis-runtime', '宿主', '(host)', 'cannot start'],
    ['aalis-api', '服务契约', '(service contract)', 'prunes it'],
    ['aalis-schema', '数据规范', '(data schema)', 'prunes it'],
    ['aalis-util', '工具库', '(utility library)', 'prunes it'],
  ])('拒卸 %s（%s 不是插件，不在市场职权内）；种类名与说明按读者语言', async (kw, label, en, hint) => {
    const h = harness(['aalis', kw]);
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain(label);
    // 措辞必须指出带外途径：owner 权限很高，拦的不是权限而是「这个操作会销毁你用来撤销它的通道」
    expect(toSource(r.message)).toContain('npm uninstall');
    expect(isTextRef(r.message) && resolveText(r.message, ['en'])).toContain(`@scope/foo ${en} is not a plugin`);
    expect(isTextRef(r.message) && resolveText(r.message, ['en'])).toContain(hint);
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
    expect(toSource(r.message), request).toContain(hint);
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
    expect(toSource(r.message)).toContain('剪枝');
  });

  it('读不到目标 package.json → 拒绝（无从确认它是什么就不动）', async () => {
    const h = makeHarness({ text: { [rootPkgPath]: '{"dependencies":{"@scope/foo":"^1.0.0"}}' } });
    const r = await createPackageManager(h.deps).uninstall('@scope/foo');
    expect(r.ok).toBe(false);
    // 市场卸不了时给出手动的路
    expect(toSource(r.message)).toBe(
      '读不到 @scope/foo 的 package.json，无法确认它是什么，市场不卸；确认要卸就在项目目录执行 npm uninstall @scope/foo 后重启',
    );
    expect(h.execCalls.some(c => c.cmd === 'npm')).toBe(false);
  });

  it('非法包名在服务层被拒，一次 npm 都不发', async () => {
    for (const evil of ['../../etc', '@x/../../etc', 'a/b', '..', '--force']) {
      const h = harness(['aalis-plugin']);
      const r = await createPackageManager(h.deps).uninstall(evil);
      expect(r.ok, evil).toBe(false);
      expect(toSource(r.message), evil).toContain('非法包名');
      expect(
        h.execCalls.some(c => c.cmd === 'npm'),
        evil,
      ).toBe(false);
      expect(h.deps.unloadPlugin).not.toHaveBeenCalled();
    }
  });
});

// ════════════════════════════════════════════════════════════
// 自锁闸的**生产接线**
//
// 上面那组自锁闸用例注入的是假的 recoveryChannelProviders，从不执行 createService 里真正
// 算这份名单的那几行——实测把 `id.split('/')[0]` 原样放回去，全量用例仍全绿。
//
// ⚠️ 第一版这条用例也是假绿：它断言的是内核的服务枚举与 JS 的 String.split，
// 一行 package-manager 的代码都没验。现在改为**真走 uninstallOne 的闸**——经 App 真装载、
// 真 apply()、真 uninstall()，把 bug 放回去即转红。
// ════════════════════════════════════════════════════════════
describe('自锁闸：生产接线算出的撤销通道名单', () => {
  async function bootWithChannels() {
    const { App, definePlugin, defineService, provide, services } = await import('../../packages/core/src/index.js');
    const packageManagerPlugin = (await import('../../packages/plugin-package-manager/src/index.js')).default;
    const app = new App({ name: 'T', logLevel: 'error' });

    /** 提供单个服务的桩插件：实例 id = 包名，于是 contextId 也是包名（与真实加载器一致）。 */
    const stubPlugin = (pkg: string, service: string) => {
      const descriptor = defineService<object>(service);
      return definePlugin({
        name: pkg,
        provides: [descriptor],
        uses: { provide },
        apply(caps) {
          caps.provide.use(descriptor, {});
        },
      });
    };
    // 另两个撤销通道各以自己的包名注册（scoped 包名带 /）
    for (const [svc, pkg] of [
      ['webui-client', '@aalis/plugin-webui-client'],
      ['webui-server', '@aalis/plugin-webui-server'],
    ] as const) {
      await app.plugins.register(stubPlugin(pkg, svc));
    }
    // package-manager 自己按真实形态装载，它 provide 出来的 contextId 就是包名。
    // **不能**另注册一个同名桩——那会按注册顺序占住解析结果，拿不到真服务。
    // 闸的顺序是「先读 package.json 判类型、再查撤销通道」，所以得让这几个包可解析——
    // 注入一个只回 package.json 的假 process 服务（它们在真实部署里本就装着）。
    const CHANNEL_PKGS: Record<string, string> = {
      '@aalis/plugin-webui-client': JSON.stringify({ keywords: ['aalis', 'aalis-interface'] }),
      '@aalis/plugin-webui-server': JSON.stringify({ keywords: ['aalis', 'aalis-plugin'] }),
      '@aalis/plugin-package-manager': JSON.stringify({ keywords: ['aalis', 'aalis-plugin'] }),
    };
    const host = app.bind({ provide, services });
    host.provide.use(defineService<object>('process'), {
      readExternalFile: async (abs: string) => {
        const hit = Object.keys(CHANNEL_PKGS).find(n => abs.includes(n));
        if (!hit) throw new Error('ENOENT');
        return new TextEncoder().encode(CHANNEL_PKGS[hit]);
      },
      execFile: async () => ({ stdout: '', stderr: '', code: 0 }),
      makeTempDir: async () => ({ path: '/tmp/fake', cleanup: async () => undefined }),
    });
    // 安装集只用来拼路径，读写都走上面的假 process 服务
    provideHostPaths(app, '/fake-app');
    await app.plugins.register(packageManagerPlugin, {});
    await app.plugins.idle();
    const svc = host.services.use.get(packageManager);
    if (!svc) throw new Error('package-manager 服务未就绪');
    return { app, svc };
  }

  it('卸载三个撤销通道之一 → 被闸拦下（scoped 包名不得被切分）', async () => {
    const { app, svc } = await bootWithChannels();
    try {
      for (const pkg of ['@aalis/plugin-webui-client', '@aalis/plugin-webui-server', '@aalis/plugin-package-manager']) {
        const r = await svc.uninstall(pkg);
        expect(r.ok, `${pkg} 必须被自锁闸拦下`).toBe(false);
        expect(toSource(r.message), `${pkg} 的拒绝理由应指向撤销通道`).toContain('正在承载市场/管理界面本身');
      }
    } finally {
      await app.stop();
    }
  });

  it('普通插件不被误拦（闸只拦当前生效的撤销通道）', async () => {
    const { app, svc } = await bootWithChannels();
    try {
      const r = await svc.uninstall('@aalis/plugin-nonexistent-probe');
      // 会因别的原因失败（读不到 package.json / 不是插件），但**不能**是自锁闸那条理由
      expect(toSource(r.message)).not.toContain('正在承载市场/管理界面本身');
    } finally {
      await app.stop();
    }
  });
});

// ════════════════════════════════════════════════════════════
// 就位判据 / 卸载枚举：生产接线（createService）
//
// 上面 createPackageManager 的用例自注入 deps，打不中 createService。
// 实测：isPluginRegistered 恒 true、unload 只对包名各打一次，全文件仍绿。
// 下列经 App 真装载 package-manager，钉就位判据与全部 instanceId。
// ════════════════════════════════════════════════════════════

const productionApps: App[] = [];
afterEach(async () => {
  for (const app of productionApps.splice(0)) await app.stop().catch(() => {});
});

/** 读真实文件的 process 替身里，test -f 按真实文件系统答（不在时以 1 退出），与 readExternalFile 读到的一致 */
function testOnDisk(cmd: string, args: readonly string[]): void {
  if (cmd === 'test' && !existsSync(args[1] ?? '')) {
    throw Object.assign(new Error('test: 不存在'), { result: { stdout: '', stderr: '', code: 1 } });
  }
}

/** 插件来源替身：注册表里的插件都当作经它从同名的包加载的，与发现驱动登记的插件一样 */
function provideLoadedSource(app: App) {
  app.bind({ provide }).provide.use(pluginSource, {
    rescan: async () => [],
    loaded: name => app.plugins.getPlugin(name) !== undefined,
  });
}

function mockProcess(files: Record<string, string>) {
  return {
    readExternalFile: async (abs: string) => {
      const text = files[abs];
      if (text === undefined) throw new Error(`ENOENT ${abs}`);
      return new TextEncoder().encode(text);
    },
    // test -f 按同一张文件表答（不在时以 1 退出），其余命令一律成功
    execFile: async (cmd: string, args: readonly string[]) => {
      if (cmd === 'test' && files[args[1] ?? ''] === undefined) {
        throw Object.assign(new Error('test: 不存在'), { result: { stdout: '', stderr: '', code: 1 } });
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    makeTempDir: async () => ({ path: '/tmp/fake-pm', cleanup: async () => undefined }),
  };
}

describe('生产接线：装卸按插件名（即包名），卸载清理全部实例', () => {
  /**
   * 被卸的包有三个实例（主与两个后缀）：主实例的配置段引用一个只有它用的密钥，后缀 one 引用一个别的插件也在用的，
   * one 带着停用标记。配置文档与密钥存储都落盘（替身记下每次写出的密钥）
   */
  async function bootReuser({ failConfigSave = false, disabled = true } = {}) {
    const TARGET = 'audit-pm-reuser';
    const PAGE = '/abs-pm-reuser';
    const tag = defineService<{ id: string }>('audit-pm-tag');
    const savedSecrets: Record<string, unknown>[] = [];
    const { app, store } = hostedApp(
      {
        plugins: {
          [TARGET]: { slot: 'main', apiKey: { $secret: 'own' } },
          [`${TARGET}:one`]: { slot: 'one', token: { $secret: 'shared' } },
          [`${TARGET}:two`]: { slot: 'two' },
          'audit-pm-other': { token: { $secret: 'shared' } },
        },
        disabledPlugins: disabled ? [`${TARGET}:one`] : [],
      },
      {
        provider: {
          save() {
            if (failConfigSave) throw new Error('写盘失败');
          },
        },
        secrets: {
          values: { own: 'o', shared: 's' },
          provider: { save: values => void savedSecrets.push(structuredClone(values)) },
        },
      },
    );
    productionApps.push(app);
    const host = app.bind({ provide, services });

    const def = definePlugin({
      name: TARGET,
      reusable: true,
      provides: [tag],
      uses: { provide, lifecycle },
      apply(caps) {
        caps.provide.use(tag, { id: caps.lifecycle.use.id });
      },
    });
    await app.plugin(def, { slot: 'main' });
    await app.plugins.register(def, { slot: 'one' }, `${TARGET}:one`);
    await app.plugins.register(def, { slot: 'two' }, `${TARGET}:two`);
    await app.plugins.idle();
    provideLoadedSource(app);

    host.provide.use(
      defineService<object>('process'),
      mockProcess({
        [`${PAGE}/package.json`]: JSON.stringify({ dependencies: { [TARGET]: '^1.0.0' } }),
        [`${PAGE}/node_modules/${TARGET}/package.json`]: JSON.stringify({
          name: TARGET,
          keywords: ['aalis', 'aalis-plugin'],
        }),
      }),
    );

    provideHostPaths(app, PAGE);
    await app.plugins.register(packageManagerPlugin, {});
    await app.plugins.idle();
    expect(app.plugins.getPlugin('@aalis/plugin-package-manager')?.state).toBe('active');
    const svc = host.services.use.get(packageManager);
    if (!svc) throw new Error('package-manager 未就绪');
    expect(app.plugins.getStatus().filter(p => p.name === TARGET)).toHaveLength(3);
    const instances = () =>
      app.plugins
        .getStatus()
        .filter(p => p.name === TARGET)
        .map(p => p.instanceId);
    return { TARGET, app, store, svc, tag, host, savedSecrets, instances };
  }

  it('卸载包名后，全部 instanceId 与停用标记都离开；配置段与密钥默认留着，重装后照原配置启动', async () => {
    const { TARGET, app, store, svc, tag, host, savedSecrets, instances } = await bootReuser();
    const r = await svc.uninstall(TARGET);
    expect(r.ok, toSource(r.message)).toBe(true);
    await app.plugins.idle();

    expect(instances(), '注册表不得留下 name:suffix 幽灵实例').toEqual([]);
    expect(store.getPluginConfig(TARGET)).toEqual({ slot: 'main', apiKey: { $secret: 'own' } });
    expect(store.getPluginConfig(`${TARGET}:one`)).toEqual({ slot: 'one', token: { $secret: 'shared' } });
    expect(store.getPluginConfig(`${TARGET}:two`)).toEqual({ slot: 'two' });
    expect(store.isPluginDisabled(`${TARGET}:one`), '后缀禁用标记应随包卸掉').toBe(false);
    expect(savedSecrets, '密钥一个不删').toEqual([]);
    expect(host.services.use.get(tag), '枢纽上该包提供的服务应全部消失').toBeUndefined();
  });

  it('选了同时删除配置：各实例的配置段删掉，落盘后只删没人再引用的密钥', async () => {
    const { TARGET, app, store, svc, savedSecrets, instances } = await bootReuser();
    const r = await svc.uninstall(TARGET, { removeConfig: true });
    expect(r.ok, toSource(r.message)).toBe(true);
    await app.plugins.idle();

    expect(instances()).toEqual([]);
    for (const id of [TARGET, `${TARGET}:one`, `${TARGET}:two`]) expect(store.getPluginConfig(id), id).toEqual({});
    expect(store.getPluginConfig('audit-pm-other'), '别的插件的配置段不动').toEqual({ token: { $secret: 'shared' } });
    expect(store.isPluginDisabled(`${TARGET}:one`)).toBe(false);
    expect(savedSecrets.at(-1), '别处还引用着的 shared 留下').toEqual({ shared: 's' });
  });

  it('配置文档没有要改的（没有停用标记、不删配置）就不写配置文件，配置文件的状况不影响卸载', async () => {
    const { TARGET, svc } = await bootReuser({ failConfigSave: true, disabled: false });
    const r = await svc.uninstall(TARGET);
    expect(toSource(r.message)).toContain('它的配置留在配置文件里');
  });

  it('配置文件没写成：包照样卸掉，回执写明没写成的原因，不吞掉', async () => {
    const { TARGET, svc, instances } = await bootReuser({ failConfigSave: true });
    const r = await svc.uninstall(TARGET);
    expect(instances()).toEqual([]);
    expect(toSource(r)).toEqual({
      ok: true,
      message: `插件 ${TARGET} 已卸载（已从根依赖与 node_modules 移除），但配置文件没写成（写盘失败）：需要时手动删掉配置文件里它的停用标记。`,
    });
  });

  it('服务依赖者闸读运行时注册表：卸掉唯一提供者被拒，提供者保持运行', async () => {
    const PROVIDER = 'audit-pm-provider';
    const CONSUMER = 'audit-pm-consumer';
    const PAGE = '/abs-pm-dependents';
    const dep = defineService<object>('audit-pm-dep');
    const { app } = hostedApp({ name: 'PM' });
    productionApps.push(app);
    const host = app.bind({ provide, services });

    await app.plugin(
      definePlugin({
        name: PROVIDER,
        provides: [dep],
        uses: { provide },
        apply(caps) {
          caps.provide.use(dep, {});
        },
      }),
      {},
    );
    await app.plugin(definePlugin({ name: CONSUMER, uses: { dep }, apply() {} }), {});
    await app.plugins.idle();
    provideLoadedSource(app);

    host.provide.use(
      defineService<object>('process'),
      mockProcess({
        [`${PAGE}/package.json`]: JSON.stringify({ dependencies: { [PROVIDER]: '^1.0.0' } }),
        [`${PAGE}/node_modules/${PROVIDER}/package.json`]: JSON.stringify({
          name: PROVIDER,
          keywords: ['aalis', 'aalis-plugin'],
        }),
      }),
    );
    provideHostPaths(app, PAGE);
    await app.plugins.register(packageManagerPlugin, {});
    await app.plugins.idle();
    const svc = host.services.use.get(packageManager);
    if (!svc) throw new Error('package-manager 未就绪');

    expect(svc.serviceDependents(PROVIDER)).toEqual([CONSUMER]);
    const r = await svc.uninstall(PROVIDER);
    expect(r.ok).toBe(false);
    expect(toSource(r.message)).toContain(CONSUMER);
    expect(app.plugins.getPlugin(PROVIDER)?.state).toBe('active');
  });

  it('唯一提供者只是在等上游慢激活：照样拦下（判在等读的是当前的服务名，宿主提供的服务算在）', async () => {
    const UPSTREAM = 'audit-pm-slow-upstream';
    const PROVIDER = 'audit-pm-waiting-provider';
    const CONSUMER = 'audit-pm-waiting-consumer';
    const PAGE = '/abs-pm-waiting';
    const upstream = defineService<object>('audit-pm-upstream');
    const dep = defineService<object>('audit-pm-waiting-dep');
    const gate = deferred<void>();
    const { app } = hostedApp({ name: 'PM' }, { slowThresholdMs: 20 });
    productionApps.push(app);
    try {
      const host = app.bind({ provide, services });
      await app.plugin(
        definePlugin({
          name: UPSTREAM,
          provides: [upstream],
          uses: { provide },
          async apply(caps) {
            caps.provide.use(upstream, {});
            await gate.promise;
          },
        }),
        {},
      );
      await app.plugin(
        definePlugin({
          name: PROVIDER,
          provides: [dep],
          uses: { provide, upstream, hostConfig },
          apply(caps) {
            caps.provide.use(dep, {});
          },
        }),
        {},
      );
      await app.plugin(definePlugin({ name: CONSUMER, uses: { dep }, apply() {} }), {});
      provideLoadedSource(app);
      host.provide.use(
        defineService<object>('process'),
        mockProcess({
          [`${PAGE}/package.json`]: JSON.stringify({ dependencies: { [PROVIDER]: '^1.0.0' } }),
          [`${PAGE}/node_modules/${PROVIDER}/package.json`]: JSON.stringify({
            name: PROVIDER,
            keywords: ['aalis', 'aalis-plugin'],
          }),
        }),
      );
      provideHostPaths(app, PAGE);
      await app.plugins.register(packageManagerPlugin, {});
      await app.plugins.idle();
      expect(app.plugins.getPlugin(PROVIDER)?.state).toBe('pending');
      const svc = host.services.use.get(packageManager);
      if (!svc) throw new Error('package-manager 未就绪');

      expect(svc.serviceDependents(PROVIDER)).toEqual([CONSUMER]);
      const r = await svc.uninstall(PROVIDER);
      expect(r.ok).toBe(false);
      expect(toSource(r.message)).toContain(CONSUMER);
    } finally {
      gate.resolve();
    }
  });

  // 插件名即包名：定义名与包名不同的包发现时拒载，插件名被宿主直接登记的插件占着时发现驱动跳过同名的包，两种都没加载
  it('包没加载上（定义名与包名不同）或插件名被宿主直接登记的插件占着：回执报未加载，不指向那个插件；已加载的包重装照常报已加载', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'aalis-pm-taken-'));
    try {
      const rootDeps: Record<string, string> = {};
      /** 装上一个声明插件名 pluginName 的包：写进根依赖与 node_modules */
      const place = (pkg: string, pluginName: string) => {
        rootDeps[pkg] = '1.0.0';
        writeFileSync(
          join(proj, 'package.json'),
          JSON.stringify({ name: 'host', private: true, dependencies: rootDeps }),
        );
        const dir = join(proj, 'node_modules', pkg);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name: pkg, version: '1.0.0', main: 'index.mjs', keywords: ['aalis-plugin'] }),
        );
        writeFileSync(join(dir, 'index.mjs'), `export default { name: "${pluginName}", apply() {} };\n`);
      };
      place('zz-pm-holder', 'zz-pm-holder');

      const { app, store } = hostedApp({ name: 'PM' });
      productionApps.push(app);
      const host = app.bind({ provide, services });
      const discovery = createPluginDiscovery(app, createNodeModulesPluginLoader(proj), store);
      host.provide.use(pluginSource, {
        rescan: () => discovery.rescan(),
        loaded: name => discovery.loaded(name),
      });
      host.provide.use(defineService<object>('process'), {
        readExternalFile: async (abs: string) => readFileSync(abs),
        execFile: async (cmd: string, args: readonly string[]) => {
          testOnDisk(cmd, args);
          return { stdout: args[0] === 'view' ? '["aalis-plugin"]' : '', stderr: '', code: 0 };
        },
        makeTempDir: async () => ({ path: '/tmp/fake-pm', cleanup: async () => undefined }),
      });
      await discovery.rescan();
      await app.plugin(definePlugin({ name: 'zz-pm-hosted', apply() {} }), {});
      provideHostPaths(app, proj);
      await app.plugins.register(packageManagerPlugin, {});
      await app.plugins.idle();
      const svc = host.services.use.get(packageManager);
      if (!svc) throw new Error('package-manager 未就绪');

      place('zz-pm-claimant', 'zz-pm-holder');
      expect(toSource(await svc.install('zz-pm-claimant'))).toEqual({
        ok: false,
        message:
          '已装到 node_modules，但它声明为插件却未被加载——请检查其 keywords、入口导出，以及定义的 name 是否与包名相同',
      });
      place('zz-pm-hosted', 'zz-pm-hosted');
      expect(toSource(await svc.install('zz-pm-hosted'))).toEqual({
        ok: false,
        message: '已安装 zz-pm-hosted，但宿主已直接登记了同名的插件，这个包未加载',
      });
      expect(toSource(await svc.install('zz-pm-holder'))).toEqual({
        ok: true,
        message: '已安装并加载：zz-pm-holder',
        plugin: 'zz-pm-holder',
      });
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('插件名由宿主直接登记的插件占着：卸载同名的包只卸包，那个插件照常运行、配置不动，回执写明', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'aalis-pm-hosted-'));
    try {
      const pkg = 'zz-pm-hosted';
      writeFileSync(
        join(proj, 'package.json'),
        JSON.stringify({ name: 'host', private: true, dependencies: { [pkg]: '1.0.0' } }),
      );
      const dir = join(proj, 'node_modules', pkg);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: pkg, version: '1.0.0', main: 'index.mjs', keywords: ['aalis-plugin'] }),
      );
      writeFileSync(join(dir, 'index.mjs'), `export default { name: "${pkg}", apply() {} };\n`);

      const { app, store } = hostedApp({ name: 'PM', plugins: { [pkg]: { token: 'keep-me' } } });
      productionApps.push(app);
      const host = app.bind({ provide, services });
      await app.plugin(definePlugin({ name: pkg, apply() {} }), { token: 'keep-me' });
      const discovery = createPluginDiscovery(app, createNodeModulesPluginLoader(proj), store);
      host.provide.use(pluginSource, {
        rescan: () => discovery.rescan(),
        loaded: name => discovery.loaded(name),
      });
      const npmCalls: string[][] = [];
      host.provide.use(defineService<object>('process'), {
        readExternalFile: async (abs: string) => readFileSync(abs),
        execFile: async (cmd: string, args: readonly string[]) => {
          npmCalls.push([...args]);
          testOnDisk(cmd, args);
          return { stdout: '', stderr: '', code: 0 };
        },
        makeTempDir: async () => ({ path: '/tmp/fake-pm', cleanup: async () => undefined }),
      });
      await discovery.rescan();
      provideHostPaths(app, proj);
      await app.plugins.register(packageManagerPlugin, {});
      await app.plugins.idle();
      const svc = host.services.use.get(packageManager);
      if (!svc) throw new Error('package-manager 未就绪');

      expect(toSource(await svc.uninstall(pkg, { removeConfig: true }))).toEqual({
        ok: true,
        message:
          `${pkg} 已卸载（已从根依赖与 node_modules 移除）。宿主直接登记了同名的插件，这个包没有加载过，` +
          '那个插件与配置文件都没有改动。',
      });
      expect(npmCalls.filter(args => args[0] === 'uninstall')).toHaveLength(1);
      await app.plugins.idle();
      expect(app.plugins.getPlugin(pkg)?.state).toBe('active');
      expect(store.getPluginConfig(pkg)).toEqual({ token: 'keep-me' });
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('安装时另有重算在飞：回执等它落定再读主实例状态，报出之后的激活失败', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'aalis-pm-inflight-'));
    try {
      const pkg = 'zz-pm-inflight';
      writeFileSync(
        join(proj, 'package.json'),
        JSON.stringify({ name: 'host', private: true, dependencies: { [pkg]: '1.0.0' } }),
      );
      const dir = join(proj, 'node_modules', pkg);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: pkg, version: '1.0.0', main: 'index.mjs', keywords: ['aalis-plugin'] }),
      );
      writeFileSync(
        join(dir, 'index.mjs'),
        `export default { name: "${pkg}", apply() { throw new Error("缺少配置项 apiKey"); } };\n`,
      );

      const { app, store } = hostedApp({ name: 'PM' });
      productionApps.push(app);
      const host = app.bind({ provide, services });
      const discovery = createPluginDiscovery(app, createNodeModulesPluginLoader(proj), store);
      const rescanned = deferred();
      host.provide.use(pluginSource, {
        rescan: async () => {
          const loaded = await discovery.rescan();
          rescanned.resolve();
          return loaded;
        },
        loaded: name => discovery.loaded(name),
      });
      host.provide.use(defineService<object>('process'), {
        readExternalFile: async (abs: string) => readFileSync(abs),
        execFile: async (cmd: string, args: readonly string[]) => {
          testOnDisk(cmd, args);
          return { stdout: args[0] === 'view' ? '["aalis-plugin"]' : '', stderr: '', code: 0 };
        },
        makeTempDir: async () => ({ path: '/tmp/fake-pm', cleanup: async () => undefined }),
      });
      provideHostPaths(app, proj);
      await app.plugins.register(packageManagerPlugin, {});
      await app.plugins.idle();
      const svc = host.services.use.get(packageManager);
      if (!svc) throw new Error('package-manager 未就绪');

      // 让一次重算停在别的插件的 apply 里：rescan 的登记只排队、立即返回
      const entered = deferred();
      const gate = deferred();
      const holding = app.plugin(
        definePlugin({
          name: 'zz-pm-holder',
          async apply() {
            entered.resolve();
            await gate.promise;
          },
        }),
        {},
      );
      await entered.promise;

      let replied = false;
      const installing = svc.install(pkg);
      const mark = () => {
        replied = true;
      };
      installing.then(mark, mark);
      try {
        await rescanned.promise;
        await new Promise(r => setTimeout(r, 20));
        expect(replied, '重算还在飞：回执要等它落定').toBe(false);
      } finally {
        gate.resolve();
        await holding;
      }
      expect(toSource(await installing)).toEqual({
        ok: true,
        message: `已安装 ${pkg}，但激活失败，已转为 error 态（缺少配置项 apiKey）`,
        plugin: pkg,
      });
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('宿主没有重启策略：更新装完，回执写明 app.restart() 给的原因，包管理照常可用', async () => {
    const ROOT_DIR = '/abs-pm-norestart';
    const { app } = hostedApp({ name: 'PM' });
    productionApps.push(app);
    const host = app.bind({ provide, services });
    host.provide.use(
      defineService<object>('process'),
      mockProcess({
        [`${ROOT_DIR}/package.json`]: JSON.stringify({ dependencies: { foo: '^1.0.0' } }),
        [`${ROOT_DIR}/node_modules/foo/package.json`]: JSON.stringify({ name: 'foo', version: '1.0.0' }),
      }),
    );
    provideHostPaths(app, ROOT_DIR);
    await app.plugins.register(packageManagerPlugin, {});
    await app.plugins.idle();
    const svc = host.services.use.get(packageManager);
    if (!svc) throw new Error('package-manager 未就绪');
    const r = await svc.update([{ name: 'foo', version: '1.0.1' }]);
    expect(toSource(r)).toEqual({
      ok: true,
      restarting: false,
      message: '已更新 foo@1.0.1，但应用无法自己重启（App.restart() 不可用：未注入 restartStrategy。），手动重启后生效',
    });
    expect(toSource((await svc.update([{ name: 'foo', version: '1.0.1' }])).message)).not.toContain('正在进行中');
  });
});

describe('registry()：安装实际使用的 npm 源', () => {
  /** 按顺序吐出 `npm config get registry` 的输出（Error 即该次执行失败），记下每次调用 */
  function withNpmConfig(outputs: Array<string | Error>) {
    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const proc = {
      makeTempDir: vi.fn(),
      execFile: vi.fn(async (cmd: string, args: readonly string[], o?: { cwd?: string }): Promise<ExecResult> => {
        calls.push({ cmd, args: [...args], cwd: o?.cwd });
        const next = outputs.shift();
        if (next === undefined || next instanceof Error) throw next ?? new Error('多余的调用');
        return { stdout: next, stderr: '', code: 0 } as ExecResult;
      }),
    } as unknown as ProcessService;
    const pm = createPackageManager({ ...makeHarness().deps, proc });
    return { pm, calls };
  }

  it('在项目根执行 npm config get registry，去掉尾部斜杠；成功后缓存，不再重查', async () => {
    const { pm, calls } = withNpmConfig(['https://registry.npmmirror.com/\n']);
    expect(await pm.registry()).toBe('https://registry.npmmirror.com');
    expect(await pm.registry()).toBe('https://registry.npmmirror.com');
    expect(calls).toEqual([{ cmd: 'npm', args: ['config', 'get', 'registry'], cwd: ROOT }]);
  });

  it('查询失败时拒绝且不缓存：下一次调用重查', async () => {
    const { pm, calls } = withNpmConfig([new Error('npm: command not found'), 'https://registry.npmjs.org/']);
    await expect(pm.registry()).rejects.toThrow('npm: command not found');
    expect(await pm.registry()).toBe('https://registry.npmjs.org');
    expect(calls).toHaveLength(2);
  });

  it('接本激活的中止信号：中止即拒绝，缓存随之清掉', async () => {
    const activation = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const proc = {
      makeTempDir: vi.fn(),
      execFile: vi.fn(
        (_cmd: string, _args: readonly string[], o?: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            seen.push(o?.signal);
            if (o?.signal?.aborted) reject(o.signal.reason);
            o?.signal?.addEventListener('abort', () => reject(o.signal?.reason), { once: true });
          }),
      ),
    } as unknown as ProcessService;
    const pm = createPackageManager({ ...makeHarness().deps, proc, signal: activation.signal });
    const first = pm.registry().then(
      () => 'resolved',
      () => 'rejected',
    );
    activation.abort();
    expect(await Promise.race([first, new Promise(r => setTimeout(() => r('2 秒后仍在跑'), 2000))])).toBe('rejected');
    expect(seen).toEqual([activation.signal]);
    void pm.registry().catch(() => {});
    expect(seen, '没有缓存被中止的那次：再查一遍').toHaveLength(2);
  });

  it('输出不是 http(s) 地址：拒绝并说明，同样不缓存', async () => {
    const { pm, calls } = withNpmConfig(['undefined\n', 'https://registry.npmjs.org']);
    await expect(pm.registry()).rejects.toThrow('npm config get registry 的输出不是 http(s) 地址: "undefined"');
    expect(await pm.registry()).toBe('https://registry.npmjs.org');
    expect(calls).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════
// 停用、重启与停机时打断在途的 npm
//
// npm 替身：会改安装树的那几条（install、uninstall，不带 --dry-run）先把 package.json 与锁文件改掉，再挂起到交给它的中止
// 信号断开；断开后过 exitMs 毫秒才以非零退出，退出前可以再写一遍 package.json（lateWrite）。点名的一条命令可以同样挂起
// （hangOn，整行比对），会改安装树的那几条也可以照常执行完毕（npmSucceeds）。tee、mv、rm 作用于同一张文件表，每一步记进 log 核对次序；每条命令按整行记进 commands
// ════════════════════════════════════════════════════════════

const PKG_BEFORE = '{"dependencies":{"foo":"^1.0.0"}}';
const LOCK_BEFORE = '{"lockfileVersion":3}';
const STOPPED =
  '已中止，没有生效：package.json 与锁文件已还原到操作前；node_modules 可能与它们不一致，在安装目录执行 npm install 即可对齐' +
  '（之后任何一次市场的装、卸、更新也会顺带对齐）';

function interruptibleNpm(
  root: string,
  opts: {
    lock?: boolean;
    exitMs?: number;
    lateWrite?: boolean;
    hangOn?: string;
    npmSucceeds?: boolean;
    failMv?: string;
  } = {},
) {
  const pkgPath = `${root}/package.json`;
  const lockPath = `${root}/package-lock.json`;
  const files = new Map<string, string>([
    [pkgPath, PKG_BEFORE],
    [`${root}/node_modules/foo/package.json`, '{"name":"foo","version":"1.0.0","keywords":["aalis","aalis-plugin"]}'],
  ]);
  if (opts.lock !== false) files.set(lockPath, LOCK_BEFORE);
  const log: string[] = [];
  const commands: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0, signal: null });
  /** 挂起到 signal 断开，断开后过 exitMs 毫秒以非零退出（先跑 beforeExit）；没给 signal 就一直挂起 */
  const untilAborted = (signal: AbortSignal | undefined, beforeExit?: () => void) =>
    new Promise<never>((_, reject) => {
      signal?.addEventListener(
        'abort',
        () =>
          setTimeout(() => {
            beforeExit?.();
            reject(Object.assign(new Error('npm 被中止'), { result: { ...ok(), code: null, signal: 'SIGTERM' } }));
          }, opts.exitMs ?? 20),
        { once: true },
      );
    });
  const proc = {
    readExternalFile: async (abs: string) => {
      const text = files.get(abs);
      if (text === undefined) throw new Error(`ENOENT ${abs}`);
      return new TextEncoder().encode(text);
    },
    makeTempDir: async () => ({ path: '/tmp/fake-pm', uri: 'tmp:/fake-pm', cleanup: async () => {} }),
    execFile: async (
      cmd: string,
      args: readonly string[],
      o: { signal?: AbortSignal; input?: string | Uint8Array } = {},
    ): Promise<ExecResult> => {
      const line = [cmd, ...args].join(' ');
      commands.push(line);
      if (line === opts.hangOn) {
        signals.push(o.signal);
        return untilAborted(o.signal);
      }
      if (cmd === 'npm' && args[0] === 'view') return ok('["aalis","aalis-plugin"]');
      if (cmd === 'npm' && (args[0] === 'install' || args[0] === 'uninstall') && !args.includes('--dry-run')) {
        o.signal?.throwIfAborted();
        signals.push(o.signal);
        log.push(`npm ${args[0]} ${args[1]}`);
        files.set(pkgPath, 'npm 改过的 package.json');
        files.set(lockPath, 'npm 改过的锁文件');
        if (opts.npmSucceeds) return ok();
        return untilAborted(o.signal, () => {
          if (opts.lateWrite) files.set(pkgPath, 'npm 退出之前又写了一遍的 package.json');
          log.push('npm 退出');
        });
      }
      if (cmd === 'tee') {
        files.set(args[0] ?? '', String(o.input));
        return ok();
      }
      if (cmd === 'mv') {
        const [, from = '', to = ''] = args;
        if (to === opts.failMv) throw new Error(`mv: ${to}: Permission denied`);
        files.set(to, files.get(from) ?? '');
        files.delete(from);
        log.push(`还原 ${to}`);
        return ok();
      }
      if (cmd === 'rm') {
        const target = args[args.length - 1] ?? '';
        if (files.delete(target)) log.push(`删掉 ${target}`);
        return ok();
      }
      if (cmd === 'test' && !files.has(args[1] ?? '')) {
        throw Object.assign(new Error('test: 不存在'), { result: { ...ok(), code: 1 } });
      }
      return ok(); // cp、在的文件的 test、npm 的预检与 config
    },
  };
  return { proc: proc as unknown as ProcessService, files, log, commands, signals, pkgPath, lockPath };
}

describe('停用、重启与停机时打断在途的 npm（中止信号接本插件这次激活）', () => {
  /** 本插件这次激活的中止信号由用例手动断开；readText 读同一张文件表 */
  function pmWith(fake: ReturnType<typeof interruptibleNpm>, overrides: Partial<PackageManagerDeps> = {}) {
    const activation = new AbortController();
    const h = makeHarness();
    const deps: PackageManagerDeps = {
      ...h.deps,
      proc: fake.proc,
      readText: async abs => fake.files.get(abs),
      signal: activation.signal,
      ...overrides,
    } as PackageManagerDeps;
    return { pm: createPackageManager(deps), deps, signal: activation.signal, abort: () => activation.abort() };
  }
  /** 等替身里启动了 n 条会改安装树的 npm */
  const npmRuns = async (fake: ReturnType<typeof interruptibleNpm>, n: number) =>
    vi.waitFor(() => expect(fake.log.filter(line => line.startsWith('npm ') && line !== 'npm 退出')).toHaveLength(n));
  /** 2 秒还没落定就算阻塞：改前 npm 拿不到中止信号，会一直跑下去 */
  const settleWithin = <T>(work: Promise<T>) =>
    Promise.race([work, new Promise<string>(r => setTimeout(() => r('2 秒后仍在跑'), 2000))]);

  it('取快照时锁文件在却读不出：不启动 npm，回执写明没有改动，不把它当成原本没有、被打断时删掉', async () => {
    const fake = interruptibleNpm(ROOT);
    const { pm } = pmWith(fake, { readText: async abs => (abs === fake.lockPath ? undefined : fake.files.get(abs)) });
    const result = await settleWithin(pm.install('bar'));
    expect(fake.log).toEqual([]);
    expect(toSource(result)).toEqual({
      ok: false,
      message: `没有改动：${fake.lockPath} 在却读不出，取不到操作前的那份就不启动 npm`,
    });
    expect(fake.files.get(fake.lockPath)).toBe(LOCK_BEFORE);
  });

  it('取快照时查锁文件在不在途中中止：回执已中止、没有改动，不启动 npm，不记安装失败', async () => {
    const fake = interruptibleNpm(ROOT, { lock: false, hangOn: `test -f ${ROOT}/package-lock.json` });
    const errors: string[] = [];
    const { pm, abort } = pmWith(fake, {
      log: { info: () => {}, warn: () => {}, error: msg => void errors.push(msg) },
    });
    const installing = pm.install('bar');
    await vi.waitFor(() => expect(fake.signals).toHaveLength(1));
    abort();
    expect(toSource(await settleWithin(installing))).toEqual({ ok: false, message: '已中止，没有改动' });
    expect(fake.log).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('更新：取快照时锁文件在却读不出，回执写明没有改动，不启动 npm', async () => {
    const fake = interruptibleNpm(ROOT);
    const { pm } = pmWith(fake, { readText: async abs => (abs === fake.lockPath ? undefined : fake.files.get(abs)) });
    const result = await settleWithin(pm.update([{ name: 'foo', version: '1.0.1' }]).catch(err => `拒绝: ${err}`));
    expect(toSource(result)).toEqual({
      ok: false,
      message: `没有改动：${fake.lockPath} 在却读不出，取不到操作前的那份就不启动 npm`,
    });
    expect(fake.log).toEqual([]);
  });

  it('安装：npm 改过两份文件后被打断，等它退出再还原；回执 ok 为 false，写明没有生效、怎样对齐 node_modules', async () => {
    const fake = interruptibleNpm(ROOT);
    const logged = { warn: [] as string[], error: [] as string[] };
    const { pm, abort } = pmWith(fake, {
      log: { info: () => {}, warn: msg => void logged.warn.push(msg), error: msg => void logged.error.push(msg) },
    });
    const installing = pm.install('bar');
    await npmRuns(fake, 1);
    abort();
    expect(toSource(await settleWithin(installing))).toEqual({ ok: false, message: STOPPED });
    expect(fake.signals.every(s => s?.aborted)).toBe(true);
    expect(fake.files.get(fake.pkgPath)).toBe(PKG_BEFORE);
    expect(fake.files.get(fake.lockPath)).toBe(LOCK_BEFORE);
    expect(fake.log).toEqual(['npm install bar', 'npm 退出', `还原 ${fake.pkgPath}`, `还原 ${fake.lockPath}`]);
    // 中止不是 npm 失败：不记失败，记一条 warn 写明结果
    expect(logged.error).toEqual([]);
    expect(logged.warn).toEqual([
      `npm install bar --no-audit --no-fund 随本插件停用被中止：${STOPPED}（安装目录 ${ROOT}）`,
    ]);
  });

  it('npm 退出之前又写了一遍 package.json：还原在它退出之后，留下的是操作前那份', async () => {
    const fake = interruptibleNpm(ROOT, { lateWrite: true, exitMs: 100 });
    const { pm, abort } = pmWith(fake);
    const installing = pm.install('bar');
    await npmRuns(fake, 1);
    abort();
    await settleWithin(installing);
    expect(fake.files.get(fake.pkgPath)).toBe(PKG_BEFORE);
  });

  it('原本没有锁文件：npm 新建的那份删掉', async () => {
    const fake = interruptibleNpm(ROOT, { lock: false });
    const { pm, abort } = pmWith(fake);
    const installing = pm.install('bar');
    await npmRuns(fake, 1);
    abort();
    expect(toSource(await settleWithin(installing))).toEqual({ ok: false, message: STOPPED });
    expect(fake.files.has(fake.lockPath)).toBe(false);
    expect(fake.files.get(fake.pkgPath)).toBe(PKG_BEFORE);
  });

  it('卸载：npm uninstall 被打断，两份文件还原，实例不卸', async () => {
    const fake = interruptibleNpm(ROOT);
    const { pm, deps, abort } = pmWith(fake);
    const removing = pm.uninstall('foo');
    await npmRuns(fake, 1);
    abort();
    expect(toSource(await settleWithin(removing))).toEqual({ ok: false, message: STOPPED });
    expect(fake.files.get(fake.pkgPath)).toBe(PKG_BEFORE);
    expect(fake.files.get(fake.lockPath)).toBe(LOCK_BEFORE);
    expect(deps.unloadPlugin).not.toHaveBeenCalled();
  });

  it('更新：真装被打断，两份文件还原，不重启', async () => {
    const fake = interruptibleNpm(ROOT);
    const { pm, deps, abort } = pmWith(fake);
    const updating = pm.update([{ name: 'foo', version: '1.0.1' }]);
    await npmRuns(fake, 1);
    abort();
    expect(toSource(await settleWithin(updating))).toEqual({ ok: false, message: STOPPED });
    expect(fake.files.get(fake.pkgPath)).toBe(PKG_BEFORE);
    expect(fake.files.get(fake.lockPath)).toBe(LOCK_BEFORE);
    expect(deps.restartApp).not.toHaveBeenCalled();
  });

  it('还没动文件就中止（npm view 途中）：回执写已中止、没有改动，不碰两份文件', async () => {
    const fake = interruptibleNpm(ROOT, { hangOn: 'npm view bar keywords --json' });
    const { pm, abort } = pmWith(fake);
    const installing = pm.install('bar');
    await vi.waitFor(() => expect(fake.signals).toHaveLength(1));
    abort();
    expect(toSource(await settleWithin(installing))).toEqual({ ok: false, message: '已中止，没有改动' });
    expect(fake.log).toEqual([]);
    expect(fake.files.get(fake.pkgPath)).toBe(PKG_BEFORE);
  });

  it('更新的预检途中中止：回执写已中止、没有改动，不当成预检失败', async () => {
    const fake = interruptibleNpm(ROOT, { hangOn: 'npm install foo@1.0.1 --dry-run --no-audit --no-fund' });
    const { pm, abort } = pmWith(fake);
    const updating = pm.update([{ name: 'foo', version: '1.0.1' }]);
    await vi.waitFor(() => expect(fake.signals).toHaveLength(1));
    abort();
    expect(toSource(await settleWithin(updating))).toEqual({ ok: false, message: '已中止，没有改动' });
    expect(fake.log).toEqual([]);
  });

  // 中止之后 test 读不出「有没有这个文件」：报成没有的话预检会接着往下跑
  it.each([
    ['复制 package.json 的 cp', `cp ${ROOT}/package.json /tmp/fake-pm/package.json`],
    ['查有没有锁文件的 test', `test -f ${ROOT}/package-lock.json`],
    ['复制锁文件的 cp', `cp ${ROOT}/package-lock.json /tmp/fake-pm/package-lock.json`],
  ])('更新的预检里%s 接中止信号：中止即回已中止、没有改动，之后不再跑别的命令', async (_, line) => {
    const fake = interruptibleNpm(ROOT, { hangOn: line });
    const { pm, abort } = pmWith(fake);
    const updating = pm.update([{ name: 'foo', version: '1.0.1' }]);
    await vi.waitFor(() => expect(fake.signals).toHaveLength(1));
    abort();
    expect(toSource(await settleWithin(updating))).toEqual({ ok: false, message: '已中止，没有改动' });
    expect(fake.commands.at(-1)).toBe(line);
  });

  it('本激活已开始关闭：新来的操作回执包管理正在停用，不跑 npm', async () => {
    const fake = interruptibleNpm(ROOT);
    const { pm, abort } = pmWith(fake);
    abort();
    for (const op of [
      () => pm.install('bar'),
      () => pm.uninstall('foo'),
      () => pm.update([{ name: 'foo', version: '1.0.1' }]),
    ]) {
      expect(toSource(await settleWithin(op()))).toEqual({ ok: false, message: '包管理正在停用' });
    }
    expect(fake.log).toEqual([]);
    expect(fake.signals).toEqual([]);
  });

  it('还原本身失败：回执照实写哪份没还原、原因，日志同样写明', async () => {
    const fake = interruptibleNpm(ROOT, { failMv: `${ROOT}/package-lock.json` });
    const warned: string[] = [];
    const h = makeHarness();
    const { pm, abort } = pmWith(fake, { log: { ...h.deps.log, warn: msg => void warned.push(msg) } });
    const installing = pm.install('bar');
    await npmRuns(fake, 1);
    abort();
    expect(toSource(await settleWithin(installing))).toEqual({
      ok: false,
      message:
        `已中止，但这些文件没能还原到操作前，需要手动恢复：${ROOT}/package-lock.json（mv: ${ROOT}/package-lock.json: ` +
        'Permission denied）；node_modules 可能与 package.json、锁文件不一致，恢复之后在安装目录执行 npm install 即可对齐',
    });
    expect(fake.files.get(fake.pkgPath)).toBe(PKG_BEFORE);
    expect(fake.files.has(`${ROOT}/package-lock.json.aalis-restore`), '没换上的临时文件删掉').toBe(false);
    expect(warned.join('\n')).toContain(`${ROOT}/package-lock.json`);
  });

  it('装后回执等插件静置时挂在本激活信号上的监听，等完即摘掉', async () => {
    const fake = interruptibleNpm(ROOT, { npmSucceeds: true });
    const { pm, signal } = pmWith(fake, { loaded: () => true, isPluginRegistered: () => true });
    expect(toSource(await settleWithin(pm.install('bar')))).toMatchObject({ ok: true, plugin: 'bar' });
    expect(getEventListeners(signal, 'abort')).toEqual([]);
  });

  // 已断开的信号不会再发 abort：走到等插件静置时信号已断，就不能再等 idle
  it('npm 已经执行完毕之后才中止：装上就是装上了，不还原，不等 idle，照常回执', async () => {
    const fake = interruptibleNpm(ROOT, { npmSucceeds: true });
    let abort = () => {};
    const { pm, abort: doAbort } = pmWith(fake, {
      rescanPlugins: async () => {
        abort();
        return [];
      },
      idle: () => new Promise(() => {}),
      loaded: () => true,
      isPluginRegistered: () => true,
    });
    abort = doAbort;
    const r = await settleWithin(pm.install('bar'));
    expect(toSource(r)).toEqual({ ok: true, message: '已安装并加载：bar', plugin: 'bar' });
    expect(fake.files.get(fake.pkgPath)).toBe('npm 改过的 package.json');
  });

  describe('生产接线（App 真装载本插件）', () => {
    const PM = '@aalis/plugin-package-manager';
    const ROOT_DIR = '/abs-pm-abort';

    async function bootPm(
      fake: ReturnType<typeof interruptibleNpm>,
      appOptions: Parameters<typeof hostedApp>[1] = {},
      setup?: (app: App) => void,
    ) {
      const { app } = hostedApp({ name: 'PM' }, appOptions);
      productionApps.push(app);
      const host = app.bind({ provide, services });
      host.provide.use(defineService<object>('process'), fake.proc);
      provideHostPaths(app, ROOT_DIR);
      setup?.(app);
      await app.plugins.register(packageManagerPlugin, {});
      await app.plugins.idle();
      const svc = () => {
        const s = host.services.use.get(packageManager);
        if (!s) throw new Error('package-manager 未就绪');
        return s;
      };
      return { app, svc };
    }

    /** 宿主日志器：warn 收进 warnings，其余丢掉 */
    function warnLog() {
      const warnings: string[] = [];
      const logger: Logger = {
        debug() {},
        info() {},
        warn: msg => void warnings.push(msg),
        error() {},
        child: () => logger,
      };
      return { warnings, logger };
    }

    // 清理宽限只给 50ms、npm 200ms 才退：收尾超时之后靠 core 记下的未停下实例挡住新实例
    it('安装在途时 bounce 本插件：新实例的第一次 npm 晚于旧实例把两份文件还原完', async () => {
      const fake = interruptibleNpm(ROOT_DIR, { exitMs: 200 });
      const { app, svc } = await bootPm(fake, { disposeTimeoutMs: 50 });
      const first = svc().install('bar');
      await npmRuns(fake, 1);
      await app.plugins.bounce(PM);
      await vi.waitFor(() => expect(app.plugins.getPlugin(PM)?.state).toBe('active'), { timeout: 3000 });
      void svc().install('baz');
      await npmRuns(fake, 2);
      expect(fake.log).toEqual([
        'npm install bar',
        'npm 退出',
        `还原 ${fake.pkgPath}`,
        `还原 ${fake.lockPath}`,
        'npm install baz',
      ]);
      expect(toSource(await first)).toEqual({ ok: false, message: STOPPED });
    });

    // 装后回执先进了 idle()，之后才赶上 bounce：idle 要等这次关闭的计划走完，计划又在等本操作落定（onDrain）
    it('npm 已执行完毕、装后回执正等插件静置时 bounce 本插件：收尾在清理宽限内落定，不记为未停下、不告警', async () => {
      const fake = interruptibleNpm(ROOT_DIR, { npmSucceeds: true });
      const { warnings, logger } = warnLog();
      const gate = deferred();
      const applying = deferred();
      // 新装的包登记之后激活得慢：装后回执调 idle() 时状态机还在重算
      const slow = definePlugin({
        name: 'bar',
        async apply() {
          applying.resolve();
          await gate.promise;
        },
      });
      const { app, svc } = await bootPm(fake, { disposeTimeoutMs: 300, logger }, host =>
        host.bind({ provide }).provide.use(pluginSource, {
          rescan: async () => {
            void host.plugins.register(slow);
            return ['bar'];
          },
          loaded: name => host.plugins.getPlugin(name) !== undefined,
        }),
      );
      const installing = svc().install('bar');
      await applying.promise;
      await new Promise(r => setTimeout(r, 20));
      const bouncing = app.plugins.bounce(PM);
      setTimeout(() => gate.resolve(), 50);
      await bouncing;
      expect(app.plugins.getStatus().find(p => p.instanceId === PM)?.lingering).toBeFalsy();
      expect(warnings.filter(w => w.includes('超过'))).toEqual([]);
      expect(toSource(await installing)).toMatchObject({ ok: true, plugin: 'bar' });
    });

    // 卸载的正是本插件选中的 process 提供者：core 卸它要连同选中它的本插件一起关，本插件的收尾又在等这次卸载落定
    it('卸载本插件选中的 process 提供者（另有一家）：收尾在清理宽限内落定，不记为未停下、不告警，卸载照常回执', async () => {
      const fake = interruptibleNpm(ROOT_DIR, { npmSucceeds: true });
      const { warnings, logger } = warnLog();
      const proc = defineService<object>('process');
      const provider = (name: string, priority: number) =>
        definePlugin({
          name,
          provides: [proc],
          uses: { provide },
          apply: ({ provide }) => void provide.use(proc, fake.proc, { priority }),
        });
      const { app, svc } = await bootPm(fake, { disposeTimeoutMs: 300, logger }, host => {
        void host.plugins.register(provider('foo', 10));
        void host.plugins.register(provider('zz-proc-other', 0));
        host.bind({ provide }).provide.use(pluginSource, {
          rescan: async () => [],
          loaded: name => host.plugins.getPlugin(name) !== undefined,
        });
      });
      const result = await svc().uninstall('foo');
      await app.plugins.idle();
      expect(app.plugins.getPlugin('foo')).toBeUndefined();
      expect(app.plugins.getStatus().find(p => p.instanceId === PM)).toMatchObject({ state: 'active' });
      expect(app.plugins.getStatus().find(p => p.instanceId === PM)?.lingering).toBeFalsy();
      expect(warnings.filter(w => w.includes('超过'))).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it('安装在途时 app.stop()：npm 被打断，stop 兑现时两份文件已还原', async () => {
      const fake = interruptibleNpm(ROOT_DIR);
      const { app, svc } = await bootPm(fake);
      const installing = svc().install('bar');
      await npmRuns(fake, 1);
      await app.stop();
      expect(fake.files.get(fake.pkgPath)).toBe(PKG_BEFORE);
      expect(fake.files.get(fake.lockPath)).toBe(LOCK_BEFORE);
      expect(toSource(await installing)).toEqual({ ok: false, message: STOPPED });
    });
  });
});
