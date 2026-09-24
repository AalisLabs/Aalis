import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginDefinitionOf } from '../../packages/api-plugin-source/src/index.js';
import { App, type Logger, LogHub } from '../../packages/core/src/index.js';
import { createConfigStore } from '../../packages/runtime/src/config-store.js';
import { installConsoleSink } from '../../packages/runtime/src/console-sink.js';
import { createNodeModulesPluginLoader, loadPluginDefinition } from '../../packages/runtime/src/node-modules-loader.js';
import { createPluginDiscovery } from '../../packages/runtime/src/plugin-discovery.js';

// ════════════════════════════════════════════════════════════
// 加载链信号：「装了没反应」死门族的告警锚。
// 入口只认 default 导出的插件定义（definePlugin 的产物）；不是就
// 必须出声。pluginDefinitionOf 是两加载器共用的解包点。
// ════════════════════════════════════════════════════════════

function writePkg(nm: string, name: string, pkg: Record<string, unknown>, entrySource?: string): void {
  const dir = join(nm, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }));
  if (entrySource !== undefined) writeFileSync(join(dir, 'index.mjs'), entrySource);
}

function capturingLogger() {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(message: string) {
      warns.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

describe('加载链信号', () => {
  let proj: string;
  let warns: string[];
  let offHub: () => void;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'aalis-loader-'));
    const nm = join(proj, 'node_modules');
    writeFileSync(
      join(proj, 'package.json'),
      JSON.stringify({
        name: 'proj',
        dependencies: {
          'plugin-default': '1.0.0',
          'plugin-mismatch': '1.0.0',
          'plugin-named': '1.0.0',
          libish: '1.0.0',
          broken: '1.0.0',
        },
      }),
    );
    writePkg(
      nm,
      'plugin-default',
      { main: 'index.mjs', keywords: ['aalis-plugin'] },
      'function definePlugin(d) { return d; }\nexport default definePlugin({ name: "plugin-default", apply() {} });\n',
    );
    writePkg(
      nm,
      'plugin-mismatch',
      { main: 'index.mjs', keywords: ['aalis-plugin'] },
      'function definePlugin(d) { return d; }\nexport default definePlugin({ name: "other-name", apply() {} });\n',
    );
    writePkg(
      nm,
      'plugin-named',
      { main: 'index.mjs', keywords: ['aalis-plugin'] },
      'export const name = "plugin-named";\nexport function apply() {}\n',
    );
    writePkg(nm, 'libish', { main: 'index.mjs', peerDependencies: { '@aalis/core': '*' } }, 'export const x = 1;\n');
    writePkg(nm, 'broken', { main: 'missing.mjs', keywords: ['aalis-plugin'] });
    warns = [];
    offHub = LogHub.default.onEntry(e => {
      if (e.level === 'warn' && e.scope === 'aalis:loader') warns.push(e.message);
    });
  });

  afterEach(() => {
    offHub();
    rmSync(proj, { recursive: true, force: true });
  });

  it('discover：入口解析失败与疑似缺关键词各自 warn 点名，正常插件照常收录', async () => {
    const loader = createNodeModulesPluginLoader(proj);
    const found = await loader.discover();
    expect(found.map(d => d.name).sort()).toEqual(['plugin-default', 'plugin-mismatch', 'plugin-named']);
    expect(warns.some(w => w.includes('broken') && w.includes('入口无法解析'))).toBe(true);
    expect(warns.some(w => w.includes('libish') && w.includes('缺 "aalis-plugin"'))).toBe(true);
  });

  it('load：default definePlugin 可加载，无形状告警', async () => {
    const loader = createNodeModulesPluginLoader(proj);
    const desc = (await loader.discover()).find(d => d.name === 'plugin-default');
    const def = await loader.load?.(desc as never);
    expect(def?.name).toBe('plugin-default');
    expect(typeof def?.apply).toBe('function');
    expect(warns.filter(w => w.includes('plugin-default'))).toEqual([]);
  });

  it('pluginDefinitionOf：仅具名导出、无 default → warn 出声并跳过', async () => {
    expect(pluginDefinitionOf({ name: 'plugin-named', apply() {} })).toBeNull();
    const { logger, warns: local } = capturingLogger();
    expect(loadPluginDefinition({ name: 'plugin-named', apply() {} }, 'plugin-named', logger)).toBeNull();
    expect(local.some(w => w.includes('plugin-named') && w.includes('没有默认导出插件定义'))).toBe(true);

    const loader = createNodeModulesPluginLoader(proj);
    const desc = (await loader.discover()).find(d => d.name === 'plugin-named');
    const def = await loader.load?.(desc as never);
    expect(def).toBeNull();
    expect(warns.some(w => w.includes('plugin-named') && w.includes('没有默认导出插件定义'))).toBe(true);
  });

  it('pluginDefinitionOf：default 是函数或非定义对象 → warn 出声并跳过', async () => {
    const { logger, warns: local } = capturingLogger();
    function fnPlugin() {}
    expect(pluginDefinitionOf({ default: fnPlugin })).toBeNull();
    expect(loadPluginDefinition({ default: fnPlugin }, 'plugin-fn', logger)).toBeNull();
    class ClsPlugin {}
    expect(pluginDefinitionOf({ default: ClsPlugin })).toBeNull();
    expect(loadPluginDefinition({ default: ClsPlugin }, 'plugin-cls', logger)).toBeNull();
    expect(pluginDefinitionOf({ default: { foo: 1 } })).toBeNull();
    expect(loadPluginDefinition({ default: { foo: 1 } }, 'plugin-plain', logger)).toBeNull();
    expect(local.some(w => w.includes('plugin-fn') && w.includes('没有默认导出插件定义'))).toBe(true);
    expect(local.some(w => w.includes('plugin-cls') && w.includes('没有默认导出插件定义'))).toBe(true);
    expect(local.some(w => w.includes('plugin-plain') && w.includes('没有默认导出插件定义'))).toBe(true);

    // 端到端：export default function 的包必须发「没有默认导出插件定义」告警（而非假激活）
    writePkg(
      join(proj, 'node_modules'),
      'plugin-fn',
      { main: 'index.mjs', keywords: ['aalis-plugin'] },
      'export default function pluginFn() {}\n',
    );
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'proj', dependencies: { 'plugin-fn': '1.0.0' } }));
    const loader = createNodeModulesPluginLoader(proj);
    const desc = (await loader.discover()).find(d => d.name === 'plugin-fn');
    const def = await loader.load?.(desc as never);
    expect(def).toBeNull();
    expect(warns.some(w => w.includes('plugin-fn') && w.includes('没有默认导出插件定义'))).toBe(true);
  });

  it('pluginDefinitionOf：定义 name 与包名不一致 → warn 点名（配置键/热扫描/卸载以定义 name 为准）', async () => {
    const { logger, warns: local } = capturingLogger();
    const def = pluginDefinitionOf({ default: { name: 'other-name', apply() {} } });
    expect(def?.name).toBe('other-name');
    expect(loadPluginDefinition({ default: { name: 'other-name', apply() {} } }, 'plugin-mismatch', logger)?.name).toBe(
      'other-name',
    );
    expect(local.some(w => w.includes('plugin-mismatch') && w.includes('定义 name'))).toBe(true);

    const loader = createNodeModulesPluginLoader(proj);
    const desc = (await loader.discover()).find(d => d.name === 'plugin-mismatch');
    await loader.load?.(desc as never);
    expect(warns.some(w => w.includes('plugin-mismatch') && w.includes('定义 name'))).toBe(true);
  });
});

