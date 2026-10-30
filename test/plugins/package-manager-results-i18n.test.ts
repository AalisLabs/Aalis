import { afterEach, describe, expect, it } from 'vitest';
import { type PackageManagerService, packageManager } from '../../packages/api-package-manager/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { createPackageManager, type PackageManagerDeps } from '../../packages/plugin-package-manager/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { defineTexts } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, setHostLanguage } from '../fixtures/host-language.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 包管理的装卸与更新结果：message 与 conflicts 可以是文字对象，WebUI 的市场接口按全局层的语言渲染（en 拿英文，zh-CN
// 拿原文），原样的字符串照旧。包管理服务是替身，webui-server 与 plugin-i18n 是真的，全局语言写在宿主配置文档里。
// 另一组用真的包管理（createPackageManager），子进程与文件是替身：装卸与更新失败时它自己的 message 与 conflicts。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-package-results-token-placeholder';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const t = defineTexts({
  ns: '@zz/package-results',
  language: 'zh-CN',
  source: { failed: '预检没有通过', conflict: '{name} 要求的 core 版本装不上' } as const,
  locales: { en: { failed: 'The dry run failed', conflict: 'The core version that {name} needs cannot be installed' } },
});

const fake: PackageManagerService = {
  install: async () => ({ ok: false, message: t('failed') }),
  uninstall: async () => ({ ok: false, message: t('failed') }),
  update: async () => ({
    ok: false,
    message: t('failed'),
    conflicts: [t('conflict', { name: '@zz/a' }), 'npm ERR! peer core@0.30'],
  }),
  serviceDependents: () => [],
  registry: async () => 'https://registry.example.invalid',
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(service: PackageManagerService = fake) {
  const port = await freePort();
  const { app } = hostedApp(i18nSection(['en']), { logger: silent });
  apps.push(app);
  app.bind({ provide }).provide.use(packageManager, service);
  const setLanguage = (language: string[]) => setHostLanguage(app, language);
  await app.plugin(i18nPlugin);
  await app.plugin(webuiServer, { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/marketplace/${path}`, {
      method: 'POST',
      headers: { cookie: `aalis_webui_token=${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  return { post, setLanguage };
}

describe('包管理结果按全局层的语言', () => {
  it('更新的 message 与 conflicts、卸载的 message：en 拿英文，zh-CN 拿原文，原样的字符串照旧', async () => {
    const { post, setLanguage } = await setup();
    const update = { targets: [{ name: '@zz/a', version: '1.0.0' }] };
    expect(await post('update', update)).toEqual({
      ok: false,
      message: 'The dry run failed',
      conflicts: ['The core version that @zz/a needs cannot be installed', 'npm ERR! peer core@0.30'],
    });
    expect(await post('uninstall', { name: '@zz/a' })).toEqual({ ok: false, message: 'The dry run failed' });
    setLanguage(['zh-CN']);
    expect(await post('update', update)).toEqual({
      ok: false,
      message: '预检没有通过',
      conflicts: ['@zz/a 要求的 core 版本装不上', 'npm ERR! peer core@0.30'],
    });
  });
});

describe('包管理自己的失败原因按全局层的语言', () => {
  const ROOT = '/zz-root';
  /** 子进程替身：npm 按 npm(args) 回 stdout 与 stderr，fail 时以非零退出抛出；其余命令照常成功 */
  type Npm = (args: readonly string[]) => { stdout?: string; stderr?: string; fail?: boolean };
  /** 真的包管理：文件按 files 读（绝对路径 → JSON），npm 走替身 */
  const real = (npm: Npm, files: Record<string, unknown>, deps: Partial<PackageManagerDeps> = {}) =>
    createPackageManager({
      proc: {
        makeTempDir: async () => ({ path: '/zz-preflight', cleanup: async () => {} }),
        execFile: async (cmd: string, args: readonly string[]) => {
          if (cmd === 'test') throw new Error('test: exit 1');
          const out = cmd === 'npm' ? npm(args) : {};
          const result = { stdout: out.stdout ?? '', stderr: out.stderr ?? '', code: out.fail ? 1 : 0 };
          if (out.fail) throw Object.assign(new Error('npm exit 1'), { result });
          return result;
        },
      } as never,
      log: { info() {}, error() {}, warn() {} },
      projectRoot: () => ROOT,
      readText: async path => (path in files ? JSON.stringify(files[path]) : undefined),
      rescanPlugins: async () => [],
      isPluginRegistered: () => false,
      unloadPlugin: async () => {},
      restartApp: () => {},
      ...deps,
    });
  const PLUGIN = { keywords: ['aalis', 'aalis-plugin'] };

  it.each([
    [
      '安装时磁盘满（ENOSPC）',
      real(
        args =>
          args[0] === 'view'
            ? { stdout: JSON.stringify(PLUGIN.keywords) }
            : { fail: true, stderr: 'npm error code ENOSPC' },
        {
          [`${ROOT}/package.json`]: { dependencies: {} },
        },
      ),
      ['install', { name: '@zz/a' }],
      { ok: false, message: 'Not enough disk space (ENOSPC): free some space and retry' },
    ],
    [
      '更新时预检报出没满足的 peer',
      real(() => ({ stderr: 'npm warn peer @zz/a@"^1.0.0" from @zz/b@1.0.0' }), {
        [`${ROOT}/package.json`]: { dependencies: { '@zz/a': '^1.0.0' } },
        [`${ROOT}/node_modules/@zz/a/package.json`]: { version: '1.0.0' },
      }),
      ['update', { targets: [{ name: '@zz/a', version: '2.0.0' }] }],
      {
        ok: false,
        message:
          'The dependency dry run did not pass; no files were changed. If it is a peer version requirement, select the depended-on packages too and retry.',
        conflicts: ['@zz/b@1.0.0 needs @zz/a@^1.0.0'],
      },
    ],
    [
      '卸载正在承载管理界面的包',
      real(
        () => ({}),
        { [`${ROOT}/node_modules/@zz/ui/package.json`]: PLUGIN },
        {
          recoveryChannelProviders: () => ['@zz/ui'],
        },
      ),
      ['uninstall', { name: '@zz/ui' }],
      {
        ok: false,
        message:
          '@zz/ui is hosting the market and management interface itself; uninstalling it would make this page unavailable at once, leaving only the terminal to recover. To switch implementations, install the replacement and switch to it in the service preferences under Settings “System” first, then come back and uninstall this one.',
      },
    ],
    [
      '卸载不是经市场装的包（由别的插件带入）',
      real(() => ({}), {
        [`${ROOT}/node_modules/@zz/c/package.json`]: PLUGIN,
        [`${ROOT}/package.json`]: { dependencies: {} },
      }),
      ['uninstall', { name: '@zz/c' }],
      {
        ok: false,
        message:
          '@zz/c was not installed through the market: it is not a root dependency (another plugin brought it in) and npm prunes it along with the plugin that brought it in.',
      },
    ],
  ] as const)('en：%s', async (_label, service, [path, body], expected) => {
    const { post } = await setup(service);
    expect(await post(path, body)).toEqual(expected);
  });

  it.each([
    [
      'en',
      [
        'These target versions are not higher than the installed ones (or the installed version cannot be read), so the update would be a downgrade and was refused: @zz/a (installed 2.0.0 → target 1.0.0), @zz/b (installed unknown → target 1.0.0)',
        'Uninstalling would break dependencies: these plugins depend on services this plugin provides and no other plugin provides them: @zz/x, @zz/y. Disable them first, or enable or install an alternative provider.',
      ],
    ],
    [
      'zh-CN',
      [
        '以下目标版本不高于本地已装版本（或本地版本号读不到），更新会变成降级，已拒绝：@zz/a（本地 2.0.0 → 目标 1.0.0）、@zz/b（本地 未知 → 目标 1.0.0）',
        '卸载会破坏依赖：@zz/x、@zz/y 依赖此插件提供的服务，且没有别的插件正在提供。请先停用它们，或启用 / 安装替代提供者。',
      ],
    ],
  ])('%s：列表拼进整句（两个降级目标、其中一个读不到本地版本；两个服务依赖者）', async (language, messages) => {
    const required = { key: 'svc', service: 'zz-svc', kind: 'required' } as const;
    const service = real(
      () => ({}),
      {
        [`${ROOT}/package.json`]: { dependencies: { '@zz/a': '^1.0.0', '@zz/b': '^1.0.0', '@zz/p': '^1.0.0' } },
        [`${ROOT}/node_modules/@zz/a/package.json`]: { version: '2.0.0' },
        [`${ROOT}/node_modules/@zz/p/package.json`]: PLUGIN,
      },
      {
        pluginStatus: () => [
          { name: '@zz/p', instanceId: '@zz/p', state: 'active', provides: ['zz-svc'], uses: [] },
          { name: '@zz/x', instanceId: '@zz/x', state: 'active', uses: [required] },
          { name: '@zz/y', instanceId: '@zz/y', state: 'active', uses: [required] },
        ],
        availableServices: () => ['zz-svc'],
      },
    );
    const { post, setLanguage } = await setup(service);
    setLanguage([language]);
    const targets = [
      { name: '@zz/a', version: '1.0.0' },
      { name: '@zz/b', version: '1.0.0' },
    ];
    const replies = [await post('update', { targets }), await post('uninstall', { name: '@zz/p' })];
    expect(replies).toEqual(messages.map(message => ({ ok: false, message })));
  });
});
