import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compilerOptions, fixtureProgram, ROOT, sourceFiles } from '../helpers/package-program.js';

// ════════════════════════════════════════════════════════════
// 语言只有一个来源
//
// 给人看的文字按 i18n 服务给的语言渲染（全局默认层的有序列表，会话或场所的显式设置覆盖），时区一律按服务进程；插件与出口
// 不自己找语言来源。取语言或时区来源的写法只许出现在名单里的位置，每条带理由：navigator 的 language 与 languages，
// Accept-Language 请求头（字面量写的头名，读写都算：替外部接口挑语言同样是自己找来源）与 express 的 acceptsLanguages，
// Intl 的 resolvedOptions().locale（默认 locale 就是进程或浏览器的系统语言），process.env 的 LANG、LANGUAGE 与 LC_*；
// WebUI 客户端另禁浏览器时区：resolvedOptions().timeZone 与 Date 的 getTimezoneOffset，以及按它取值或格式化的 Date 方法
// （getHours、getMinutes、getSeconds、getDate、getMonth、getFullYear、getDay，同名的 set 方法，toString、toDateString、
// toTimeString 与不带 timeZone 选项的 toLocale*String；客户端用服务端给的时区，经 format.ts）。服务端取 resolvedOptions().timeZone 就是服务进程的时区，
// 不禁。
//
// 按语法与类型认，不扫文本：属性访问（点、字面量键的方括号、对象解构）按类型检查器解析到的属性声明认，别名与可选链同样
// 认得出；process.env 按类型（NodeJS.ProcessEnv）认；请求头名按字符串字面量认，不分大小写。写死语言标签的 toLocale*String
// 与 Intl 格式器不在这里，留待后续。toLocale*String 的选项按类型认：类型上 timeZone 是必有的才算写明了（标成
// Intl.DateTimeFormatOptions 的变量里 timeZone 是可选的，不算）。看不到的：键是变量的访问、process.env 先交给只标成普通记录的变量再访问、扫描面
// 以外的文件；客户端不带 timeZone 的 new Intl.DateTimeFormat() 与 Date 隐式转成字符串（String(date)、模板串）；随前端打包的
// 同构库（schema-i18n、api-webui、api-approval）按服务端规则查，它们在浏览器里取时区看不到；服务端不带 locale 的
// toLocaleString() 与 new Intl.*() 隐式取进程的系统语言（留待后续迁移时清理）。
//
// 扫描面与编译选项同另两道文字守卫（test/helpers/package-program.ts），另加在浏览器里跑的插件框架助手（api-webui 的 frame），
// 按客户端规则查。名单按「文件 写法」认，不用行号；名单里的位置已经没有命中时报「该删掉」。
// ════════════════════════════════════════════════════════════

/** 名单：「文件 写法」→ 理由 */
const ALLOWED = new Map([
  [
    'packages/plugin-i18n/src/index.ts resolvedOptions().locale',
    '跟随系统：语言列表里的 auto 取服务进程的系统语言（Node 的 Intl 默认 locale），插件激活时取一次',
  ],
  [
    'packages/create-aalis/src/cli.ts resolvedOptions().locale',
    '安装界面识别：建项目时取一次系统语言，定安装界面的语言、默认的语言列表与要找的语言包；脚手架跑在插件体系之外',
  ],
  [
    'packages/runtime/src/start.ts resolvedOptions().locale',
    '--init 识别：初始化家目录时取一次系统语言，定写给 plugin-i18n 的默认语言列表；宿主跑在插件体系之外（与 create-aalis 一致，负责核心的会话 10-30）',
  ],
  [
    'packages/create-aalis-plugin/src/cli.ts resolvedOptions().locale',
    '安装界面识别：没给 --lang 时取一次系统语言，定终端的显示语言与缺省的原文语言；脚手架跑在插件体系之外',
  ],
]);