// 两份 @aalis/core：加载器在 import 之前核对插件解析到的 core 是否宿主那份，不是就拒载该插件，
// 由 App 逐插件记 error、其余插件照常加载。宿主那份经 hostCoreDir 注入，不依赖仓库真实布局。
describe('两份 @aalis/core', () => {
  let base: string;
  let proj: string;
  let hostCore: string;
  let theirCore: string;

  /** 在 dir 下手写一份 node_modules/@aalis/core：检测只看目录布局，有 package.json 即可 */
  function writeCore(dir: string, version: string): string {
    const coreDir = join(dir, 'node_modules', '@aalis', 'core');
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, 'package.json'), JSON.stringify({ name: '@aalis/core', version }));
    return realpathSync(coreDir);
  }

  const pluginMeta = { main: 'index.mjs', keywords: ['aalis-plugin'] };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-two-core-')));
    proj = join(base, 'proj');
    mkdirSync(proj);
    hostCore = writeCore(proj, '0.0.1-host');
    const nm = join(proj, 'node_modules');
    // 同一份：不带嵌套副本，上溯到项目那份（入口不 import core，能真正加载）
    writePkg(nm, 'plugin-same', pluginMeta, 'export default { name: "plugin-same", apply() {} };\n');
    // 同一份：嵌套副本是指向项目那份的符号链接（realpath 相同）
    writePkg(nm, 'plugin-linked-core', pluginMeta, 'export default { name: "plugin-linked-core", apply() {} };\n');
    mkdirSync(join(nm, 'plugin-linked-core', 'node_modules', '@aalis'), { recursive: true });
    symlinkSync(hostCore, join(nm, 'plugin-linked-core', 'node_modules', '@aalis', 'core'));
    // 另一份：本地插件目录以符号链接装进项目，目录里自带一份 core（devDependencies 装的）。
    // 入口 import 的 core 没有入口文件，import 必失败——检测若未在 import 之前拦下，错误文案对不上。
    writePkg(
      base,
      'my-plugin',
      { ...pluginMeta, name: 'plugin-dup' },
      "import { definePlugin } from '@aalis/core';\nexport default definePlugin({ name: 'plugin-dup', apply() {} });\n",
    );
    theirCore = writeCore(join(base, 'my-plugin'), '0.0.2-plugin');
    symlinkSync(join(base, 'my-plugin'), join(nm, 'plugin-dup'));
    writeFileSync(
      join(proj, 'package.json'),
      JSON.stringify({
        name: 'proj',
        dependencies: { 'plugin-same': '1.0.0', 'plugin-linked-core': '1.0.0', 'plugin-dup': 'file:../my-plugin' },
      }),
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('插件解析到另一份 core：load / reload 在 import 之前拒绝，错误写明两份的路径与版本', async () => {
    const loader = createNodeModulesPluginLoader(proj, { hostCoreDir: hostCore });
    const desc = (await loader.discover()).find(d => d.name === 'plugin-dup');
    if (!desc) throw new Error('plugin-dup 未被发现');
    for (const attempt of [loader.load(desc), loader.reload?.(desc)]) {
      const message = await Promise.resolve(attempt).then(
        () => '未拒绝',
        (e: Error) => e.message,
      );
      expect(message).toContain('插件 "plugin-dup" 解析到另一份 @aalis/core');
      for (const part of [theirCore, '0.0.2-plugin', hostCore, '0.0.1-host']) expect(message).toContain(part);
    }
  });

  it('插件解析到同一份 core（上溯到宿主那份 / 嵌套副本是指向它的符号链接）：照常加载', async () => {
    const loader = createNodeModulesPluginLoader(proj, { hostCoreDir: hostCore });
    const found = await loader.discover();
    for (const name of ['plugin-same', 'plugin-linked-core']) {
      const desc = found.find(d => d.name === name);
      if (!desc) throw new Error(`${name} 未被发现`);
      expect((await loader.load(desc))?.name).toBe(name);
    }
  });

  // consoleSink: false 时宿主仍装 minLevel=warn 的 stderr sink：拒载是 error，必须打到 stderr，
  // 不能只剩下游「某服务不可用」。
  it('App 记下的拒载 error 经 minLevel=warn 的 stderr sink 可见，其余插件照常加载', async () => {
    const errCaptured: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errCaptured.push(args.map(String).join(' '));
    };
    const handle = installConsoleSink({ target: 'stderr', minLevel: 'warn' });
    const app = new App({ name: 'T', logLevel: 'info' });
    try {
      await createPluginDiscovery(
        app,
        createNodeModulesPluginLoader(proj, { hostCoreDir: hostCore }),
        createConfigStore({}),
      ).loadAll();
      const hit = errCaptured.find(line => line.includes('另一份 @aalis/core'));
      expect(hit).toContain('ERROR');
      expect(hit).toContain('加载插件 "plugin-dup" 失败');
      expect(app.plugins.getPlugin('plugin-dup')).toBeUndefined();
      expect(app.plugins.getPlugin('plugin-same')).toBeDefined();
      expect(app.plugins.getPlugin('plugin-linked-core')).toBeDefined();
      expect(errCaptured.some(line => line.includes('INFO'))).toBe(false);
    } finally {
      await app.stop();
      handle.dispose();
      console.error = originalError;
    }
  });
});
