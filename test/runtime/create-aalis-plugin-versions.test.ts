import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generate,
  renderIndexTs,
  renderPackageJson,
  renderReadme,
  renderTsconfig,
} from '../../packages/create-aalis-plugin/src/cli.js';
import { resolveText, type TextFactory } from '../../packages/schema-i18n/src/index.js';

// create-aalis-plugin 生成的依赖写法、工具的风险声明、可按会话设的配置项一问、原文语言与生成的字典，以及给作者的 npm 指引。

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/create-aalis-plugin/src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');
/** 中日韩文字 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

type Webui = false | 'declarative' | 'frame';
type Features = { tool: boolean; command: boolean; webui: Webui; sessionSetting: boolean };
const answers = (features: Features, sourceLanguage: 'zh-CN' | 'en' = 'zh-CN') => ({
  packageName: 'aalis-plugin-demo',
  displayName: '演示',
  sourceLanguage,
  features,
});
const ALL = { tool: true, command: true, webui: 'declarative', sessionSetting: true } as const;
const NONE = { tool: false, command: false, webui: false, sessionSetting: false } as const;
const VERSIONS = {
  '@aalis/core': '0.19.1',
  '@aalis/api-tools': '0.9.0',
  '@aalis/api-commands': '0.8.0',
  '@aalis/api-webui': '0.12.0',
  '@aalis/api-session-settings': '0.1.0',
  '@aalis/api-host-config': '0.2.0',
  '@aalis/schema-config': '0.16.0',
  '@aalis/schema-i18n': '0.1.0',
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 生成到临时目录，回插件目录 */
async function generated(a: ReturnType<typeof answers>): Promise<string> {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'aalis-plugin-i18n-')));
  dirs.push(base);
  const dir = join(base, a.packageName);
  await generate(dir, a, VERSIONS);
  return dir;
}

/** 与 dep-ranges 守卫同一判据：下界是源上的版本，上界统一 <1.0.0 */
const RANGE = /^>=\d+\.\d+\.\d+ <1\.0\.0$/;

describe('生成的依赖', () => {
  it('@aalis 的依赖、开发依赖与 peer 都写 >=x.y.z <1.0.0，下界取源上查到的版本；没有 latest、workspace: 与 caret', () => {
    const pkg = JSON.parse(renderPackageJson(answers(ALL), VERSIONS));
    const aalis = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].flatMap(deps =>
      Object.entries(deps as Record<string, string>).filter(([name]) => name.startsWith('@aalis/')),
    );
    expect(aalis.length).toBe(9);
    for (const [name, range] of aalis) expect(range, name).toMatch(RANGE);
    expect(pkg.dependencies).toEqual({
      '@aalis/api-tools': '>=0.9.0 <1.0.0',
      '@aalis/api-commands': '>=0.8.0 <1.0.0',
      '@aalis/api-webui': '>=0.12.0 <1.0.0',
      '@aalis/api-session-settings': '>=0.1.0 <1.0.0',
      '@aalis/api-host-config': '>=0.2.0 <1.0.0',
      '@aalis/schema-config': '>=0.16.0 <1.0.0',
      '@aalis/schema-i18n': '>=0.1.0 <1.0.0',
    });
    expect(pkg.devDependencies['@aalis/core']).toBe('>=0.19.1 <1.0.0');
    // 显示名与页面标题是文字对象：core 0.21 起展示值才放宽为 unknown
    expect(pkg.peerDependencies['@aalis/core']).toBe('>=0.21.0 <1.0.0');
    expect(JSON.stringify(pkg)).not.toMatch(/latest|workspace:/);
  });

  it('什么能力都不选：依赖里照样有 schema-i18n（字典要它）；scripts 有构建后跑 node --test 的 test；tsconfig 按 NodeNext 解析', () => {
    const pkg = JSON.parse(renderPackageJson(answers(NONE), VERSIONS));
    expect(pkg.dependencies).toEqual({ '@aalis/schema-i18n': '>=0.1.0 <1.0.0' });
    expect(pkg.scripts).toEqual({ build: 'tsc', dev: 'tsc --watch', test: 'npm run build && node --test' });
    const { compilerOptions } = JSON.parse(renderTsconfig());
    expect([compilerOptions.module, compilerOptions.moduleResolution]).toEqual(['NodeNext', 'NodeNext']);
  });

  it('模板从 core 只取 definePlugin、logger、optional 与 config，调用写成两层形状', () => {
    for (let mask = 0; mask < 8; mask++) {
      for (const webui of [false, 'declarative', 'frame'] as const) {
        const source = renderIndexTs(
          answers({ tool: Boolean(mask & 1), command: Boolean(mask & 2), webui, sessionSetting: Boolean(mask & 4) }),
        );
        const imported = /import \{ ([^}]+) \} from '@aalis\/core';/.exec(source)?.[1].split(', ') ?? [];
        expect(
          imported.every(name => ['config', 'definePlugin', 'logger', 'optional'].includes(name)),
          imported.join(),
        ).toBe(true);
        expect(source).toContain('logger.use.');
      }
    }
  });
});

