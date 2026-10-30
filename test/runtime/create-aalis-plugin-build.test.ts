import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from '../../packages/create-aalis-plugin/src/cli.js';

// create-aalis-plugin 生成的插件，照作者会做的那样真构建、真加载：按生成的 tsconfig 用 tsc 构建（@aalis/* 链到已构建的
// 工作区包，与宿主同一份 core），再经 runtime 的 node_modules 加载器装进 App。在子进程里用 Node 原样加载构建产物，
// 宿主一侧的 core 与插件解析到的是同一个文件。原文语言按组合的序号交替（偶数 zh-CN，奇数 en）；宿主一次不带 plugin-i18n、
// 一次带它且全局层为英文，各跑一遍：模板自带的给人看的句子（设置项、页面组件与动作的 label、指令说明）与插件前端的文字
// 不带时按原文，带且为英文时按英文。

const ROOT = join(import.meta.dirname, '../..');
const CONTRACTS = [
  'core',
  'api-tools',
  'api-commands',
  'api-webui',
  'api-session-settings',
  'api-host-config',
  'schema-config',
  'schema-i18n',
];
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
const sourceOf = (i: number) => (i % 2 === 0 ? 'zh-CN' : 'en');

/** 模板自带的给人看的句子与示例问候语，按语言 */
const SENTENCES = {
  'zh-CN': {
    greetingLabel: '问候语',
    infoLabel: '示例信息',
    removeLabel: '删除',
    commandDescription: '示例命令',
    loading: '正在加载…',
    emptyList: '列表空了',
    hello: '你好',
  },
  en: {
    greetingLabel: 'Greeting',
    infoLabel: 'Sample info',
    removeLabel: 'Remove',
    commandDescription: 'Sample command',
    loading: 'Loading…',
    emptyList: 'The list is empty',
    hello: 'Hello',
  },
};

/**
 * 子进程：每个插件装进一个新 App（示例工具与指令同名，不能同处一个 App），宿主一侧是钩子、工具服务、会话管理与会话设置的
 * 真插件（第三个参数为 i18n 时另有全局层为英文的 plugin-i18n），加上假的记忆、指令服务与用真页面登记表的 WebUI 服务。
 * 打印每个插件的激活状态与登记了什么；给人看的句子按 WebUI 的读者（全局层）渲染，同 REST 出口的 localizeFor；插件前端的
 * 字典按 frame.t 的渲染法（服务进程目录里这个插件的条目，全局层的语言链，i18n 不在时链是空的、按原文）逐键渲染
 */