/** 一处命中：文件相对仓根，source 是哪种写法 */
interface Hit {
  file: string;
  line: number;
  source: string;
}

/** 按客户端规则查的源码：WebUI 客户端的 src 与插件框架助手 */
const CLIENT_SRC = /^packages\/(plugin-webui-client\/src|api-webui\/frame)\//;
/** 插件框架助手的目录：不在包的 src 里，单独加进扫描面 */
const FRAME_DIR = join(ROOT, 'packages/api-webui/frame');

/** 扫描面：packages 源码，加上插件框架助手的全部 .ts */
function scannedFiles(): string[] {
  const frame = (readdirSync(FRAME_DIR, { recursive: true }) as string[])
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map(name => join(FRAME_DIR, name));
  return [...sourceFiles(), ...frame];
}
/** 带语言信息的环境变量 */
const LOCALE_ENV = /^(LANG|LANGUAGE|LC_[A-Z]+)$/;
/** Intl 各格式器 resolvedOptions() 的返回类型 */
const RESOLVED_OPTIONS = /^Resolved\w*Options$/;
/** Date 上按所在环境的时区取值或格式化的方法 */
const LOCAL_DATE =
  /^(get(Hours|Minutes|Seconds|Date|Month|FullYear|Day)|set(Hours|Minutes|Seconds|Date|Month|FullYear)|to(Date|Time|Locale(Date|Time)?)?String)$/;

/** 程序里取语言或时区来源的位置，只看 `files` 里的源文件 */
function languageSources(program: ts.Program, files: readonly string[]): Hit[] {
  const checker = program.getTypeChecker();
  /** 联合看成员（可选链的 undefined 成员上没有属性，不影响） */
  const members = (type: ts.Type) => (type.isUnion() ? type.types : [type]);
  /** 类型的这个属性声明在名字满足 test 的接口上 */
  const declaredOn = (type: ts.Type, name: string, test: (iface: string) => boolean) =>
    members(type).some(member =>
      checker
        .getPropertyOfType(member, name)
        ?.declarations?.some(({ parent }) => ts.isInterfaceDeclaration(parent) && test(parent.name.text)),
    );
  /** 访问 type 上名为 name 的属性取到的来源；不是来源回 undefined */
  const read = (type: ts.Type, name: string, client: boolean): string | undefined => {
    if (LOCALE_ENV.test(name) && members(type).some(member => member.symbol?.name === 'ProcessEnv')) {
      return `process.env.${name}`;
    }
    if (
      (name === 'language' || name === 'languages') &&
      declaredOn(type, name, i => /^Navigator(Language)?$/.test(i))
    ) {
      return `navigator.${name}`;
    }
    if (name === 'acceptsLanguages' && declaredOn(type, name, i => i === 'Request')) return name;
    if (name === 'locale' && declaredOn(type, name, i => RESOLVED_OPTIONS.test(i))) return 'resolvedOptions().locale';
    if (!client) return undefined;
    if (name === 'timeZone' && declaredOn(type, name, i => RESOLVED_OPTIONS.test(i))) {
      return 'resolvedOptions().timeZone';
    }
    if (name === 'getTimezoneOffset' && declaredOn(type, name, i => i === 'Date')) return 'getTimezoneOffset()';
    if (LOCAL_DATE.test(name) && declaredOn(type, name, i => i === 'Date')) return `Date.${name}()`;
    return undefined;
  };
  /** 调用 toLocale*String 时选项（第二个参数）的类型上 timeZone 是必有的：时区写明了（可选的算没写明） */
  const zoned = (access: ts.PropertyAccessExpression) => {
    const call = access.parent;
    const options = ts.isCallExpression(call) && call.expression === access ? call.arguments[1] : undefined;
    const timeZone = options && checker.getTypeAtLocation(options).getProperty('timeZone');
    return timeZone !== undefined && (timeZone.flags & ts.SymbolFlags.Optional) === 0;
  };
  /** 节点取到的来源：属性访问（点、字面量键的方括号、对象解构）与请求头名的字面量 */
  const sourceOf = (node: ts.Node, client: boolean): string | undefined => {
    if (ts.isPropertyAccessExpression(node)) {
      const source = read(checker.getTypeAtLocation(node.expression), node.name.text, client);
      return source?.startsWith('Date.toLocale') && zoned(node) ? undefined : source;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      return read(checker.getTypeAtLocation(node.expression), node.argumentExpression.text, client);
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = node.propertyName ?? node.name;
      return ts.isIdentifier(name) || ts.isStringLiteral(name)
        ? read(checker.getTypeAtLocation(node.parent), name.text, client)
        : undefined;
    }
    if (ts.isStringLiteralLike(node) && node.text.toLowerCase() === 'accept-language') return 'Accept-Language';
    return undefined;
  };
  const hits: Hit[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`程序里没有 ${file}`);
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const client = CLIENT_SRC.test(rel);
    const visit = (node: ts.Node): void => {
      const source = sourceOf(node, client);
      if (source) hits.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, source });
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

