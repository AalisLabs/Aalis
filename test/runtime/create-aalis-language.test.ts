import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { parse } from 'yaml';
import {
  collect,
  type Option,
  type Prompter,
  packSearchMiss,
  parseLanguages,
  systemLanguage,
  type UiLanguage,
  uiLanguage,
  writeProject,
} from '../../packages/create-aalis/src/cli.js';
import { resolveText, type TextRef } from '../../packages/schema-i18n/src/index.js';
import { withSystemLocale } from '../fixtures/system-locale.js';

// ════════════════════════════════════════════════════════════
// create-aalis 的语言：建项目时识别一次系统语言（Node 的 Intl 默认 locale）。安装界面的语言在脚手架字典有的中文、英文里选，
// 识别结果预选；--lang 是写进配置的 Aalis 语言列表，安装界面取其中第一个字典有的语言，给了它就不问两步语言。
// 这批插件里有 plugin-i18n 时，最后一步排语言列表写进它的配置，项都是明确的语言标签：识别到的系统语言有插件提供时排第一，其后是
// 安装界面的语言与其余。没给 --lang、系统语言又没有插件提供时，交互模式去源上找语言包，非交互只提示。
// ════════════════════════════════════════════════════════════

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/create-aalis/src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');
const I18N = '@aalis/plugin-i18n';
/** 中日韩文字 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const shown = (text: string | TextRef, language: UiLanguage) =>
  typeof text === 'string' ? text : resolveText(text, [language]);

interface Asked {
  kind: string;
  title: string;
  labels?: string[];
  def?: unknown;
}

/** 替身终端：按它当时的显示语言记下问了什么（标题与选项的说明），按顺序回答，undefined 取默认 */
function scripted(language: UiLanguage, replies: unknown[] = []) {
  const asked: Asked[] = [];
  const next = () => replies.shift();
  const record = (kind: string, title: string | TextRef, options?: readonly Option[], def?: unknown) =>
    asked.push({
      kind,
      title: shown(title, prompter.language),
      labels: options?.map(o => shown(o.label, prompter.language)),
      def,
    });
  const prompter: Prompter = {
    language,
    text: async (question, def) => {
      record('text', question, undefined, def);
      return (next() as string | undefined) ?? def;
    },
    choose: async (title, options, def) => {
      record('choose', title, options, def);
      const name = (next() as string | undefined) ?? def;
      const found = options.find(o => o.name === name);
      if (!found) throw new Error(`没有选项 ${name}`);
      return found;
    },
    chooseMany: async (title, options, defs) => {
      record('chooseMany', title, options, defs);
      return (next() as string[] | undefined) ?? [...defs];
    },
    order: async (title, options) => {
      record('order', title, options);
      return (next() as string[] | undefined) ?? options.map(o => o.name);
    },
    confirm: async (question, def) => {
      record('confirm', question, undefined, def);
      return (next() as boolean | undefined) ?? def;
    },
    secret: async question => {
      record('secret', question);
      return (next() as string | undefined) ?? '';
    },
    close() {},
  };
  return { prompter, asked };
}

/** 不碰本机的 Ollama 与真的源：都指向没人监听的端口 */
const BASE = {
  advanced: false,
  force: false,
  lancedb: true,
  host: 'http://127.0.0.1:9',
  registry: 'http://127.0.0.1:9',
};

/** collect 打到终端的提示：只看 console.warn，console.log 静音 */
let warn: MockInstance;
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
const warned = () => warn.mock.calls.map(call => String(call[0]));

