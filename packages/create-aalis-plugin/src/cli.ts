#!/usr/bin/env node
/**
 * Aalis 插件交互式脚手架。
 *
 * 用法：
 *   create-aalis-plugin                 → 交互式 prompts
 *   create-aalis-plugin <name>          → 仅指定名称，其余 prompts
 *   create-aalis-plugin <name> --yes    → 全默认值（tool 模板，无 webui）
 *   --registry <源地址>                  → 查依赖最新版本用的 npm 源（默认官方源）
 *   --lang zh-CN|en                     → 插件的原文语言，也是终端的显示语言（缺省按系统语言）
 *
 * 输出：在 cwd 下创建 `<name>/` 目录，含完整 package.json / tsconfig.json / src/index.ts、给人看的文字的字典
 * （src/texts.ts 与另一种语言的 src/locales/）与字典自检用例。依赖的 @aalis 包按源上的最新版写下界。生成完毕后打印下一步命令。
 * 终端里的文字取自本包的字典（中文、英文）。
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  isTextRef,
  normalizeLanguages,
  pickLanguage,
  resolveText,
  TextError,
  type TextRef,
  textLines,
  textOf,
} from '@aalis/schema-i18n';
import { t } from './texts.js';

/** 本包字典有的语言，也是生成的插件可选的原文语言 */
const LANGUAGES = ['zh-CN', 'en'] as const;
type Language = (typeof LANGUAGES)[number];

interface Answers {
  /** 包名，如 my-plugin 或 @scope/my-plugin */
  packageName: string;
  /** 显示名 */
  displayName: string;
  /** 原文语言：生成的字典、源码注释、README 与示例按它写，另一种语言生成译文 */
  sourceLanguage: Language;
  /** 包含哪些扩展点 */
  features: {
    tool: boolean;
    command: boolean;
    /** WebUI 页面：不要、声明式，或自带前端（插件前端） */
    webui: false | 'declarative' | 'frame';
    /** 声明一个可按会话设的配置项 */
    sessionSetting: boolean;
  };
}

/** 依赖的 @aalis 包 → 生成时向源查到的最新版本 */
type Versions = Record<string, string>;

// ── 输入校验（纯函数，便于单测）─────────────────────────────────
// 注：validateNpmName、parseYesNo 与参数解析和 create-aalis 中实现刻意一致——两个脚手架各自独立发布，
// 为不互相依赖而各留一份；改规则时需同步。

export type ValidationResult = { ok: true } | { ok: false; error: TextRef };

/** 校验合法 npm 包名（生成插件 package.json 的 name；旧实现只查非空，会生成无法发布的名字）。 */
export function validateNpmName(name: string): ValidationResult {
  if (!name) return { ok: false, error: t('nameEmpty') };
  if (name.length > 214) return { ok: false, error: t('nameTooLong') };
  if (/\s/.test(name)) return { ok: false, error: t('nameSpace') };
  if (name !== name.toLowerCase()) return { ok: false, error: t('nameUppercase') };
  let pkg = name;
  if (name.startsWith('@')) {
    const m = name.match(/^@([^/]+)\/(.+)$/);
    if (!m) return { ok: false, error: t('scopeFormat') };
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(m[1])) return { ok: false, error: t('scopeInvalid', { scope: m[1] }) };
    pkg = m[2];
  }
  if (/^[._]/.test(pkg)) return { ok: false, error: t('nameLeadingDot') };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pkg)) return { ok: false, error: t('nameChars') };
  return { ok: true };
}

/** 解析 yes/no 输入：空=默认；y/yes/true/1=真；n/no/false/0=假；其余=null（调用方重问）。 */
export function parseYesNo(ans: string, def: boolean): boolean | null {
  const a = ans.trim().toLowerCase();
  if (a === '') return def;
  if (['y', 'yes', 'true', '1'].includes(a)) return true;
  if (['n', 'no', 'false', '0'].includes(a)) return false;
  return null;
}

/** 带取值的 flag：紧随其后的一个 token 是它的值，不当包名 */
const VALUE_FLAGS = new Set(['--registry', '--lang']);

export function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) out.push(args[i]);
    else if (VALUE_FLAGS.has(args[i])) i++;
  }
  return out;
}