/** 对照名单：名单外的命中（`文件:行 写法`），名单里已经没有命中、该删掉的条目 */
function audit(hits: readonly Hit[], allowed: ReadonlyMap<string, string>) {
  const key = (hit: Hit) => `${hit.file} ${hit.source}`;
  return {
    unlisted: hits.filter(hit => !allowed.has(key(hit))).map(hit => `${hit.file}:${hit.line} ${hit.source}`),
    stale: [...allowed.keys()].filter(entry => !hits.some(hit => key(hit) === entry)),
  };
}

// 夹具不落盘；编译宿主收到的文件名一律用 / 分隔。服务端夹具放在 webui-server 的 src 下，express 的类型才解析得到
const SERVER_FIXTURE = join(ROOT, 'packages/plugin-webui-server/src/language-sources.fixture.ts').replace(/\\/g, '/');
// 插件框架助手在浏览器里跑：放在 api-webui 的 frame 下，按客户端规则查
const FRAME_FIXTURE = join(ROOT, 'packages/api-webui/frame/language-sources.fixture.ts').replace(/\\/g, '/');
const FRAME_SOURCE = `export const language = navigator.language;
export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
`;
const SERVER_SOURCE = `import type { Request } from 'express';
declare const req: Request;
declare const headers: Record<string, string | undefined>;
declare const env: NodeJS.ProcessEnv | undefined;
export const a = navigator.language;
export const b = window.navigator?.languages;
const nav = navigator;
export const { language } = nav;
export const c = headers['accept-language'];
export const d = req.get('Accept-Language');
export const e = { 'ACCEPT-LANGUAGE': 'en' };
export const f = req.acceptsLanguages();
export const g = Intl.DateTimeFormat().resolvedOptions().locale;
const options = new Intl.NumberFormat().resolvedOptions();
export const { locale } = options;
export const h = process.env.LANG;
export const i = env?.['LC_ALL'];
export const { LANGUAGE, LC_MESSAGES: messages } = process.env;
export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const offset = new Date().getTimezoneOffset();
export const tag = new Intl.Locale('ja-JP').language;
export const child = { ...process.env, LC_ALL: 'C' };
export const path = process.env.PATH;
export const own = { language: 'zh-CN' }.language;
export const platform = navigator.platform;
`;
// 放在客户端的 src 下，才按客户端规则查
const CLIENT_FIXTURE = join(ROOT, 'packages/plugin-webui-client/src/language-sources.fixture.ts').replace(/\\/g, '/');
const CLIENT_SOURCE = `export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const offset = new Date().getTimezoneOffset();
export const { timeZone } = new Intl.DateTimeFormat().resolvedOptions();
export const language = navigator.language;
export const platform = navigator.platform;
export const formatted = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
export const hours = new Date().getHours();
const day = new Date(0);
export const { getDay } = day;
export const local = day.toLocaleDateString();
export const optioned = day.toLocaleTimeString('en', { hour: 'numeric' });
export const zoned = day.toLocaleTimeString('en', { ...{ hour: 'numeric' }, timeZone: 'UTC' });
export const utc = [day.getUTCHours(), day.toISOString(), (1234).toLocaleString()];
const options: Intl.DateTimeFormatOptions = { hour: 'numeric' };
export const typed = day.toLocaleTimeString('en', options);
export const plain = day.toString();
day.setHours(0);
`;

