import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from '../../packages/create-aalis-plugin/src/cli.js';

// create-aalis-plugin 生成的插件，照作者会做的那样真构建、真加载：按生成的 tsconfig 用 tsc 构建（@aalis/* 链到已构建的
// 工作区包，与宿主同一份 core），再经 runtime 的 node_modules 加载器装进 App。在子进程里用 Node 原样加载构建产物，
// 宿主一侧的 core 与插件解析到的是同一个文件。

const ROOT = join(import.meta.dirname, '../..');
const CONTRACTS = ['core', 'api-tools', 'api-commands', 'api-webui', 'api-session-manager'];
const VERSIONS = Object.fromEntries(CONTRACTS.map(dir => [`@aalis/${dir}`, '0.1.0']));

type Webui = false | 'declarative' | 'frame';
interface Features {
  tool: boolean;
  command: boolean;
  webui: Webui;
  sessionSetting: boolean;
}

const COMBOS: Features[] = [];
for (let mask = 0; mask < 8; mask++) {
  for (const webui of [false, 'declarative', 'frame'] as const) {
    COMBOS.push({ tool: Boolean(mask & 1), command: Boolean(mask & 2), webui, sessionSetting: Boolean(mask & 4) });
  }
}

/**
 * 子进程：每个插件装进一个新 App（示例工具与指令同名，不能同处一个 App），宿主一侧是钩子、工具服务与会话管理的真插件，
 * 加上假的记忆、指令服务与用真页面登记表的 WebUI 服务。打印每个插件的激活状态与登记了什么
 */
const DRIVER = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [appDir, root] = process.argv.slice(2);
const load = path => import(pathToFileURL(join(root, 'packages', path)).href);
const { App, provide } = await load('core/dist/index.js');
const { createNodeModulesPluginLoader } = await load('runtime/dist/index.js');
const { commands } = await load('api-commands/dist/index.js');
const { memory } = await load('api-memory/dist/index.js');
const { tools } = await load('api-tools/dist/index.js');
const { sessionManager } = await load('api-session-manager/dist/index.js');
const { webuiServer } = await load('api-webui/dist/index.js');
const { createPageRegistry } = await load('plugin-webui-server/dist/pages.js');
const hostPlugins = await Promise.all(
  ['plugin-hooks', 'plugin-tools', 'plugin-session-manager'].map(async dir => (await load(dir + '/dist/index.js')).default),
);
const quiet = () => {};
const loader = createNodeModulesPluginLoader(appDir, { hostCoreDir: join(root, 'packages/core') });
const report = {};
for (const desc of await loader.discover()) {
  const errors = [];
  const logger = { debug: quiet, info: quiet, warn: quiet, error: (...args) => errors.push(args.map(String).join(' ')) };
  logger.child = () => logger;
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide, tools, sessionManager });
  host.provide(memory, {
    listMetadata: async () => [],
    commitMetadata: async () => {},
    getHistory: async () => [],
    clearSession: async () => {},
  });
  const commandNames = [];
  host.provide(commands, {
    prefix: '/',
    command(name) {
      commandNames.push(name);
      const builder = { alias: () => builder, option: () => builder, argument: () => builder, action: () => builder, usage: () => builder, example: () => builder };
      return builder;
    },
    unregister: quiet,
  });
  const pages = createPageRegistry({ logger, send: quiet, sessions: () => undefined, signFile: () => undefined });
  host.provide(webuiServer, {
    getPort: () => 0,
    getHost: () => '127.0.0.1',
    addPage: (page, instance) => pages.addPage(page, instance),
    invalidate: quiet,
    addNotice: () => quiet,
  });
  for (const plugin of hostPlugins) await app.plugin(plugin);
  await app.plugin(await loader.load(desc));
  await app.plugins.idle();
  const sm = host.sessionManager.require();
  const toolService = host.tools.require();
  const settings = sm.listSettings().filter(s => s.plugin === desc.name).map(s => s.key);
  const greet = async sessionId => (await toolService.execute('hello', { name: '小明' }, { sessionId, platform: 'webui' })).content;
  const toolList = toolService.getAll().filter(t => t.pluginName === desc.name);
  const greetings = toolList.length === 0 ? [] : [await greet('plain')];
  if (toolList.length > 0 && settings.length > 0) {
    await sm.ensureSession('tuned', { config: { [settings[0]]: '早上好' } });
    greetings.push(await greet('tuned'));
  }
  report[desc.name] = {
    state: app.plugins.getPlugin(desc.name)?.state,
    tools: toolList.map(t => ({ name: t.name, risk: t.risk })),
    commands: commandNames,
    pages: pages.views().map(view => view.key),
    errors,
    settings,
    greetings,
  };
  pages.dispose();
  await app.stop();
}
console.log(JSON.stringify(report));
`;

describe('create-aalis-plugin 生成的插件真构建、真加载', () => {
  let base: string;
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('全部组合：tsc 按生成的 tsconfig 构建通过；加载器认得出，激活后工具、指令、页面与会话设置项都登记上', {
    timeout: 180_000,
  }, async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-scaffold-build-')));
    // 生成的插件共用上一级的 node_modules：@aalis/* 链到工作区包，开发依赖里的 @types/node 链到仓库那份（作者 npm install 后就有）
    mkdirSync(join(base, 'node_modules/@aalis'), { recursive: true });
    for (const dir of CONTRACTS)
      symlinkSync(join(ROOT, 'packages', dir), join(base, 'node_modules/@aalis', dir), 'dir');
    mkdirSync(join(base, 'node_modules/@types'));
    symlinkSync(join(ROOT, 'node_modules/@types/node'), join(base, 'node_modules/@types/node'), 'dir');
    const names = COMBOS.map((_, i) => `zz-scaffold-${i}`);
    for (const [i, features] of COMBOS.entries()) {
      await generate(join(base, names[i]), { packageName: names[i], displayName: `组合 ${i}`, features }, VERSIONS);
    }
    const build = spawnSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      ['-b', ...names.map(name => join(base, name)), '--pretty', 'false'],
      { encoding: 'utf-8' },
    );
    expect(build.stdout + build.stderr, 'tsc 构建').toBe('');
    expect(build.status).toBe(0);

    // 实例的安装集：依赖写着这些插件，node_modules 里链到构建好的目录
    const app = join(base, 'app');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: Object.fromEntries(names.map(name => [name, '*'])) }),
    );
    for (const name of names) symlinkSync(join(base, name), join(app, 'node_modules', name), 'dir');
    writeFileSync(join(base, 'driver.mjs'), DRIVER);
    const run = spawnSync(process.execPath, [join(base, 'driver.mjs'), app, ROOT], { encoding: 'utf-8' });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout);

    expect(Object.keys(report).sort(), '加载器认出全部插件').toEqual([...names].sort());
    for (const [i, f] of COMBOS.entries()) {
      const r = report[names[i]];
      const label = JSON.stringify(f);
      expect(r.state, label).toBe('active');
      expect(r.errors, label).toEqual([]);
      expect(r.tools, label).toEqual(f.tool ? [{ name: 'hello', risk: 'safe' }] : []);
      expect(r.commands, label).toEqual(f.command ? ['hello'] : []);
      expect(r.pages, label).toEqual(f.webui ? [names[i]] : []);
      expect(r.settings, label).toEqual(f.sessionSetting ? [`greetingZzScaffold${i}`] : []);
      // 工具按会话读设置项的生效值：没设时是默认的问候语
      const greetings = f.tool ? ['你好, 小明!', ...(f.sessionSetting ? ['早上好, 小明!'] : [])] : [];
      expect(r.greetings, label).toEqual(greetings);
    }
  });
});