/** `--registry <值>` 与 `--registry=<值>` 两种写法 */
function argValue(args: string[], flag: string): string | undefined {
  const eq = args.find(a => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 本包字典有的语言里的一种；别的值为 undefined */
const languageOf = (value: string): Language | undefined => LANGUAGES.find(language => language === value);

/** 系统语言（Node 的 Intl 默认 locale，跟 LANG）在本包字典里选一种，选不出为英文：没给 --lang 时的显示语言与缺省的原文语言 */
function systemLanguage(): Language {
  const at = pickLanguage(normalizeLanguages([Intl.DateTimeFormat().resolvedOptions().locale]), LANGUAGES);
  return at === undefined ? 'en' : LANGUAGES[at];
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 向源查一个包的最新版本；查不到时抛 TextError，写明是哪个包、为什么 */
async function latestVersion(registry: string, pkg: string): Promise<string> {
  const url = `${registry.replace(/\/+$/, '')}/${pkg}/latest`;
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new TextError(t('versionUnreachable', { pkg, url, error: (err as Error).message }));
  }
  if (!r.ok) throw new TextError(t('versionStatus', { pkg, url, status: r.status }));
  let body: unknown;
  try {
    body = await r.json();
  } catch (err) {
    throw new TextError(t('versionNotJson', { pkg, url, error: (err as Error).message }));
  }
  const version = (body as { version?: unknown } | null)?.version;
  if (typeof version !== 'string') throw new TextError(t('versionMissing', { pkg, url }));
  return version;
}

function fail(message: string): never {
  console.error(message);
  exit(1);
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  const skipPrompts = args.includes('--yes') || args.includes('-y');
  const registry = argValue(args, '--registry') ?? DEFAULT_REGISTRY;
  const langFlag = argValue(args, '--lang');
  const lang = langFlag === undefined ? undefined : languageOf(langFlag);
  // 显示语言：--lang 给的原文语言，没给时按系统语言；不合法的 --lang 按系统语言报错
  const display = lang ?? systemLanguage();
  const show = (text: string | TextRef) => (typeof text === 'string' ? text : resolveText(text, [display]));
  if (langFlag !== undefined && lang === undefined) fail(show(t('badLanguage', { value: langFlag })));
  const cliName = positionalArgs(args)[0];

  // 非交互终端下进交互会在 readline 遇 EOF 时静默空退；提前拦截并给指引（与 create-aalis 一致）。
  if (!skipPrompts && !stdin.isTTY) fail(show(textLines(['', t('nonTty'), t('nonTtyYes'), ''])));

  const rl = createInterface({ input: stdin, output: stdout });
  const warn = (error: TextRef) => console.log(show(t('warning', { error })));
  const ask = async (q: TextRef, def: string): Promise<string> => {
    if (skipPrompts) return def;
    return (await rl.question(`${show(q)} (${def}): `)).trim() || def;
  };
  // 校验式提问：parse 回取值或说明坏在哪的文字对象，坏输入打印说明并重问（仅交互模式）。
  const askValid = async <T extends string>(q: TextRef, def: T, parse: (v: string) => T | TextRef): Promise<T> => {
    while (true) {
      const r = parse(await ask(q, def));
      if (!isTextRef(r)) return r;
      warn(r);
    }
  };
  const askYesNo = async (q: TextRef, def = true): Promise<boolean> => {
    if (skipPrompts) return def;
    while (true) {
      const ans = await rl.question(`${show(q)} (${def ? 'Y/n' : 'y/N'}): `);
      const r = parseYesNo(ans, def);
      if (r !== null) return r;
      warn(t('yesOrNo'));
    }
  };

  try {
    let packageName: string;
    if (cliName !== undefined) {
      const r = validateNpmName(cliName);
      if (!r.ok) fail(show(t('badPackageName', { name: cliName, error: r.error })));
      packageName = cliName;
    } else {
      packageName = await askValid(t('packageNamePrompt'), 'aalis-plugin-sample', name => {
        const r = validateNpmName(name);
        return r.ok ? name : r.error;
      });
    }
    const sourceLanguage =
      lang ??
      (await askValid(t('sourceLanguagePrompt'), display, value => languageOf(value) ?? t('badSourceLanguage')));
    const displayName = await ask(t('displayNamePrompt'), defaultDisplayName(packageName));
    const tool = await askYesNo(t('toolPrompt'), true);
    const command = await askYesNo(t('commandPrompt'), false);
    const page = await askYesNo(t('pagePrompt'), false);
    const frame = page && (await askYesNo(t('framePrompt'), false));
    const sessionSetting = await askYesNo(t('sessionSettingPrompt'), false);
    const features: Answers['features'] = {
      tool,
      command,
      webui: page && (frame ? 'frame' : 'declarative'),
      sessionSetting,
    };

    const answers: Answers = { packageName, displayName, sourceLanguage, features };
    const dir = shortName(packageName);
    const targetDir = resolve(process.cwd(), dir);

    if (existsSync(targetDir)) fail(show(t('dirExists', { dir: targetDir })));

    let versions: Versions;
    try {
      const packages = dependencyPackages(features);
      versions = Object.fromEntries(
        await Promise.all(packages.map(async pkg => [pkg, await latestVersion(registry, pkg)])),
      );
    } catch (err) {
      fail(`${show(textOf(err))}\n${show(t('registryHint'))}`);
    }

    await generate(targetDir, answers, versions);

    console.log(`\n${show(t('generated', { dir: targetDir }))}\n`);
    console.log(show(t('nextSteps')));
    console.log(`  cd ${dir}`);
    console.log('  npm install');
    console.log('  npm run build');
    console.log(`\n${show(t('installLinks'))}`);
    for (const line of [t('installNpmrc'), t('installPack'), t('installSecondCore'), t('installLoad')]) {
      console.log(show(line));
    }
  } finally {
    rl.close();
  }
}

function defaultDisplayName(pkg: string): string {
  return shortName(pkg)
    .replace(/^plugin-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function shortName(pkg: string): string {
  const slash = pkg.lastIndexOf('/');
  return slash >= 0 ? pkg.slice(slash + 1) : pkg;
}

/** 页面的 key：包名最后一段去掉 plugin- 前缀 */
function pageKeyOf(pkg: string): string {
  return shortName(pkg).replace(/^plugin-/, '');
}

/** 另一种语言：生成它的译文 */
const otherOf = (language: Language): Language => (language === 'zh-CN' ? 'en' : 'zh-CN');

export async function generate(dir: string, a: Answers, versions: Versions): Promise<void> {
  const other = otherOf(a.sourceLanguage);
  await mkdir(resolve(dir, 'src/locales'), { recursive: true });
  await mkdir(resolve(dir, 'test'));

  await writeFile(resolve(dir, 'package.json'), renderPackageJson(a, versions));
  await writeFile(resolve(dir, 'tsconfig.json'), renderTsconfig());
  await writeFile(resolve(dir, 'src/index.ts'), renderIndexTs(a));
  await writeFile(resolve(dir, 'src/texts.ts'), renderTexts(a));
  await writeFile(resolve(dir, `src/locales/${other}.ts`), renderLocale(a));
  await writeFile(resolve(dir, 'test/texts.test.js'), renderTextsTest(a));
  await writeFile(resolve(dir, 'README.md'), renderReadme(a));
  if (a.features.webui === 'frame') {
    await mkdir(resolve(dir, 'webui'));
    await writeFile(resolve(dir, 'webui/index.html'), renderFrameHtml(a));
    await writeFile(resolve(dir, 'webui/main.js'), FRAME_SCRIPT);
  }
}

/** 要向源查版本的 @aalis 包：开发依赖 core，加上运行时依赖 */
function dependencyPackages(features: Answers['features']): string[] {
  return ['@aalis/core', ...runtimePackages(features)];
}

/** 运行时依赖：所选能力的契约包；声明了可按会话设的配置项时另有定义 schema 的 schema-config；字典要 schema-i18n */
function runtimePackages(features: Answers['features']): string[] {
  return [
    ...selectedCapabilityUses(features).map(c => c.pkg),
    ...(features.sessionSetting ? ['@aalis/schema-config'] : []),
    '@aalis/schema-i18n',
  ];
}

/** 写进依赖的范围：下界是生成时源上的最新版，上界统一到 1.0 之前——0.x 下 caret 跨次版本即断 */
const rangeOf = (version: string) => `>=${version} <1.0.0`;

export function renderPackageJson(a: Answers, versions: Versions): string {
  // 运行时依赖：服务描述符是值导入，用到的 api 包进 dependencies；@aalis/core 是宿主必有的核心，走 peerDependencies + devDep。
  // core peerDep 的下限：显示名与页面标题写成文字对象（t()），core 0.21 起插件定义的展示值才放宽为 unknown，0.20 的 displayName
  // 只收字符串；上限放到 1.0 之前，插件不必随 core 次版本升级而重发。注意 1.0 之前 core 的公开面可能在次版本被删——用了某版本
  // 才有的 API，就把下限抬到那个版本。稳定性承诺自 1.0 起生效。
  const caps = selectedCapabilityUses(a.features);
  const deps = Object.fromEntries(runtimePackages(a.features).map(pkg => [pkg, rangeOf(versions[pkg])]));

  // aalis.service：声明运行时服务依赖/提供，供市场装前披露，须与 definePlugin 的 uses / provides 一致。
  const json: Record<string, unknown> = {
    name: a.packageName,
    version: '0.1.0',
    type: 'module',
    // description / author 供插件市场展示（市场直接读 package.json，不进插件定义）
    description: COPY[a.sourceLanguage].description(a.displayName),
    // keyword 'aalis-plugin' 是加载硬门（加载器只认它，漏写即永不加载），市场检索也按它
    keywords: ['aalis-plugin'],
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    // 发布包只含编译产物，以及插件前端的静态网页
    files: ['dist', ...(a.features.webui === 'frame' ? ['webui'] : [])],
    scripts: {
      build: 'tsc',
      dev: 'tsc --watch',
      // 字典自检（test/texts.test.js）读构建产物
      test: 'npm run build && node --test',
    },
    dependencies: deps,
    peerDependencies: {
      '@aalis/core': '>=0.21.0 <1.0.0',
    },
    devDependencies: {
      '@aalis/core': rangeOf(versions['@aalis/core']),
      typescript: '^5.7.0',
      '@types/node': '^22.0.0',
    },
    // 市场据此做安装前能力披露，须与 definePlugin 的 uses / provides 保持一致：
    // { service: { required: ['llm'], optional: ['memory'], provides: ['my-service'] } }
    aalis: {
      service: { required: coreUses(a.features), ...(caps.length ? { optional: caps.map(c => c.service) } : {}) },
    },
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

export function renderTsconfig(): string {
  // 自包含：不 extends monorepo 的 tsconfig.base.json，独立目录下也能 `tsc` 通过。按 Node 的解析规则（NodeNext）：
  // 源码分了几个文件，相对导入要写 .js 扩展名，产物才能在 Node 里原样加载
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: true,
        resolveJsonModule: true,
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`;
}

/** 用户勾选的能力：uses 键、描述符、契约包与服务名。package.json、README 与 index 共用，避免一边列了未勾选的能力 */
interface CapabilityUse {
  usesKey: string;
  /** 契约包导出的描述符 */
  descriptor: string;
  pkg: string;
  service: string;
  /** README 里这一项的说法：对应 COPY 里 capabilities 的键 */
  what: keyof Copy['capabilities'];
}

function selectedCapabilityUses(features: Answers['features']): CapabilityUse[] {
  const out: CapabilityUse[] = [];
  if (features.tool) {
    out.push({ usesKey: 'tools', descriptor: 'tools', pkg: '@aalis/api-tools', service: 'tools', what: 'tool' });
  }
  if (features.command) {
    out.push({
      usesKey: 'commands',
      descriptor: 'commands',
      pkg: '@aalis/api-commands',
      service: 'commands',
      what: 'command',
    });
  }
  if (features.webui) {
    out.push({
      usesKey: 'webui',
      descriptor: 'webuiServer',
      pkg: '@aalis/api-webui',
      service: 'webui-server',
      what: features.webui === 'frame' ? 'frame' : 'page',
    });
  }
  if (features.sessionSetting) {
    out.push(
      {
        usesKey: 'sessionFields',
        descriptor: 'sessionFields',
        pkg: '@aalis/api-session-settings',
        service: 'session-settings',
        what: 'sessionFields',
      },
      {
        usesKey: 'document',
        descriptor: 'ownHostConfig',
        pkg: '@aalis/api-host-config',
        service: 'host-config',
        what: 'document',
      },
    );
  }
  return out;
}

/** 用到的 core 内置能力：logger 总有；声明了可按会话设的配置项时另有 config（没有宿主配置文档时它的全局层取这里） */
function coreUses(features: Answers['features']): string[] {
  return features.sessionSetting ? ['logger', 'config'] : ['logger'];
}

function usesObjectLiteral(features: Answers['features']): string {
  const caps = selectedCapabilityUses(features);
  const parts = [...coreUses(features), ...caps.map(c => `${c.usesKey}: optional(${c.descriptor})`)];
  return `{ ${parts.join(', ')} }`;
}

// ── 生成插件的字典 ──────────────────────────────────────────────

/** 写进生成插件字典的句子（ICU 消息格式），原文与译文各一份，直接写进生成的 texts.ts 与 locales；显示名另由作者填 */
const TEMPLATE_TEXTS = {
  'zh-CN': {
    commandDescription: '示例命令',
    commandReply: '你好',
    infoLabel: '示例信息',
    tipLabel: '提示',
    tipValue: '这是 {name} 插件的示例信息面板。',
    removeLabel: '删除',
    removeConfirm: '从列表里删掉这一条？',
    itemLabel: '条目',
    noSuchItem: '没有这一条：{item}',
    removed: '已删除 {item}',
    loading: '正在加载…',
    emptyList: '列表空了',
    greetingLabel: '问候语',
    greetingDescription: '示例配置项：按会话设一个问候语',
  },
  en: {
    commandDescription: 'Sample command',
    commandReply: 'Hello',
    infoLabel: 'Sample info',
    tipLabel: 'Tip',
    tipValue: 'This is the sample info panel of the {name} plugin.',
    removeLabel: 'Remove',
    removeConfirm: 'Remove this one from the list?',
    itemLabel: 'Item',
    noSuchItem: 'No such item: {item}',
    removed: 'Removed {item}',
    loading: 'Loading…',
    emptyList: 'The list is empty',
    greetingLabel: 'Greeting',
    greetingDescription: 'Sample setting: a greeting that can be set per session',
  },
} as const;
type TemplateKey = keyof (typeof TEMPLATE_TEXTS)['en'];

/** 这次生成用到的字典键（显示名之外）：只放所选能力用到的 */
function templateKeys(features: Answers['features']): TemplateKey[] {
  return [
    ...(features.command ? (['commandDescription', 'commandReply'] as const) : []),
    ...(features.webui === 'declarative' ? (['infoLabel', 'tipLabel', 'tipValue'] as const) : []),
    ...(features.webui === 'frame'
      ? (['removeLabel', 'removeConfirm', 'itemLabel', 'noSuchItem', 'removed', 'loading', 'emptyList'] as const)
      : []),
    ...(features.sessionSetting ? (['greetingLabel', 'greetingDescription'] as const) : []),
  ];
}

/**
 * 用户填的文字写进字典模板（ICU 的引号规则）：花括号、井号与撇号连着的一段，含花括号或井号的整段用撇号括起，段内撇号写成两个；
 * 只有撇号的段把撇号写成两个。逐个括起时相邻两段的引号会连成一个字面撇号
 */
const escapeMessage = (text: string) =>
  text.replace(/[{}#']+/g, run => (/[{}#]/.test(run) ? `'${run.replaceAll("'", "''")}'` : run.replaceAll("'", "''")));

/** 字典的条目行：值写成字符串字面量，note 是行尾注释 */
const entryLine = (key: string, value: string, note = '') => `  ${key}: ${JSON.stringify(value)},${note}`;

/** src/texts.ts：原文字典，ns 是包名 */
function renderTexts(a: Answers): string {
  const other = otherOf(a.sourceLanguage);
  const local = other === 'en' ? 'en' : 'zhCN';
  const lines = [
    entryLine('displayName', escapeMessage(a.displayName)),
    ...templateKeys(a.features).map(key => entryLine(key, TEMPLATE_TEXTS[a.sourceLanguage][key])),
  ];
  return `${COPY[a.sourceLanguage].textsHeader}
import { defineTexts } from '@aalis/schema-i18n';
import ${local} from './locales/${other}.js';

const SOURCE = {
${lines.join('\n')}
} as const;

export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '${a.packageName}',
  language: '${a.sourceLanguage}',
  source: SOURCE,
  locales: { ${other === 'en' ? 'en' : `'zh-CN': zhCN`} },
});
`;
}

/** 另一种语言的译文：模板自带的句子写好译文，用户填的显示名照抄、标待翻译 */
function renderLocale(a: Answers): string {
  const other = otherOf(a.sourceLanguage);
  const lines = [
    entryLine('displayName', escapeMessage(a.displayName), ` ${COPY[a.sourceLanguage].toTranslate}`),
    ...templateKeys(a.features).map(key => entryLine(key, TEMPLATE_TEXTS[other][key])),
  ];
  return `import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
${lines.join('\n')}
});
`;
}

/** test/texts.test.js：字典自检，读构建产物，不另装测试框架 */
function renderTextsTest(a: Answers): string {
  const copy = COPY[a.sourceLanguage];
  return `${copy.textsTestHeader}
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTexts } from '@aalis/schema-i18n';
import { t } from '../dist/texts.js';

test('${copy.textsTestName}', () => {
  assert.deepEqual(checkTexts(t), []);
});
`;
}

// ── 生成插件的源码 ──────────────────────────────────────────────

/** 写进生成源码的单引号字符串字面量 */
const quote = (text: string) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

export function renderIndexTs(a: Answers): string {
  // 没有默认注入：apply 只收到 uses 里声明的各项
  const copy = COPY[a.sourceLanguage];
  const caps = selectedCapabilityUses(a.features);
  const core = coreUses(a.features);
  const coreImports = ['definePlugin', ...core];
  if (caps.length > 0) coreImports.push('optional');
  const imports: string[] = [
    ...caps.map(c => `import { ${c.descriptor} } from '${c.pkg}';`),
    `import { ${coreImports.sort().join(', ')} } from '@aalis/core';`,
    ...(a.features.sessionSetting ? ["import { defineConfig } from '@aalis/schema-config';"] : []),
    ...(a.features.webui === 'frame' ? ["import { TextError } from '@aalis/schema-i18n';"] : []),
    "import { t } from './texts.js';",
  ];
  const schema = a.features.sessionSetting
    ? `
${copy.configSchema}
const configSchema = defineConfig({
  greeting: {
    type: 'string',
    label: t('greetingLabel'),
    description: t('greetingDescription'),
    default: ${quote(copy.greeting)},
${copy.prominence}
    session: { prominence: 'advanced' },
  },
});
`
    : '';

  const params = [...core, ...caps.map(c => c.usesKey)];
  const body: string[] = [];
  if (a.features.sessionSetting) {
    body.push(
      a.features.tool
        ? `${copy.fieldsWithTool}
    const fields = sessionFields.use.fields(configSchema, { config, document });`
        : `${copy.fieldsAlone}
    sessionFields.use.fields(configSchema, { config, document });`,
    );
  }
  if (a.features.tool) {
    const handler = a.features.sessionSetting
      ? `      async handler(args, ctx) {
${copy.effectiveValue}
        const { greeting } = fields.get(ctx.sessionId, { platform: ctx.platform });
        return \`\${greeting}, \${(args as { name: string }).name}!\`;
      },`
      : `      async handler(args) {
        return \`${copy.greeting}, \${(args as { name: string }).name}!\`;
      },`;
    body.push(`${copy.registerTool}
    tools.use.register({
${copy.risk}
      risk: 'safe',
${copy.background}
      definition: {
        type: 'function',
        function: {
          name: 'hello',
${copy.forModel}
          description: ${quote(copy.toolDescription)},
          parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
${copy.handlerResult}
${handler}
    });`);
  }
  if (a.features.command) {
    body.push(`${copy.registerCommand}
    commands.use.command('hello', t('commandDescription')).action(async () => t('commandReply'));`);
  }
  const pageKey = pageKeyOf(a.packageName);
  if (a.features.webui === 'declarative') {
    body.push(`${copy.registerPage}
    webui.use.definePage({
      key: '${pageKey}',
      title: t('displayName'),
      content: [
        {
          type: 'info',
          id: 'info',
          label: t('infoLabel'),
          data: () => [{ label: t('tipLabel'), value: t('tipValue', { name: t('displayName') }) }],
        },
      ],
    });`);
  }
  if (a.features.webui === 'frame') {
    body.push(`${copy.registerFrame}
    const items = [${copy.items.map(quote).join(', ')}];
    const page = webui.use.definePage({
      key: '${pageKey}',
      title: t('displayName'),
${copy.frameModule}
      frame: { module: import.meta.url },
      sources: {
        items: { data: () => items },
      },
      actions: {
${copy.destructive}
        remove: {
          label: t('removeLabel'),
          effect: 'destructive',
          confirm: t('removeConfirm'),
          input: { item: { type: 'string', label: t('itemLabel'), required: true } },
          handler: ({ input }) => {
            const at = items.indexOf(input.item);
            if (at < 0) throw new TextError(t('noSuchItem', { item: input.item }));
            items.splice(at, 1);
${copy.invalidate}
            page.invalidate('items');
            return t('removed', { item: input.item });
          },
        },
      },
    });`);
  }

  return `${imports.join('\n')}
${schema}
${copy.defaultExport}
export default definePlugin({
  name: '${a.packageName}',
  displayName: t('displayName'),
${a.features.sessionSetting ? '  configSchema,\n' : ''}${copy.uses}
  uses: ${usesObjectLiteral(a.features)},
  apply({ ${params.join(', ')} }) {
    logger.use.info(${quote(copy.loaded)});
${body.length ? `\n${body.join('\n\n')}\n` : ''}  },
});
`;
}

export function renderReadme(a: Answers): string {
  const copy = COPY[a.sourceLanguage];
  const caps = selectedCapabilityUses(a.features);
  const bullets = caps
    .map(c => copy.bullet(copy.capabilities[c.what], `uses: { ${c.usesKey}: optional(${c.descriptor}) }`, c.pkg))
    .join('\n');
  return copy.readme({
    a,
    usesLine: `uses: ${usesObjectLiteral(a.features)}`,
    bullets,
    other: otherOf(a.sourceLanguage),
  });
}

/** 插件前端的入口：显示名按 HTML 文本写进标题；不写死语言（助手按字典选中的语言设 lang），文字由脚本经 frame.t 写入 */
function renderFrameHtml(a: Answers): string {
  const title = a.displayName
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/frames/_base/frame.css" />
    <script type="module" src="main.js"></script>
  </head>
  <body>
    <p id="status"></p>
    <ul id="items"></ul>
  </body>
</html>
`;
}

/**
 * 插件前端的脚本：取数据源 items 列出条目，每条一个删除按钮调动作 remove；插件通知数据变了就重取。给人看的文字经 frame.t 取自
 * 插件的字典（键与服务端同一份 src/texts.ts），两种原文语言共用这一份，注释用英文
 */
const FRAME_SCRIPT = `// The host shows this page in an isolated frame: data sources and actions go through the helper, and links are opened by
// the host through frame.open. Items are inserted as text (textContent), never as HTML. Text shown to people comes from the
// plugin's dictionary (src/texts.ts) through frame.t, in the language of the host interface
import { connect } from '/frames/_base/frame.js';

const frame = await connect();
const list = document.querySelector('#items');
const status = document.querySelector('#status');
status.textContent = frame.t('loading');

function show(error) {
  // Cancelling in the host's confirmation dialog is not an error
  if (error.code !== 'cancelled') status.textContent = error.message;
}

async function render() {
  const items = await frame.data('items');
  list.replaceChildren(
    ...items.map(item => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = item;
      const remove = document.createElement('button');
      remove.textContent = frame.t('removeLabel');
      remove.addEventListener('click', () => frame.action('remove', { item }).catch(show));
      row.append(name, ' ', remove);
      return row;
    }),
  );
  status.textContent = items.length === 0 ? frame.t('emptyList') : '';
}

// Fetch again when the plugin's data changed or after the host reconnects
frame.onInvalidate(() => render().catch(show));
render().catch(show);
`;

// ── 生成的文件里按原文语言写的文字 ──────────────────────────────────

/**
 * 生成的文件里按原文语言写的说明、注释、给模型的工具说明与结果、日志、示例数据与配置默认值（普通字符串，不经字典：生成的
 * 文件没有读者语言一说）。注释里的多行已带好缩进
 */
interface Copy {
  /** package.json 的 description */
  description(displayName: string): string;
  /** src/texts.ts 开头的注释 */
  textsHeader: string;
  /** 另一种语言的译文里照抄的显示名后面的注释 */
  toTranslate: string;
  /** test/texts.test.js 开头的注释与用例名 */
  textsTestHeader: string;
  textsTestName: string;
  configSchema: string;
  prominence: string;
  /** 配置项问候语的默认值，也是工具不按会话读配置时的问候语 */
  greeting: string;
  fieldsWithTool: string;
  fieldsAlone: string;
  effectiveValue: string;
  registerTool: string;
  risk: string;
  background: string;
  forModel: string;
  toolDescription: string;
  handlerResult: string;
  registerCommand: string;
  registerPage: string;
  registerFrame: string;
  /** 插件前端的示例条目 */
  items: readonly string[];
  frameModule: string;
  destructive: string;
  invalidate: string;
  defaultExport: string;
  uses: string;
  /** 插件激活时的日志 */
  loaded: string;
  /** README 里各项能力的说法 */
  capabilities: Record<'tool' | 'command' | 'page' | 'frame' | 'sessionFields' | 'document', string>;
  bullet(what: string, uses: string, pkg: string): string;
  readme(o: { a: Answers; usesLine: string; bullets: string; other: Language }): string;
}

const COPY: Record<Language, Copy> = {
  'zh-CN': {
    description: displayName => `${displayName} —— Aalis 插件`,
    textsHeader: `// 给人看的文字的原文字典：显示名与页面、指令、设置项的文字取自这里，按读者的语言显示；另一种语言的译文在 locales/。
// 给模型的（工具说明与结果）不进字典`,
    toTranslate: '// 待翻译',
    textsTestHeader: `// 字典自检：原文与译文都解析得了、参数对得上、各语言不缺键。改了原文或加了键就跑 npm test（先构建，再跑这里）`,
    textsTestName: '字典没有问题',
    configSchema: `// 配置项。写了 session 的字段可按会话设：各会话、群、平台档等可以各自设，没设时取插件配置里的值；宿主不把这类字段交给
// config，apply 里经会话设置的读取器读`,
    prominence: `    // prominence 是显眼程度：composer 放在输入框旁，common 排在设置前面，advanced 收进「高级」。不写 appliesTo 即适用全部会话
    // 种类；只适用一部分时才写，如 appliesTo: ['room']（owner 是 WebUI 与终端里 owner 的会话，room 是群与私聊，task 是子会话）`,
    greeting: '你好',
    fieldsWithTool: `    // 可按会话设的配置项：apply 里调一次 fields() 登记给会话设置（随这次激活撤回，会话设置晚上线时自动补上），拿到读取器。
    // 会话设置是可选依赖，不在时读取器只取插件配置里的值`,
    fieldsAlone: `    // 可按会话设的配置项：apply 里调一次 fields() 登记给会话设置（随这次激活撤回，会话设置晚上线时自动补上），返回读取器，
    // 按会话读写作 fields.get(会话 id, { platform: 入口平台 }).greeting；会话设置是可选依赖，不在时只取插件配置里的值`,
    effectiveValue:
      '        // 按这次调用所在的会话读配置项的生效值：本会话、群、平台档等逐层叠出，哪一层都没设时是插件配置里的值',
    registerTool: '    // 注册 AI 可调用的工具。登记随这次激活撤回；tools 服务晚上线或换人时自动重挂',
    risk: `      // 风险档位，决定谁能经自然语言驱动它、要不要确认：只读且不涉隐私写 'safe'，任何人可用；只读但涉隐私写 'sensitive'，
      // 限有权限的用户；写、删、执行写 'dangerous'，限高权限的用户，owner 用也要确认。
      // 参见 Aalis 安全模型文档 concepts/security-model.md「插件作者怎么标操作风险」。`,
    background: `      // 耗时长、晚些拿到结果仍有用的工具（构建、下载、渲染）可以声明 background: {} 让执行器转后台：handler 要响应
      // ctx.signal 的中止并尽快返回，进度写进 ctx.output。见 Aalis 插件作者指南「长任务与取消」。本示例是即时的，不声明`,
    forModel: '          // 给模型的说明与结果写成字符串，不进字典',
    toolDescription: '示例工具：返回问候语',
    handlerResult: '      // handler 返回 string 即纯文本结果；需要把图交给主模型时返回 { content, images }',
    registerCommand: '    // 注册斜杠命令',
    registerPage: '    // 登记 WebUI 页面：组件、数据源与动作一次给出，出现在本插件详情里；登记随这次激活撤回',
    registerFrame: `    // 登记一个自带前端的 WebUI 页面：webui/ 里的静态网页在宿主画的隔离框架里显示，只能经宿主调这里声明的数据源与
    // 动作。出现在本插件详情里；登记随这次激活撤回`,
    items: ['示例条目一', '示例条目二', '示例条目三'],
    frameModule: '      // 宿主从这个模块往上找到插件包根，托管包根下 webui/ 里的文件',
    destructive: '        // destructive 的动作由宿主先弹确认框，框里列出这次的输入值',
    invalidate: '            // 数据变了：打开着的页面收到通知后重取',
    defaultExport: '// 入口必须默认导出 definePlugin 的产物：加载器只认它',
    uses: '  // 用到的全部能力。可选依赖包一层 optional()：缺席不拦激活，到场后自动接上',
    loaded: '插件已加载',
    capabilities: {
      tool: '注册 AI 工具',
      command: '注册斜杠命令',
      page: 'WebUI 页面',
      frame: 'WebUI 页面，自带前端（见下文「插件前端」）',
      sessionFields: '按会话读可按会话设的配置项',
      document: '只读宿主配置里本插件那一段，作可按会话设的配置项的全局层',
    },
    bullet: (what, uses, pkg) => `- ${what}（\`${uses}\`，从 \`${pkg}\` 导入描述符）`,
    readme: ({ a, usesLine, bullets, other }) => `# ${a.packageName}

${a.displayName} —— 由 \`create-aalis-plugin\` 生成的 Aalis 插件骨架。

## 构建

\`\`\`bash
npm install
npm run build
\`\`\`

## 装进 Aalis 项目

在 Aalis 项目目录里任选一种：

\`\`\`bash
npm install --install-links <本目录路径>    # 再在项目的 .npmrc 写一行 install-links=true，否则下次 npm install 会改回符号链接
npm install <本目录里 npm pack 生成的 .tgz>  # 先在本目录执行 npm pack
npm install ${a.packageName}                 # 发布到 npm 之后
\`\`\`

不能装成符号链接：本目录 devDependencies 里的 \`@aalis/core\` 会成为进程里的第二份，插件会被拒绝加载。
装好后重启实例，或在 WebUI 插件区点「重新扫描」，插件才会加载。

发现机制依赖 package.json 的 \`"keywords": ["aalis-plugin"]\`（脚手架已带，勿删）。
插件默认启用；停用是把包名加入 \`aalis.config.yaml\` 顶层的 \`disabledPlugins\` 数组。
插件配置写在 \`plugins."${a.packageName}"\` 段；没有 \`enabled\` 开关。若你为插件声明了
\`configSchema\`，键与字段以其为准（schema 外字段启动时会被裁剪）。
读取配置时安装 \`@aalis/schema-config\`（>=0.15.0），用 \`defineConfig\` 定义 schema，
在 apply 开头调用 \`parseConfig(schema, config.use, logger.use)\`。\`config\` 与 \`logger\` 都要写进 uses；
后续只读取解析结果。地址、启动参数等字段用 \`onInvalid: 'error'\` 拒绝错误值。
${
  a.features.sessionSetting
    ? `
写了 \`session\` 的字段可按会话设（本模板的问候语）：宿主不把它交给 \`config\`，\`parseConfig\` 也不产出它；
在 apply 里调一次 \`sessionFields.use.fields(configSchema, { config, document })\` 拿读取器，按会话读
\`fields.get(会话 id, { platform: 入口平台 })\`。会话设置插件不在时读取器只取插件配置里的值。
`
    : ''
}
## 多语言

给人看的文字在 \`src/texts.ts\`，另一种语言的译文在 \`src/locales/${other}.ts\`。
改了原文或加了键就跑 \`npm test\`（\`checkTexts\` 自检字典）。

## 扩展点

入口是 \`export default definePlugin({ uses, apply })\`。用到的服务经描述符导入后写进
\`uses\`（本模板与 \`src/index.ts\` 同源）：

\`${usesLine}\`

${bullets ? `${bullets}\n` : ''}
请打开 \`src/index.ts\` 按需修改。
${
  a.features.webui === 'frame'
    ? `
## 插件前端

页面用自带前端：\`webui/\` 里是一份静态网页，宿主把它画在插件详情的页面里一个隔离的框架中。它与宿主页面不同源，
拿不到登录状态，要宿主的数据与动作只能经宿主调 \`src/index.ts\` 里声明的数据源与动作。可以联网，外站的样式、字体、
图片与数据请求都放行；脚本只认 \`webui/\` 里打包的文件，页面里写的内联脚本不执行，框架里也不能再嵌别的网页。

- \`webui/index.html\` 是入口，引用宿主提供的样式基线 \`/frames/_base/frame.css\`（跟随宿主的主题）；
  \`webui/main.js\` 用宿主提供的助手 \`/frames/_base/frame.js\` 握手，取数据源 \`items\`、调动作 \`remove\`。都不用构建。
- 按钮与状态的文字经 \`frame.t\` 取自 \`src/texts.ts\`（服务端导入了它，宿主才交得出），按宿主界面的语言显示，
  助手按选中的语言设 \`<html lang>\`。
- \`package.json\` 的 \`files\` 带上了 \`webui\`，发布时一起打包。
- 只有一个文档：页面内的切换只用内存里的状态，不改地址；链接经 \`frame.open({ url })\` 请宿主打开；
  确认交给动作的 \`effect\`；不受信的文本（群成员的昵称与消息、网页标题）用 \`textContent\` 插入，不当 HTML。
- 页面宽度：插件页面跟着主区，会话面板约 340 像素，手机 390 像素，按容器宽度排版；尺寸用 rem，触屏可点区 44 像素。

契约见 Aalis 文档 api-webui 的「插件前端」一节。
`
    : ''
}`,
  },
  en: {
    description: displayName => `${displayName} — an Aalis plugin`,
    textsHeader: `// Source dictionary of the text shown to people: the display name and the text of pages, commands and settings come from
// here and show in the reader's language; translations into the other language are in locales/. Text for the model (tool
// descriptions and results) stays out of the dictionary`,
    toTranslate: '// To translate',
    textsTestHeader: `// Dictionary self-check: the source and the translations parse, their parameters match and no language misses a key. Run
// npm test after changing the source text or adding keys (it builds first, then runs this)`,
    textsTestName: 'the dictionary has no issues',
    configSchema: `// Settings. Fields with session can be set per session: each session, group, platform profile and so on can set its own, and
// the value in the plugin configuration applies where none is set; the host does not pass such fields to config, so apply
// reads them through the session settings reader`,
    prominence: `    // prominence is how prominent it is: composer sits next to the input box, common comes first in the settings, advanced goes
    // under Advanced. Without appliesTo it applies to every kind of session; write it only for some, such as appliesTo: ['room']
    // (owner is the owner's sessions in the WebUI and terminal, room is groups and private chats, task is subtasks)`,
    greeting: 'Hello',
    fieldsWithTool: `    // Per-session settings: call fields() once in apply to register them with session settings (withdrawn with this
    // activation, added automatically when session settings comes online later) and get a reader. Session settings is an
    // optional dependency; without it the reader only takes the values in the plugin configuration`,
    fieldsAlone: `    // Per-session settings: call fields() once in apply to register them with session settings (withdrawn with this
    // activation, added automatically when session settings comes online later). It returns a reader, read per session as
    // fields.get(session id, { platform: entry platform }).greeting; session settings is an optional dependency, and without
    // it only the values in the plugin configuration apply`,
    effectiveValue: `        // The effective value for the session of this call: layered from this session, group, platform profile and so on;
        // the value in the plugin configuration when no layer sets it`,
    registerTool: `    // Register a tool the AI can call. The registration is withdrawn with this activation and re-attached automatically
    // when the tools service comes online later or changes hands`,
    risk: `      // Risk level: decides who can drive it in natural language and whether it needs confirmation. Read-only and not private:
      // 'safe', anyone can use it; read-only but private: 'sensitive', for users with permission; write, delete or execute:
      // 'dangerous', for high-level users, and the owner must confirm too.
      // See "How plugin authors mark operation risk" in the Aalis security model doc concepts/security-model.md.`,
    background: `      // A tool that takes long and whose result is still useful later (builds, downloads, rendering) can declare
      // background: {} so the executor moves it to the background: the handler must respond to the abort on ctx.signal by
      // returning soon and write progress to ctx.output. See "Long tasks and cancellation" in the Aalis plugin author guide.
      // This sample is instant and does not declare it`,
    forModel: '          // For the model: the description and the result are plain strings, not in the dictionary',
    toolDescription: 'Sample tool: returns a greeting',
    handlerResult:
      '      // A string returned from the handler is a plain-text result; to give images to the main model return { content, images }',
    registerCommand: '    // Register a slash command',
    registerPage: `    // Register a WebUI page: components, data sources and actions are given at once. It appears in this plugin's details
    // and is withdrawn with this activation`,
    registerFrame: `    // Register a WebUI page with its own frontend: the static page in webui/ shows in an isolated frame drawn by the host and
    // can only call the data sources and actions declared here through the host. It appears in this plugin's details and is
    // withdrawn with this activation`,
    items: ['Sample item one', 'Sample item two', 'Sample item three'],
    frameModule:
      '      // The host walks up from this module to the plugin package root and serves the files under webui/ there',
    destructive:
      '        // The host asks for confirmation before a destructive action, listing the input of this call',
    invalidate: '            // The data changed: open pages are notified and fetch it again',
    defaultExport: '// The entry must default-export the result of definePlugin: the loader only recognizes that',
    uses: `  // Every capability used. Optional dependencies are wrapped in optional(): an absent one does not block activation and is
  // attached when it arrives`,
    loaded: 'Plugin loaded',
    capabilities: {
      tool: 'Register AI tools',
      command: 'Register slash commands',
      page: 'A WebUI page',
      frame: 'A WebUI page with its own frontend (see "Plugin frontend" below)',
      sessionFields: 'Read per-session settings per session',
      document:
        "Read only this plugin's section of the host configuration, as the global layer of the per-session settings",
    },
    bullet: (what, uses, pkg) => `- ${what} (\`${uses}\`, descriptor imported from \`${pkg}\`)`,
    readme: ({ a, usesLine, bullets, other }) => `# ${a.packageName}

${a.displayName} — an Aalis plugin skeleton generated by \`create-aalis-plugin\`.

## Build

\`\`\`bash
npm install
npm run build
\`\`\`

## Install into an Aalis project

In the Aalis project directory, use one of:

\`\`\`bash
npm install --install-links <path of this directory>   # then add install-links=true to the project's .npmrc, or the next npm install turns it back into a symlink
npm install <.tgz made by npm pack in this directory>  # run npm pack in this directory first
npm install ${a.packageName}                 # after publishing to npm
\`\`\`

It cannot be installed as a symlink: the \`@aalis/core\` in the devDependencies of this directory would become a second copy in the process, and the plugin would be refused.
After installing, restart the instance or use Rescan plugin folders in the WebUI plugin area to load the plugin.

Discovery relies on \`"keywords": ["aalis-plugin"]\` in package.json (the scaffold adds it; do not remove it).
Plugins are enabled by default; to disable one, add its package name to the top-level \`disabledPlugins\` array of \`aalis.config.yaml\`.
The plugin configuration goes in the \`plugins."${a.packageName}"\` section; there is no \`enabled\` switch. If you declare a
\`configSchema\` for the plugin, it defines the keys and fields (fields outside the schema are trimmed on start).
To read the configuration, install \`@aalis/schema-config\` (>=0.15.0), define the schema with \`defineConfig\` and call
\`parseConfig(schema, config.use, logger.use)\` at the start of apply. Both \`config\` and \`logger\` go into uses;
read only the parsed result afterwards. Reject wrong values of fields such as addresses and startup arguments with \`onInvalid: 'error'\`.
${
  a.features.sessionSetting
    ? `
Fields with \`session\` can be set per session (the greeting in this template): the host does not pass them to \`config\`, and
\`parseConfig\` does not produce them; call \`sessionFields.use.fields(configSchema, { config, document })\` once in apply for a
reader and read per session with \`fields.get(session id, { platform: entry platform })\`. Without the session settings plugin
the reader only takes the values in the plugin configuration.
`
    : ''
}
## Languages

Text shown to people is in \`src/texts.ts\`; the translation into the other language is in \`src/locales/${other}.ts\`.
After changing the source text or adding keys, run \`npm test\` (\`checkTexts\` checks the dictionary).

## Extension points

The entry is \`export default definePlugin({ uses, apply })\`. Services in use are imported as descriptors and listed in
\`uses\` (this template matches \`src/index.ts\`):

\`${usesLine}\`

${bullets ? `${bullets}\n` : ''}
Open \`src/index.ts\` and change it as needed.
${
  a.features.webui === 'frame'
    ? `
## Plugin frontend

The page has its own frontend: \`webui/\` holds a static page that the host draws in an isolated frame on the page in the plugin
details. It has a different origin from the host page and no login state; it reaches the host's data and actions only by calling
the data sources and actions declared in \`src/index.ts\` through the host. It can use the network: styles, fonts, images and
data requests from other sites are allowed; scripts are only the files packed in \`webui/\`, inline scripts in the page do not
run, and the frame cannot embed other pages.

- \`webui/index.html\` is the entry and links the host's style baseline \`/frames/_base/frame.css\` (it follows the host theme);
  \`webui/main.js\` handshakes through the host's helper \`/frames/_base/frame.js\`, reads the data source \`items\` and calls
  the action \`remove\`. Neither needs a build.
- The text of buttons and status comes from \`src/texts.ts\` through \`frame.t\` (the host can only hand it over because the server
  side imports it) and shows in the language of the host interface; the helper sets \`<html lang>\` to the chosen language.
- The \`files\` of \`package.json\` include \`webui\`, so it is packed when publishing.
- There is one document: switching inside the page uses in-memory state only and does not change the address; links are opened
  by the host through \`frame.open({ url })\`; confirmation is left to the action's \`effect\`; untrusted text (group members'
  nicknames and messages, page titles) is inserted with \`textContent\`, never as HTML.
- Page width: plugin pages follow the main area, the session panel is about 340 pixels and phones 390 pixels; lay out by the
  container width, use rem for sizes and 44 pixels for touch targets.

See the "Plugin frontend" section of api-webui in the Aalis docs for the contract.
`
    : ''
}`,
  },
};

// 仅在作为 CLI 直接执行时运行 main；被 import（单测纯函数）时不自动跑。
// 用 realpath 比较两侧：经 .bin 软链调用时 argv[1] 是软链路径，直接比 import.meta.url 会不相等。
let isCliEntry = false;
try {
  isCliEntry = !!argv[1] && realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* 非文件入口（REPL/eval 等）：保持 false，不自动运行 */
}
if (isCliEntry) {
  main().catch(err => {
    console.error(err);
    exit(1);
  });
}
