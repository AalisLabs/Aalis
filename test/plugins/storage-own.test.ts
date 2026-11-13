import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PluginDirStorage, storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, type Logger } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// api-storage 的绑定给每个插件两个目录，目录名同一规则（@aalis 包是包名去掉 plugin-，别的作用域另带作用域）：私有目录
// own（pluginData:/<目录名>/）与内容目录 content（self:/<目录名>/）。路径相对目录，越不出去。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

describe('插件的私有目录 storage.own', () => {
  let home: string;
  let app: App;

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-storage-own-')));
    app = new App({ logLevel: 'error', logger: silent });
    provideHostPaths(app, home);
    await app.plugin(storageLocal, { roots: [] });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(home, { recursive: true, force: true });
  });

  async function ownOf(name: string, instanceId?: string, view: 'own' | 'content' = 'own'): Promise<PluginDirStorage> {
    let own: PluginDirStorage | undefined;
    const plugin = definePlugin({
      name,
      reusable: true,
      uses: { storage },
      apply(caps) {
        own = caps.storage.use[view];
      },
    });
    await app.plugins.register(plugin, {}, instanceId);
    await app.plugins.idle();
    if (!own) throw new Error(`${name} 未激活`);
    return own;
  }

  it('相对路径落在本插件的目录下，多实例共用这个目录', async () => {
    const own = await ownOf('@zz/plugin-probe');
    expect(own.uri('a/b.json')).toBe('pluginData:/zz+probe/a/b.json');
    await own.writeFile('a/b.json', '{}');
    expect(readFileSync(join(home, 'state', 'plugins', 'zz+probe', 'a', 'b.json'), 'utf8')).toBe('{}');
    expect((await ownOf('@zz/plugin-probe', '@zz/plugin-probe:second')).uri()).toBe('pluginData:/zz+probe');
  });

  it('目录名：@aalis 与不带作用域的包是包名去掉 plugin-，别的作用域另带作用域，两个作用域的同名插件不共用目录', async () => {
    const dirs = [];
    for (const name of ['@aalis/plugin-draw', 'plugin-solo', 'bare', '@zz/plugin-probe', '@yy/plugin-probe', '@zz/raw'])
      dirs.push((await ownOf(name)).uri());
    expect(dirs).toEqual([
      'pluginData:/draw',
      'pluginData:/solo',
      'pluginData:/bare',
      'pluginData:/zz+probe',
      'pluginData:/yy+probe',
      'pluginData:/zz+raw',
    ]);
  });

  it('取不出单段目录名的插件名：绑定时抛错，插件激活失败', async () => {
    for (const name of ['@zz/plugin-', 'plugin-', '@zz/..', '@zz/.', 'zz/.', '..', '@zz/a/b', 'a\\b']) {
      await app.plugins.register(definePlugin({ name, uses: { storage }, apply() {} }), {});
      await app.plugins.idle();
      const entry = app.plugins.getPlugin(name);
      expect([name, entry?.state, entry?.error]).toEqual([name, 'error', expect.stringContaining('取不出目录名')]);
    }
  });

  it('越不出去：../ 越过目录、宿主机绝对路径与存储地址都抛错', async () => {
    const own = await ownOf('@zz/plugin-probe');
    expect(own.uri('a/../b')).toBe('pluginData:/zz+probe/b');
    expect(() => own.uri('../other/x')).toThrow('路径越出插件的 pluginData:/zz+probe/');
    expect(() => own.readFile('a/../../other/x')).toThrow('路径越出插件的 pluginData:/zz+probe/');
    expect(() => own.uri('/etc/passwd')).toThrow('只收相对路径');
    expect(() => own.uri('data:/x')).toThrow('只收相对路径');
  });

  describe('内容目录 storage.content：self:/<目录名>/，与私有目录同一套目录名与越界规则', () => {
    it('相对路径落在 self 根下本插件的目录里', async () => {
      const content = await ownOf('@aalis/plugin-persona', undefined, 'content');
      expect(content.uri()).toBe('self:/persona');
      expect(content.uri('main.yaml')).toBe('self:/persona/main.yaml');
      await content.writeFile('main.yaml', 'name: x\n');
      expect(readFileSync(join(home, 'self', 'persona', 'main.yaml'), 'utf8')).toBe('name: x\n');
      expect((await ownOf('@zz/plugin-probe', undefined, 'content')).uri('a')).toBe('self:/zz+probe/a');
    });

    it('越不出去', async () => {
      const content = await ownOf('@zz/plugin-probe', undefined, 'content');
      expect(() => content.uri('../skills/x')).toThrow('路径越出插件的 self:/zz+probe/');
      expect(() => content.uri('/etc/passwd')).toThrow('只收相对路径');
      expect(() => content.uri('self:/skills/x')).toThrow('只收相对路径');
    });
  });
});