describe('生成的源码', () => {
  it('示例工具显式声明 risk，注释写明三档各管什么与可转后台的声明', () => {
    const source = renderIndexTs(answers({ tool: true, command: false, webui: false, sessionSetting: false }));
    expect(source).toContain("risk: 'safe',");
    for (const part of ["'sensitive'", "'dangerous'", 'background: {}', 'ctx.signal', 'ctx.output', '长任务与取消']) {
      expect(source).toContain(part);
    }
    expect(source).not.toContain("visibility: 'restricted'");
    expect(source).not.toMatch(/^\s+background:/m);
  });

  it('可按会话设的配置项：字段写在 configSchema 上、带 session，apply 里调一次 fields() 拿读取器；选了工具时工具按会话读它', () => {
    const withTool = renderIndexTs(answers({ tool: true, command: false, webui: false, sessionSetting: true }));
    expect(withTool).toContain("import { defineConfig } from '@aalis/schema-config';");
    expect(withTool).toContain('const configSchema = defineConfig({');
    expect(withTool).toContain("session: { prominence: 'advanced' },");
    expect(withTool).toContain('\n  configSchema,\n');
    expect(withTool).toContain('sessionFields: optional(sessionFields), document: optional(ownHostConfig)');
    expect(withTool).toContain('const fields = sessionFields.use.fields(configSchema, { config, document });');
    expect(withTool).toContain('fields.get(ctx.sessionId, { platform: ctx.platform })');
    expect(withTool).not.toMatch(/resolveConfig|api-session-manager|declare module/);
    const alone = renderIndexTs(answers({ tool: false, command: false, webui: false, sessionSetting: true }));
    expect(alone).toContain('\n    sessionFields.use.fields(configSchema, { config, document });');
    expect(alone).not.toContain('ctx.sessionId');
    const plain = renderIndexTs(answers({ tool: true, command: false, webui: false, sessionSetting: false }));
    expect(plain).not.toMatch(/configSchema|sessionFields|config, /);
    const pkg = JSON.parse(renderPackageJson(answers(ALL), VERSIONS));
    expect(pkg.aalis.service.required).toEqual(['logger', 'config']);
    expect(pkg.aalis.service.optional).toEqual([
      'tools',
      'commands',
      'webui-server',
      'session-settings',
      'host-config',
    ]);
  });

  it('显示名带撇号、花括号、井号与反斜杠：写进字典的模板按 ICU 规则转义，另一种语言照抄并标待翻译；源码转译无诊断，两种语言都渲染回原样', async () => {
    const displayName = "Demo's {beta} #1 \\ Tools";
    for (const [sourceLanguage, other, mark] of [
      ['zh-CN', 'en', '// 待翻译'],
      ['en', 'zh-CN', '// To translate'],
    ] as const) {
      const a = { ...answers({ ...ALL, webui: 'frame' }, sourceLanguage), packageName: `zz-icu-${other}`, displayName };
      const dir = await generated(a);
      const escaped = JSON.stringify("Demo''s '{'beta'}' '#'1 \\ Tools");
      const files = ['src/texts.ts', `src/locales/${other}.ts`, 'src/index.ts'];
      const sources = await Promise.all(files.map(file => readFile(join(dir, file), 'utf-8')));
      for (const [i, source] of sources.entries()) {
        const { diagnostics } = ts.transpileModule(source, { reportDiagnostics: true });
        expect(diagnostics?.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')) ?? [], files[i]).toEqual([]);
      }
      expect(sources[0]).toContain(`  displayName: ${escaped},\n`);
      expect(sources[1]).toContain(`  displayName: ${escaped}, ${mark}\n`);
      const { t } = (await import(join(dir, 'src/texts.ts'))) as { t: TextFactory<{ displayName: string }> };
      expect([resolveText(t('displayName'), ['zh-CN']), resolveText(t('displayName'), ['en'])]).toEqual([
        displayName,
        displayName,
      ]);
    }
  });

  it('显示名里特殊字符相邻（花括号、井号与撇号连着）：连着的一段整段括起，两种语言都渲染回原样', async () => {
    const displayName = "a{}b ## {'} ''{ c' {{x}}";
    const a = { ...answers({ ...ALL, webui: 'frame' }, 'zh-CN'), packageName: 'zz-icu-adjacent', displayName };
    const dir = await generated(a);
    const { t } = (await import(join(dir, 'src/texts.ts'))) as { t: TextFactory<{ displayName: string }> };
    expect([resolveText(t('displayName'), ['zh-CN']), resolveText(t('displayName'), ['en'])]).toEqual([
      displayName,
      displayName,
    ]);
  });

  it.each([
    ['zh-CN', 'en'],
    ['en', 'zh-CN'],
  ] as const)('原文 %s：字典以包名为 ns、按原文语言登记，另一种语言的译文在；给人看的写成 t()，给模型的保持字符串', async (sourceLanguage, other) => {
    const a = { ...answers({ ...ALL, webui: 'frame' }, sourceLanguage), packageName: `zz-source-${sourceLanguage}` };
    const dir = await generated(a);
    const { t } = (await import(join(dir, 'src/texts.ts'))) as { t: TextFactory<Record<string, string>> };
    expect([t.ns, t.language, Object.keys(t.locales)]).toEqual([a.packageName, sourceLanguage, [other]]);
    expect(existsSync(join(dir, `src/locales/${other}.ts`))).toBe(true);
    const index = await readFile(join(dir, 'src/index.ts'), 'utf-8');
    for (const part of [
      "displayName: t('displayName'),",
      "title: t('displayName'),",
      "commands.use.command('hello', t('commandDescription')).action(async () => t('commandReply'));",
      "label: t('greetingLabel'),",
      "label: t('removeLabel'),",
      "confirm: t('removeConfirm'),",
      "throw new TextError(t('noSuchItem', { item: input.item }));",
      "return t('removed', { item: input.item });",
    ]) {
      expect(index, part).toContain(part);
    }
    expect(index).toContain("import { t } from './texts.js';");
  });

  it('原文 en：生成的源码、README、package.json 描述与字典自检用例都是英文；工具说明与结果、日志、示例数据与配置默认值跟原文', async () => {
    const dir = await generated({ ...answers({ ...ALL, webui: 'frame' }, 'en'), displayName: 'Demo' });
    const files = [
      'src/index.ts',
      'src/texts.ts',
      'src/locales/zh-CN.ts',
      'README.md',
      'package.json',
      'test/texts.test.js',
    ];
    const texts = await Promise.all(files.map(file => readFile(join(dir, file), 'utf-8')));
    // 另一种语言的译文本该是中文，其余一律不含中日韩文字
    expect(files.filter((file, i) => file !== 'src/locales/zh-CN.ts' && CJK.test(texts[i]))).toEqual([]);
    const [index] = texts;
    for (const part of [
      "description: 'Sample tool: returns a greeting',",
      "logger.use.info('Plugin loaded');",
      "const items = ['Sample item one', 'Sample item two', 'Sample item three'];",
      "default: 'Hello',",
    ]) {
      expect(index, part).toContain(part);
    }
    expect(JSON.parse(texts[4]).description).toBe('Demo — an Aalis plugin');
  });

  it('原文 zh-CN：工具说明与结果、日志、示例数据与配置默认值是中文，注释写明给模型的不进字典', () => {
    const index = renderIndexTs({ ...answers({ ...ALL, webui: 'frame' }), displayName: '演示' });
    for (const part of [
      "description: '示例工具：返回问候语',",
      "logger.use.info('插件已加载');",
      "const items = ['示例条目一', '示例条目二', '示例条目三'];",
      "default: '你好',",
      '// 给模型的说明与结果写成字符串，不进字典',
    ]) {
      expect(index, part).toContain(part);
    }
    expect(JSON.parse(renderPackageJson(answers(ALL), VERSIONS)).description).toBe('演示 —— Aalis 插件');
  });

  it('README 用 npm 构建，写明装进实例的两种办法与装好后怎么加载；不提 pnpm', () => {
    const readme = renderReadme(answers(ALL));
    for (const part of [
      'npm install',
      'npm run build',
      'npm install --install-links',
      'install-links=true',
      'npm pack',
      '重新扫描',
    ]) {
      expect(readme).toContain(part);
    }
    expect(readme).not.toContain('pnpm');
  });

  it('README 的「多语言」一节写明字典与译文在哪、改了跑 npm test', () => {
    expect(renderReadme(answers(ALL))).toContain(
      [
        '## 多语言',
        '',
        '给人看的文字在 `src/texts.ts`，另一种语言的译文在 `src/locales/en.ts`。',
        '改了原文或加了键就跑 `npm test`（`checkTexts` 自检字典）。',
        '',
      ].join('\n'),
    );
    expect(renderReadme(answers(ALL, 'en'))).toContain(
      [
        '## Languages',
        '',
        'Text shown to people is in `src/texts.ts`; the translation into the other language is in `src/locales/zh-CN.ts`.',
        'After changing the source text or adding keys, run `npm test` (`checkTexts` checks the dictionary).',
        '',
      ].join('\n'),
    );
  });
});

/** 子进程的系统语言：LANG 定，清掉会盖过它的 LC_ALL 与 LC_MESSAGES */
const envOf = (lang: string) => ({ ...process.env, LANG: lang, LC_ALL: undefined, LC_MESSAGES: undefined });

describe('create-aalis-plugin 查依赖版本', () => {
  let dir: string;
  let registry: Server;
  afterEach(async () => {
    registry.closeAllConnections();
    await new Promise<void>(resolve => registry.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** 本地假源：missing 里的包回 404，pages 里的包回 200 加一张网页（代理或认证网关的登录页），其余回 0.9.0 */
  async function serve(missing: string[], pages: string[] = []): Promise<string> {
    registry = createServer((request, response) => {
      const name = decodeURIComponent(request.url ?? '')
        .replace(/^\//, '')
        .replace(/\/latest$/, '');
      if (pages.includes(name)) {
        response.setHeader('content-type', 'text/html');
        response.end('<!DOCTYPE html><html><body>请先登录</body></html>');
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (missing.includes(name)) {
        response.statusCode = 404;
        response.end('{"error":"not found"}');
      } else {
        response.end(JSON.stringify({ version: '0.9.0' }));
      }
    });
    await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    if (!address || typeof address === 'string') throw new Error('未监听 TCP');
    return `http://127.0.0.1:${address.port}`;
  }

  it('按 --registry 指定的源查，版本写进依赖；尾提示用 npm', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-versions-'));
    const url = await serve([]);
    const { stdout } = await run(process.execPath, ['--import', tsx, cli, '--registry', url, 'zz-demo', '--yes'], {
      cwd: dir,
      timeout: 10_000,
      env: envOf('zh_CN.UTF-8'),
    });
    const pkg = JSON.parse(await readFile(join(dir, 'zz-demo', 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual({ '@aalis/api-tools': '>=0.9.0 <1.0.0', '@aalis/schema-i18n': '>=0.9.0 <1.0.0' });
    expect(pkg.devDependencies['@aalis/core']).toBe('>=0.9.0 <1.0.0');
    expect(stdout).toContain('npm install');
    expect(stdout).toContain('npm run build');
    expect(stdout).toContain('重新扫描');
    expect(stdout).not.toContain('pnpm');
  });

  it('查不到版本：退出码 1，写明是哪个包、检查网络或用 --registry 指定源，不生成目录', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-versions-'));
    const url = await serve(['@aalis/api-tools']);
    const failure = await run(process.execPath, ['--import', tsx, cli, 'zz-demo', '--yes', '--registry', url], {
      cwd: dir,
      timeout: 10_000,
      env: envOf('zh_CN.UTF-8'),
    }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain('@aalis/api-tools');
    expect(failure?.stderr).toContain('--registry');
    expect(existsSync(join(dir, 'zz-demo'))).toBe(false);
  });

  it('源回 200 却读不出 JSON（代理或认证网关的网页）：退出码 1，写明是哪个包、哪个地址，不生成目录', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-versions-'));
    const url = await serve([], ['@aalis/core']);
    const failure = await run(process.execPath, ['--import', tsx, cli, 'zz-demo', '--yes', '--registry', url], {
      cwd: dir,
      timeout: 10_000,
      env: envOf('zh_CN.UTF-8'),
    }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain(`查不到 @aalis/core 的最新版本：${url}/@aalis/core/latest 的回应读不出 JSON`);
    expect(existsSync(join(dir, 'zz-demo'))).toBe(false);
  });

  it('目标目录已存在：退出码 1，写明怎么办，不动那个目录', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-versions-'));
    const url = await serve([]);
    await mkdir(join(dir, 'zz-demo'));
    await writeFile(join(dir, 'zz-demo', 'keep.txt'), 'mine');
    const failure = await run(process.execPath, ['--import', tsx, cli, 'zz-demo', '--yes', '--registry', url], {
      cwd: dir,
      timeout: 10_000,
      env: envOf('zh_CN.UTF-8'),
    }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    // 子进程的 cwd 是解析过符号链接的路径（macOS 的临时目录在 /private 下），只核结尾
    expect(failure?.stderr?.trim()).toMatch(/^目录已存在: \/.*\/zz-demo：换一个插件名，或先移走这个目录$/);
    expect(await readdir(join(dir, 'zz-demo'))).toEqual(['keep.txt']);
  });
});

describe('create-aalis-plugin 的显示语言', () => {
  let dir: string;
  const dirs: string[] = [];
  const registries: Server[] = [];
  afterEach(async () => {
    for (const registry of registries.splice(0)) {
      registry.closeAllConnections();
      await new Promise<void>(resolve => registry.close(() => resolve()));
    }
    for (const made of dirs.splice(0)) await rm(made, { recursive: true, force: true });
  });

  /** 跑真 CLI（替身源，版本一律 0.9.0），stdin 是管道（不是终端）；一例里可以跑多次，用完都收 */
  async function create(lang: string, args: string[]) {
    dir = await mkdtemp(join(tmpdir(), 'aalis-plugin-lang-'));
    dirs.push(dir);
    const registry = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: '0.9.0' }));
    });
    registries.push(registry);
    await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    if (!address || typeof address === 'string') throw new Error('未监听 TCP');
    const url = `http://127.0.0.1:${address.port}`;
    return run(process.execPath, ['--import', tsx, cli, ...args, '--registry', url], {
      cwd: dir,
      timeout: 10_000,
      env: envOf(lang),
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );
  }

  it.each([
    ['en_US.UTF-8', [], 'Next steps:', 'en'],
    ['zh_CN.UTF-8', [], '下一步：', 'zh-CN'],
    ['zh_CN.UTF-8', ['--lang', 'en'], 'Next steps:', 'en'],
  ])('LANG=%s、参数 %j：尾提示是 %j，原文语言取显示语言（%s）', async (lang, extra, next, sourceLanguage) => {
    const result = await create(lang, ['zz-demo', '--yes', ...extra]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(next);
    const texts = await readFile(join(dir, 'zz-demo', 'src/texts.ts'), 'utf-8');
    expect(texts).toContain(`language: '${sourceLanguage}'`);
  });

  it('中文系统下 --lang en：非交互生成与非终端报错两条路径的输出都不含中日韩文字', async () => {
    const yes = await create('zh_CN.UTF-8', ['zz-demo', '--yes', '--lang', 'en']);
    expect(yes.code).toBe(0);
    expect(`${yes.stdout}${yes.stderr}`).not.toMatch(CJK);
    const piped = await create('zh_CN.UTF-8', ['zz-demo', '--lang', 'en']);
    expect(piped.code).toBe(1);
    expect(piped.stderr).toContain('--yes');
    expect(`${piped.stdout}${piped.stderr}`).not.toMatch(CJK);
  });

  it('--lang 只收 zh-CN 与 en：别的值退出码 1，写明只收这两种', async () => {
    const result = await create('en_US.UTF-8', ['zz-demo', '--yes', '--lang', 'ja']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--lang only accepts zh-CN or en (the source language of the plugin), not “ja”');
    expect(existsSync(join(dir, 'zz-demo'))).toBe(false);
  });
});