const DRIVER = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [appDir, root, withI18n] = process.argv.slice(2);
const load = path => import(pathToFileURL(join(root, 'packages', path)).href);
const { App, optional, provide } = await load('core/dist/index.js');
const { i18n, localizeFor } = await load('api-i18n/dist/index.js');
const { catalogEntries, resolveSource, resolveText } = await load('schema-i18n/dist/index.js');
const { createNodeModulesPluginLoader } = await load('runtime/dist/index.js');
const { commands } = await load('api-commands/dist/index.js');
const { memory } = await load('api-memory/dist/index.js');
const { tools } = await load('api-tools/dist/index.js');
const { sessionManager } = await load('api-session-manager/dist/index.js');
const { sessionSettings } = await load('api-session-settings/dist/index.js');
const { webuiServer } = await load('api-webui/dist/index.js');
const { createPageRegistry } = await load('plugin-webui-server/dist/pages.js');
const hostPlugins = await Promise.all(
  ['plugin-hooks', 'plugin-tools', 'plugin-session-manager', 'plugin-session-settings'].map(
    async dir => (await load(dir + '/dist/index.js')).default,
  ),
);
const i18nPlugin = withI18n === 'i18n' ? (await load('plugin-i18n/dist/index.js')).default : undefined;
const quiet = () => {};
const loader = createNodeModulesPluginLoader(appDir, { hostCoreDir: join(root, 'packages/core') });
const report = {};
for (const desc of await loader.discover()) {
  const errors = [];
  const logger = { debug: quiet, info: quiet, warn: quiet, error: (...args) => errors.push(args.map(String).join(' ')) };
  logger.child = () => logger;
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide, tools, sessionManager, sessionSettings, i18n: optional(i18n) });
  host.provide.use(memory, {
    listMetadata: async () => [],
    commitMetadata: async () => {},
    getHistory: async () => [],
    clearSession: async () => {},
  });
  const commandNames = [];
  const descriptions = [];
  host.provide.use(commands, {
    prefix: '/',
    command(name, description) {
      commandNames.push(name);
      descriptions.push(description);
      const builder = { alias: () => builder, option: () => builder, argument: () => builder, action: () => builder, usage: () => builder, example: () => builder };
      return builder;
    },
    unregister: quiet,
  });
  const pages = createPageRegistry({ logger, send: quiet, sessions: { present: false }, signFile: () => undefined });
  host.provide.use(webuiServer, {
    getPort: () => 0,
    getHost: () => '127.0.0.1',
    addPage: (page, instance) => pages.addPage(page, instance),
    invalidate: quiet,
    addNotice: () => quiet,
  });
  for (const plugin of hostPlugins) await app.plugin(plugin);
  if (i18nPlugin) await app.plugin(i18nPlugin, { language: ['en'] });
  await app.plugins.idle();
  // 会话设置自己的指令不算：只记生成的插件登记的
  commandNames.length = 0;
  descriptions.length = 0;
  await app.plugin(await loader.load(desc));
  await app.plugins.idle();
  const admin = host.sessionSettings.use;
  const toolService = host.tools.use;
  const settings = admin.getAll().filter(s => s.plugin === desc.name).map(s => s.key);
  const greet = async sessionId => (await toolService.execute('hello', { name: '小明' }, { sessionId, platform: 'webui' })).content;
  const toolList = toolService.getAll().filter(t => t.pluginName === desc.name);
  const greetings = toolList.length === 0 ? [] : [await greet('plain')];
  if (toolList.length > 0 && settings.length > 0) {
    await host.sessionManager.use.ensureSession('tuned');
    await admin.update({ sessionId: 'tuned' }, { plugin: desc.name, key: settings[0], value: '早上好' });
    greetings.push(await greet('tuned'));
  }
  const render = value => localizeFor(host.i18n, value, { host: true }, { onError: err => errors.push(String(err)) });
  // plugin-i18n 也登记页面（「翻译」）：只看生成的插件登记的
  const views = pages.views().filter(view => view.instance === desc.name);
  const labels = render([
    ...admin.getAll().filter(s => s.plugin === desc.name).map(s => s.label),
    ...views.map(view => (view.frame ? view.actions.remove.label : view.content[0].label)),
    ...descriptions,
  ]);
  const entry = catalogEntries().find(e => e.ns === desc.name);
  const chain = host.i18n.present ? host.i18n.use.chainOf({ host: true }) : [];
  const shown = key => {
    const ref = { i18n: desc.name, key, source: key };
    return chain.length > 0 ? resolveText(ref, chain) : resolveSource(ref);
  };
  report[desc.name] = {
    state: app.plugins.getPlugin(desc.name)?.state,
    tools: toolList.map(t => ({ name: t.name, risk: t.risk })),
    commands: commandNames,
    pages: views.map(view => view.key),
    errors,
    settings,
    greetings,
    labels,
    dictionary: entry && { language: entry.language, locales: Object.keys(entry.locales) },
    texts: entry && Object.fromEntries(Object.keys(entry.source).map(key => [key, shown(key)])),
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

  it('全部组合：tsc 按生成的 tsconfig 构建通过；加载器认得出，激活后工具、指令、页面与可按会话设的配置项都登记上', {
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
      await generate(
        join(base, names[i]),
        { packageName: names[i], displayName: `Combo ${i}`, sourceLanguage: sourceOf(i), features },
        VERSIONS,
      );
    }
    const build = spawnSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      ['-b', ...names.map(name => join(base, name)), '--pretty', 'false'],
      { encoding: 'utf-8' },
    );
    expect(build.stdout + build.stderr, 'tsc 构建').toBe('');
    expect(build.status).toBe(0);

    // 生成的字典自检用例：原文 zh-CN 与 en 各一个目录，构建产物已在，直接跑 node --test
    for (const name of names.slice(0, 2)) {
      const test = spawnSync(process.execPath, ['--test'], { cwd: join(base, name), encoding: 'utf-8' });
      expect(test.status, `${name}：${test.stdout}${test.stderr}`).toBe(0);
    }

    // 实例的安装集：依赖写着这些插件，node_modules 里链到构建好的目录
    const app = join(base, 'app');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: Object.fromEntries(names.map(name => [name, '*'])) }),
    );
    for (const name of names) symlinkSync(join(base, name), join(app, 'node_modules', name), 'dir');
    writeFileSync(join(base, 'driver.mjs'), DRIVER);
    // main.js 用到的字典键：同一份模板，取第一个自带前端的组合
    const frameKeys = [
      ...readFileSync(join(base, names[COMBOS.findIndex(f => f.webui === 'frame')], 'webui/main.js'), 'utf-8').matchAll(
        /frame\.t\('(\w+)'\)/g,
      ),
    ].map(m => m[1]);
    expect(frameKeys.sort()).toEqual(['emptyList', 'loading', 'removeLabel']);

    for (const withI18n of [false, true]) {
      const run = spawnSync(process.execPath, [join(base, 'driver.mjs'), app, ROOT, withI18n ? 'i18n' : ''], {
        encoding: 'utf-8',
      });
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(run.stdout);

      expect(Object.keys(report).sort(), '加载器认出全部插件').toEqual([...names].sort());
      for (const [i, f] of COMBOS.entries()) {
        const r = report[names[i]];
        const source = sourceOf(i);
        const label = `${JSON.stringify(f)} 原文 ${source}${withI18n ? '，全局层英文' : ''}`;
        expect(r.state, label).toBe('active');
        expect(r.errors, label).toEqual([]);
        expect(r.tools, label).toEqual(f.tool ? [{ name: 'hello', risk: 'safe' }] : []);
        expect(r.commands, label).toEqual(f.command ? ['hello'] : []);
        expect(r.pages, label).toEqual(f.webui ? [names[i]] : []);
        expect(r.settings, label).toEqual(f.sessionSetting ? ['greeting'] : []);
        // 工具按会话读配置项的生效值：没设时是作者默认的问候语（原文语言），本会话层设了按设的；工具结果给模型，不随读者
        const hello = SENTENCES[source].hello;
        const greetings = f.tool ? [`${hello}, 小明!`, ...(f.sessionSetting ? ['早上好, 小明!'] : [])] : [];
        expect(r.greetings, label).toEqual(greetings);
        // 给人看的句子：不带 i18n 时按原文，带且全局层为英文时按英文
        const shown = SENTENCES[withI18n ? 'en' : source];
        const page = f.webui === 'frame' ? shown.removeLabel : shown.infoLabel;
        expect(r.labels, label).toEqual([
          ...(f.sessionSetting ? [shown.greetingLabel] : []),
          ...(f.webui ? [page] : []),
          ...(f.command ? [shown.commandDescription] : []),
        ]);
        expect(r.dictionary, label).toEqual({ language: source, locales: [source === 'en' ? 'zh-CN' : 'en'] });
        if (f.webui === 'frame') {
          const texts = Object.fromEntries(frameKeys.map(key => [key, r.texts[key]]));
          expect(texts, label).toEqual({
            emptyList: shown.emptyList,
            loading: shown.loading,
            removeLabel: shown.removeLabel,
          });
        }
      }
    }
  });
});