/** 一个夹具里的命中：`行 写法` */
function fixtureHits(file: string, source: string): string[] {
  return languageSources(fixtureProgram(file, source), [file]).map(hit => `${hit.line} ${hit.source}`);
}

describe('语言只有一个来源', () => {
  it('服务端：浏览器语言、请求头、默认 locale 与环境变量按声明认（别名、解构、可选链也认）；服务进程的时区与别的属性不报', () => {
    expect(fixtureHits(SERVER_FIXTURE, SERVER_SOURCE)).toEqual([
      '5 navigator.language',
      '6 navigator.languages',
      '8 navigator.language',
      '9 Accept-Language',
      '10 Accept-Language',
      '11 Accept-Language',
      '12 acceptsLanguages',
      '13 resolvedOptions().locale',
      '15 resolvedOptions().locale',
      '16 process.env.LANG',
      '17 process.env.LC_ALL',
      '18 process.env.LANGUAGE',
      '18 process.env.LC_MESSAGES',
    ]);
  });

  it('客户端：另报浏览器时区与按它取值、格式化的 Date 方法（toLocale*String 带上 timeZone 选项的不报）；写死语言标签的格式化不归这里', () => {
    expect(fixtureHits(CLIENT_FIXTURE, CLIENT_SOURCE)).toEqual([
      '1 resolvedOptions().timeZone',
      '2 getTimezoneOffset()',
      '3 resolvedOptions().timeZone',
      '4 navigator.language',
      '7 Date.getHours()',
      '9 Date.getDay()',
      '10 Date.toLocaleDateString()',
      '11 Date.toLocaleTimeString()',
      '15 Date.toLocaleTimeString()',
      '16 Date.toString()',
      '17 Date.setHours()',
    ]);
  });

  it('插件框架助手（api-webui 的 frame）按客户端规则查', () => {
    expect(fixtureHits(FRAME_FIXTURE, FRAME_SOURCE)).toEqual(['1 navigator.language', '2 resolvedOptions().timeZone']);
  });

  it('名单外的命中报出来；名单里已经没有命中的条目报「该删掉」', () => {
    const hits: Hit[] = [
      { file: 'packages/plugin-a/src/index.ts', line: 3, source: 'navigator.language' },
      { file: 'packages/plugin-b/src/index.ts', line: 5, source: 'process.env.LANG' },
    ];
    const allowed = new Map([
      ['packages/plugin-a/src/index.ts navigator.language', '夹具'],
      ['packages/plugin-c/src/index.ts Accept-Language', '夹具'],
    ]);
    expect(audit(hits, allowed)).toEqual({
      unlisted: ['packages/plugin-b/src/index.ts:5 process.env.LANG'],
      stale: ['packages/plugin-c/src/index.ts Accept-Language'],
    });
  });

  it('packages 源码里取语言或时区来源的位置都在名单里，名单里的条目都还有命中', () => {
    const files = scannedFiles();
    expect(files).toContain(join(ROOT, 'packages/api-webui/frame/frame.ts'));
    const hits = languageSources(ts.createProgram(files, compilerOptions()), files);
    expect(
      audit(hits, ALLOWED),
      '语言从 i18n 服务取，时区按服务进程；确实要另取的登记进名单并写理由，名单里已经没有命中的条目删掉',
    ).toEqual({ unlisted: [], stale: [] });
  }, 120_000);
});
