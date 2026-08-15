import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogHub } from '../../packages/core/src/index.js';
import { createNodeModulesPluginLoader, unwrapPluginModule } from '../../packages/runtime/src/node-modules-loader.js';

// ════════════════════════════════════════════════════════════
// 加载链信号：「装了没反应」死门族的告警锚。
// 修前四条死路全静默：export default 永不加载（判据不认）、入口解析失败
// 静默 continue、缺 aalis-plugin 关键词零日志、module.name 与包名失配三路走偏。
// ════════════════════════════════════════════════════════════

function writePkg(nm: string, name: string, pkg: Record<string, unknown>, entrySource?: string): void {
  const dir = join(nm, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }));
  if (entrySource !== undefined) writeFileSync(join(dir, 'index.mjs'), entrySource);
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
        dependencies: { 'plugin-default': '1.0.0', 'plugin-mismatch': '1.0.0', libish: '1.0.0', broken: '1.0.0' },
      }),
    );
    writePkg(
      nm,
      'plugin-default',
      { main: 'index.mjs', keywords: ['aalis-plugin'] },
      'export default { name: "plugin-default", apply() {} };\n',
    );
    writePkg(
      nm,
      'plugin-mismatch',
      { main: 'index.mjs', keywords: ['aalis-plugin'] },
      'export const name = "other-name";\nexport function apply() {}\n',
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
    expect(found.map(d => d.name).sort()).toEqual(['plugin-default', 'plugin-mismatch']);
    expect(warns.some(w => w.includes('broken') && w.includes('入口无法解析'))).toBe(true);
    expect(warns.some(w => w.includes('libish') && w.includes('缺 "aalis-plugin"'))).toBe(true);
  });

  it('load：export default 解包后可加载（修前该形态永不加载），无形状告警', async () => {
    const loader = createNodeModulesPluginLoader(proj);
    const desc = (await loader.discover()).find(d => d.name === 'plugin-default');
    const mod = await loader.load?.(desc as never);
    expect(mod?.name).toBe('plugin-default');
    expect(typeof mod?.apply).toBe('function');
    expect(warns.filter(w => w.includes('plugin-default'))).toEqual([]);
  });

  it('load：module.name 与包名失配 warn 点名（配置键/热扫描/卸载以 module.name 为准）', async () => {
    const loader = createNodeModulesPluginLoader(proj);
    const desc = (await loader.discover()).find(d => d.name === 'plugin-mismatch');
    await loader.load?.(desc as never);
    expect(warns.some(w => w.includes('plugin-mismatch') && w.includes('module.name'))).toBe(true);
  });

  it('unwrapPluginModule：具名形态原样返回，default 对象形态解包，两者兼备取具名', () => {
    const named = { name: 'a', apply() {} };
    expect(unwrapPluginModule(named)).toBe(named);
    const wrapped = { default: { name: 'b', apply() {} } };
    expect(unwrapPluginModule(wrapped)).toBe(wrapped.default);
    const both = { name: 'c', apply() {}, default: { name: 'd', apply() {} } };
    expect(unwrapPluginModule(both)).toBe(both);
  });

  it('unwrapPluginModule：default 为函数/类不解包（Function.prototype.apply 不是插件契约）', async () => {
    // 误解包会让 core 调到 Function.prototype.apply——插件体以 ctx=undefined 空跑却报「已激活」
    function fnPlugin() {}
    const fnNs = { default: fnPlugin };
    expect(unwrapPluginModule(fnNs)).toBe(fnNs);
    class ClsPlugin {}
    const clsNs = { default: ClsPlugin };
    expect(unwrapPluginModule(clsNs)).toBe(clsNs);

    // 端到端：export default function 的包必须发「缺少具名导出」告警（而非失配/假激活）
    writePkg(
      join(proj, 'node_modules'),
      'plugin-fn',
      { main: 'index.mjs', keywords: ['aalis-plugin'] },
      'export default function pluginFn() {}\n',
    );
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'proj', dependencies: { 'plugin-fn': '1.0.0' } }));
    const loader = createNodeModulesPluginLoader(proj);
    const desc = (await loader.discover()).find(d => d.name === 'plugin-fn');
    const mod = await loader.load?.(desc as never);
    expect(typeof mod?.apply).not.toBe('function'); // 命名空间原样返回，core 会跳过
    expect(warns.some(w => w.includes('plugin-fn') && w.includes('缺少具名导出'))).toBe(true);
  });
});
