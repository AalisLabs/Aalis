import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultLogger, type Logger, LogHub, pluginDefinitionOf } from '../../packages/core/src/index.js';
import { installConsoleSink } from '../../packages/runtime/src/console-sink.js';
import { createNodeModulesPluginLoader, loadPluginDefinition } from '../../packages/runtime/src/node-modules-loader.js';

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

// 双副本判定在 core 以 error 入 LogHub；consoleSink: false 时以前没有任何 sink，
// 默认 stderr 只剩下游「commands 服务不可用」。warn+ 打 stderr 后这条与「装了没反应」同级可见。
describe('双副本判定默认可见', () => {
  it('error 文案含「必须是单副本」，minLevel=warn 的 stderr sink 看得到（不依赖 consoleSink: true）', () => {
    const errCaptured: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errCaptured.push(args.map(String).join(' '));
    };
    const handle = installConsoleSink({ target: 'stderr', minLevel: 'warn' });
    try {
      const logger = new DefaultLogger('aalis:plugins');
      logger.info('无法执行子命令「probe」：commands 服务不可用（未安装 @aalis/plugin-commands？）');
      logger.error('资源口不属于本 core 副本的任何激活（@aalis/core 必须是单副本 peer 依赖）');
      const hit = errCaptured.find(line => line.includes('必须是单副本'));
      expect(hit).toBeDefined();
      expect(hit).toContain('ERROR');
      expect(errCaptured.some(line => line.includes('commands 服务不可用'))).toBe(false);
    } finally {
      handle.dispose();
      console.error = originalError;
    }
  });
});