describe('安装界面的语言', () => {
  it.each([
    ['zh-CN', 'zh-CN', ['安装界面的语言', '项目目录名', '对话模型'], 'Ollama（本机运行，零 key）'],
    [
      'en-US',
      'en',
      ['Installer language', 'Project directory name', 'Chat model'],
      'Ollama (runs locally, no key needed)',
    ],
    [
      'ja-JP',
      'en',
      ['Installer language', 'Project directory name', 'Chat model'],
      'Ollama (runs locally, no key needed)',
    ],
  ])('系统语言是 %s：第一问在中文、英文里选，预选 %s，之后的提问与选项按它显示', async (locale, ui, titles, ollama) => {
    await withSystemLocale(locale, async () => {
      const system = systemLanguage();
      const { prompter, asked } = scripted(uiLanguage(system));
      const answers = await collect(prompter, { ...BASE, tier: 'minimal', system });
      expect(asked[0]).toMatchObject({ kind: 'choose', labels: ['中文（中国）', 'English'], def: ui });
      expect(asked.slice(0, 3).map(a => a.title)).toEqual(titles);
      expect(asked[2].labels).toContain(ollama);
      expect(answers.ui).toBe(ui);
    });
  });

  it('第一问选了另一种语言：之后的提问按选的语言显示', async () => {
    const { prompter, asked } = scripted('zh-CN', ['en']);
    const answers = await collect(prompter, { ...BASE, tier: 'minimal', system: 'zh-CN' });
    expect(asked.slice(0, 3).map(a => a.title)).toEqual(['安装界面的语言', 'Project directory name', 'Chat model']);
    expect(answers.ui).toBe('en');
    expect(answers.languages).toEqual(['zh-CN', 'en']);
  });

  it('第一问选了另一种语言：生成的 README 与 package.json 描述跟选的语言，配置写排好的语言列表', async () => {
    const { prompter } = scripted('zh-CN', ['en']);
    const answers = await collect(prompter, { ...BASE, tier: 'minimal', system: 'zh-CN' });
    const root = await mkdtemp(join(tmpdir(), 'aalis-ui-'));
    try {
      const dir = join(root, answers.projectName);
      await writeProject(answers, { dir, registry: BASE.registry, host: BASE.host });
      const config = await readFile(join(dir, 'data', 'aalis.config.yaml'), 'utf-8');
      expect(await readFile(join(dir, 'README.md'), 'utf-8')).toContain('An AI assistant project based on [Aalis]');
      expect(parse(config).plugins[I18N]).toEqual({ language: ['zh-CN', 'en'] });
      expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')).description).toBe(
        'my-aalis-bot — an AI assistant based on Aalis',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('中文系统下给 --lang en：不问两步语言，提问按英文显示，配置写给的列表', async () => {
    const { prompter, asked } = scripted(uiLanguage('zh-CN', ['en']));
    const answers = await collect(prompter, { ...BASE, tier: 'minimal', system: 'zh-CN', languages: ['en'] });
    expect(asked[0]).toMatchObject({ kind: 'text', title: 'Project directory name' });
    expect(asked.filter(a => a.kind === 'order' || a.title === 'Installer language')).toEqual([]);
    expect(answers).toMatchObject({ ui: 'en', languages: ['en'] });
  });

  it.each([
    ['zh-CN', undefined, 'zh-CN'],
    ['en-US', undefined, 'en'],
    ['ja-JP', undefined, 'en'],
    ['zh-CN', ['en'], 'en'],
    ['ja-JP', ['ja', 'zh-CN'], 'zh-CN'],
    ['zh-CN', ['ja'], 'zh-CN'],
  ])('系统 %s、--lang %j：安装界面用 %s（列表里第一个字典有的；都没有时按识别，识别不到为英文）', (system, languages, ui) => {
    expect(uiLanguage(system, languages)).toBe(ui);
  });

  it.each([
    ['zh-CN', 'zh-CN'],
    ['ja-JP', 'ja-JP'],
    ['und', 'en-US'],
  ])('识别系统语言：Intl 默认 locale 为 %s 时得 %s（认不出的按 en-US）', async (locale, tag) => {
    expect(await withSystemLocale(locale, async () => systemLanguage())).toBe(tag);
  });
});

describe('--lang', () => {
  it('逗号分隔，每项是认得的语言标签，规范化后照顺序写', () => {
    expect(parseLanguages('ja_JP,zh_CN,en')).toEqual({ ok: true, languages: ['ja-JP', 'zh-CN', 'en'] });
  });

  it('各项去掉两头的空白，规范化后重复的只留第一次', () => {
    expect(parseLanguages(' zh_CN,zh-CN, en ')).toEqual({ ok: true, languages: ['zh-CN', 'en'] });
  });

  it.each([
    ['en,zz_!!', 'zz_!!'],
    ['auto,en', 'auto'],
  ])('不合法的一项（%s）：报错写明是哪一项，按显示语言', (raw, item) => {
    const result = parseLanguages(raw);
    if (result.ok) throw new Error('应当不合法');
    expect([resolveText(result.error, ['zh-CN']), resolveText(result.error, ['en'])]).toEqual([
      `--lang 里的「${item}」不是语言标签：写 zh-CN、en 这类标签，多项用逗号分隔`,
      `“${item}” in --lang is not a language tag: write tags such as zh-CN and en, separated by commas`,
    ]);
  });
});

describe('语言列表', () => {
  it('交互：最后一问列出第一方插件提供的语言，回车用默认顺序（系统语言、其余），显示排好的链再确认', async () => {
    const { prompter, asked } = scripted('zh-CN');
    const answers = await collect(prompter, { ...BASE, tier: 'minimal', system: 'zh-CN' });
    expect(asked.slice(-2)).toEqual([
      {
        kind: 'order',
        title: 'Aalis 的语言列表（排在前面的先用，缺译文时依次用后面的）',
        labels: ['中文（中国）', 'English'],
        def: undefined,
      },
      {
        kind: 'confirm',
        title: 'Aalis 的语言列表：中文（中国） → English。就按这个顺序吗？',
        labels: undefined,
        def: true,
      },
    ]);
    expect(answers.languages).toEqual(['zh-CN', 'en']);
  });

  it('交互：不确认就重排，确认后照排好的写', async () => {
    const replies = [undefined, undefined, undefined, undefined, undefined, ['zh-CN', 'en'], false];
    const { prompter, asked } = scripted('zh-CN', [...replies, ['en', 'zh-CN'], true]);
    const answers = await collect(prompter, { ...BASE, tier: 'minimal', system: 'zh-CN' });
    expect(asked.filter(a => a.kind === 'order')).toHaveLength(2);
    expect(answers.languages).toEqual(['en', 'zh-CN']);
  });

  it.each([
    ['zh-CN', ['zh-CN', 'en']],
    ['zh-TW', ['zh-CN', 'en']],
    ['en-GB', ['en', 'zh-CN']],
    ['ja-JP', ['en', 'zh-CN']],
  ])('非交互、没给 --lang：系统语言 %s 时写 %j（中文系统中文在前，别的英文在前）', async (system, languages) => {
    expect((await collect(undefined, { ...BASE, tier: 'minimal', system })).languages).toEqual(languages);
  });

  it('非交互、给了 --lang：照写，安装界面取列表里第一个字典有的语言', async () => {
    const given = await collect(undefined, { ...BASE, tier: 'minimal', system: 'en-US', languages: ['zh-CN', 'en'] });
    expect(given).toMatchObject({ ui: 'zh-CN', languages: ['zh-CN', 'en'] });
  });

  it('bare 档没有 plugin-i18n：只问安装界面的语言，不排语言列表，不写这一段', async () => {
    const { prompter, asked } = scripted('zh-CN');
    const answers = await collect(prompter, { ...BASE, tier: 'bare', system: 'zh-CN' });
    expect(asked.map(a => a.kind)).toEqual(['choose', 'text']);
    expect(answers.enabled.has(I18N)).toBe(false);
    expect(answers.languages).toBeUndefined();
  });
});

describe('找语言包', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  /** 替身源：按检索的关键词回 objects，记下检索词原样（带 keywords: 前缀） */
  async function registry(objects: Record<string, object[]> = {}) {
    const searched: string[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const text = url.searchParams.get('text') ?? '';
      const keyword = text.replace(/^keywords:/, '');
      if (url.pathname === '/-/v1/search') searched.push(text);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ objects: objects[keyword] ?? [] }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('未监听 TCP');
    return { url: `http://127.0.0.1:${address.port}`, searched };
  }

  const UNPROVIDED = 'No plugin provides 日本語 (日本) (ja-JP), so it is left out of the language list';

  it('交互、源上没有：先按完整标签、再按基础语言检索，提示可能是源不支持检索与没有插件提供，列表照第一方的语言', async () => {
    const source = await registry();
    const { prompter, asked } = scripted('en');
    const answers = await collect(prompter, { ...BASE, registry: source.url, tier: 'minimal', system: 'ja-JP' });
    expect(source.searched).toEqual(['keywords:aalis-lang-ja-jp', 'keywords:aalis-lang-ja']);
    expect(warned()).toEqual([
      `No language pack for 日本語 (日本) (ja-JP) was found on ${source.url}; this registry may not support search, so you can retry with --registry https://registry.npmjs.org`,
      UNPROVIDED,
    ]);
    expect(asked.find(a => a.kind === 'order')?.labels).toEqual(['English', '中文（中国）']);
    expect(answers.languages).toEqual(['en', 'zh-CN']);
  });

  it('交互、连不上源：写明没能检索，不说源上没有', async () => {
    const { prompter } = scripted('en');
    await collect(prompter, { ...BASE, tier: 'minimal', system: 'ja-JP' });
    expect(warned()).toEqual([
      `Cannot reach ${BASE.registry}, so no language pack for 日本語 (日本) (ja-JP) could be searched for`,
      UNPROVIDED,
    ]);
  });

  it.each([
    ['https://registry.npmjs.org', 'https://registry.npmjs.org'],
    ['https://registry.npmjs.org/', 'https://registry.npmjs.org/'],
  ])('源是官方源（%s）、没找到：只说没有，不建议换官方源重试', (registry, shownRegistry) => {
    const text = packSearchMiss(registry, false, { name: '日本語 (日本)', tag: 'ja-JP' });
    expect([resolveText(text, ['zh-CN']), resolveText(text, ['en'])]).toEqual([
      `${shownRegistry} 上没有 日本語 (日本)（ja-JP）的语言包`,
      `No language pack for 日本語 (日本) (ja-JP) was found on ${shownRegistry}`,
    ]);
  });

  it('交互、找到了：只收确实带这个关键词的包，问是否一起装；装了的进依赖，它的语言排在列表最前，不再提示', async () => {
    const pack = 'zz-aalis-plugin-lang-ja';
    const source = await registry({
      'aalis-lang-ja-jp': [{ package: { name: 'zz-unrelated', keywords: ['aalis-plugin'] } }],
      'aalis-lang-ja': [
        { package: { name: pack, keywords: ['aalis-plugin', 'aalis-language-pack', 'aalis-lang-ja'] } },
      ],
    });
    const { prompter, asked } = scripted('en', [undefined, undefined, undefined, undefined, undefined, pack]);
    const answers = await collect(prompter, { ...BASE, registry: source.url, tier: 'minimal', system: 'ja-JP' });
    expect(asked.find(a => a.labels?.includes(pack))).toEqual({
      kind: 'choose',
      title: 'Found language packs for 日本語 (日本) (ja-JP). Install one as well?',
      labels: [pack, 'Do not install'],
      def: '',
    });
    expect(answers.enabled.has(pack)).toBe(true);
    expect(answers.languages).toEqual(['ja', 'en', 'zh-CN']);
    expect(asked.find(a => a.kind === 'order')?.labels).toEqual(['日本語', 'English', '中文（中国）']);
    expect(warned()).toEqual([]);
  });

  it('交互、找到了但不装：提示没有插件提供', async () => {
    const source = await registry({
      'aalis-lang-ja-jp': [{ package: { name: 'zz-lang', keywords: ['aalis-lang-ja-jp'] } }],
    });
    const { prompter } = scripted('en');
    const answers = await collect(prompter, { ...BASE, registry: source.url, tier: 'minimal', system: 'ja-JP' });
    expect(source.searched).toEqual(['keywords:aalis-lang-ja-jp']);
    expect(answers.enabled.has('zz-lang')).toBe(false);
    expect(warned()).toEqual([UNPROVIDED]);
  });

  it('非交互：检索接口一次都不调，只提示', async () => {
    const source = await registry();
    const answers = await collect(undefined, { ...BASE, registry: source.url, tier: 'minimal', system: 'ja-JP' });
    expect(source.searched).toEqual([]);
    expect(warned()).toEqual([UNPROVIDED]);
    expect(answers.languages).toEqual(['en', 'zh-CN']);
  });

  it('给了 --lang：照它写，系统语言用不上，不找也不提示', async () => {
    const source = await registry();
    const { prompter } = scripted('en');
    await collect(prompter, { ...BASE, registry: source.url, tier: 'minimal', system: 'ja-JP', languages: ['en'] });
    expect(source.searched).toEqual([]);
    expect(warned()).toEqual([]);
  });
});

describe('真 CLI 的终端文字', () => {
  let dir: string;
  let server: Server | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aalis-lang-'));
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server?.close(() => resolve()));
      server = undefined;
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** 替身源：检索回空，版本一律 0.21.0 */
  async function serve(): Promise<string> {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/-/v1/search') ? { objects: [] } : { version: '0.21.0' }));
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('未监听 TCP');
    return `http://127.0.0.1:${address.port}`;
  }

  /** 跑真 CLI：系统语言由 env 的 LANG 定（清掉会盖过它的 LC_ALL 与 LC_MESSAGES），stdin 是管道（不是终端） */
  async function create(lang: string, args: string[]) {
    const env = { ...process.env, LANG: lang, LC_ALL: undefined, LC_MESSAGES: undefined, OLLAMA_HOST: '127.0.0.1:9' };
    return run(process.execPath, ['--import', tsx, cli, ...args], { cwd: dir, timeout: 10_000, env }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );
  }

  it('中文系统下 --lang en：非交互生成与非终端报错两条路径的输出都不含中日韩文字', async () => {
    const registry = await serve();
    const yes = await create('zh_CN.UTF-8', [
      'my-bot',
      '--yes',
      '--no-install',
      '--lang',
      'en',
      '--registry',
      registry,
    ]);
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('Next steps:');
    expect(`${yes.stdout}${yes.stderr}`).not.toMatch(CJK);
    const config = parse(await readFile(join(dir, 'my-bot', 'data', 'aalis.config.yaml'), 'utf-8'));
    expect(config.plugins[I18N]).toEqual({ language: ['en'] });

    const piped = await create('zh_CN.UTF-8', ['my-bot', '--lang', 'en', '--registry', registry]);
    expect(piped.code).toBe(1);
    expect(piped.stderr).toContain('--yes');
    expect(`${piped.stdout}${piped.stderr}`).not.toMatch(CJK);
  });

  it('没给 --lang：按 LANG 识别，英文系统显示英文，配置写默认顺序', async () => {
    const registry = await serve();
    const result = await create('en_US.UTF-8', ['my-bot', '--yes', '--no-install', '--registry', registry]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Next steps:');
    expect(`${result.stdout}${result.stderr}`).not.toMatch(CJK);
    const config = parse(await readFile(join(dir, 'my-bot', 'data', 'aalis.config.yaml'), 'utf-8'));
    expect(config.plugins[I18N]).toEqual({ language: ['en', 'zh-CN'] });
  });

  it('--lang 里有不合法的一项（auto 不是语言标签）：退出码 1，写明是哪一项', async () => {
    const result = await create('en_US.UTF-8', ['my-bot', '--yes', '--no-install', '--lang', 'auto,zz_!!']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      '“auto” in --lang is not a language tag: write tags such as zh-CN and en, separated by commas',
    );
  });
});
