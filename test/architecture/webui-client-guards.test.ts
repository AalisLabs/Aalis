import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sessionMethods, sessionNotifications } from '../../packages/api-session-protocol/src/index.js';

// ════════════════════════════════════════════════════════════
// WebUI 的写法守卫：
// - 兼容与写法（客户端）：颜色只来自主题令牌，组件 CSS 不写 px（线宽 1px、2px 除外），字号与时长只引用令牌，内联 style 只设 CSS 变量，
//   不用原生对话框与 window.open，浏览器存储只经存储模块（首帧主题脚本除外），不写死主机与端口（认本机网址的模块写回环
//   地址，是唯一的例外），dangerouslySetInnerHTML 只许出现在白名单里的文件；
// - 客户端只认契约不认插件：不出现插件包名，不依赖对话代理的契约（用量分项名由条目给出），字符串字面量不等于任何插件
//   登记的页面键、动作名、数据源名、设置键或工具名。
//   与会话协议、管理面事件、插件前端消息里的字段同名的不查，这份排除表从 schema 与类型定义算出；
// - 服务端只认契约不认插件：会话协议、webui-server（含框架托管与转发）、session-server 的源码不出现别的插件的名字，
//   字符串字面量里的词（协议另加字段名）不是别的插件登记的工具名、设置键、字段名、页面键、动作名或数据源名。
//   契约包里出现的词与字段声明的可选项来源不查，这份排除表从契约包的源码算出；
// - 插件前端：iframe、postMessage 与 MessageChannel 只出现在框架模块里，客户端与服务端都不出现 allow-same-origin。
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');
const PACKAGES = join(ROOT, 'packages');
const CLIENT = join(PACKAGES, 'plugin-webui-client');
const SRC = join(CLIENT, 'src');

/** 定义尺寸、圆角、阴影令牌的文件：唯一可以写 px 的样式文件 */
const TOKEN_FILE = 'src/styles/tokens.css';
/** 浏览器存储只经这个模块 */
const STORAGE_MODULE = 'src/storage.ts';
/** 首帧主题脚本：在打包的脚本之前执行，直接读浏览器存储 */
const THEME_SCRIPT = 'public/theme.js';
/** 认后台任务输出里的本机网址、判断页面是不是经回环地址打开的模块：唯一可以写回环地址的地方 */
const LOOPBACK_MODULE = 'src/background/loopback.ts';
/** 回环地址的写法 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];
/** 可以用 dangerouslySetInnerHTML 的文件：只给 Mermaid 渲染组件（输出经严格安全级别） */
const DANGEROUS_HTML_FILES = new Set<string>(['src/markdown/Mermaid.tsx']);
/** 插件前端的框架模块：唯一画 iframe、收发框架消息的地方 */
const FRAME_MODULE = 'src/frame/';

function* walk(dir: string, pattern: RegExp): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') yield* walk(full, pattern);
    } else if (pattern.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

const rel = (file: string) => relative(CLIENT, file);
const read = (file: string) => readFileSync(file, 'utf-8');

/** 客户端的源码（含首帧主题脚本与页面模板） */
const SOURCES = [...walk(SRC, /\.(tsx?|css)$/), join(CLIENT, THEME_SCRIPT), join(CLIENT, 'index.html')];
const SCRIPTS = SOURCES.filter(file => /\.(tsx?|js)$/.test(file));
const STYLES = SOURCES.filter(file => file.endsWith('.css'));

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, kind);
}

function visitAll(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => visitAll(child, visit));
}

/** 每个脚本文件里命中 test 的节点，按「文件：行」列出 */
function findNodes(files: string[], test: (node: ts.Node) => boolean): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const source = parse(file);
    visitAll(source, node => {
      if (test(node)) hits.push(`${rel(file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    });
  }
  return hits;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

const literalText = (node: ts.Node | undefined) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const propertyName = (property: ts.ObjectLiteralElementLike) =>
  property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : undefined;

/** 字符串字面量与模板各段的文字 */
const stringText = (node: ts.Node) =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateHead(node) ||
  ts.isTemplateMiddle(node) ||
  ts.isTemplateTail(node)
    ? node.text
    : undefined;

/** 一段文字里的词：字母、数字、下划线与连字符连成的一串 */
const wordsIn = (text: string) => text.split(/[^\w-]+/).filter(Boolean);

// ----- 插件登记的页面键、动作名、数据源名、设置键、工具名与字段名 -----

/**
 * 从源码收集：页面键取页面声明（带 key、title，且带 content 或 frame 的对象，标签不算）的 key，key 写成本文件里的字符串
 * 常量时取常量的值；动作名取页面声明的 actions 对象的键，数据源名取插件前端页面的 sources 对象的键；设置键取各包对
 * SessionConfig 的扩展（登记的键必须是 SessionConfig 的键）；工具名取带 name、description 与 parameters 的对象的 name；
 * schema 字段名（配置键、动作与数据源的输入字段）取带 type 与 label 的对象、带 fields 的分组所在属性的名字，只收复合词，
 * 单个小写词（如 port、shell）是通用词，判不出归属；字段声明的可选项来源（dynamicOptions）由宿主按名回答，另收一份
 */
function collectKeys(sources: Iterable<ts.SourceFile>) {
  const pages = new Set<string>();
  const actions = new Set<string>();
  const dataSources = new Set<string>();
  const settings = new Set<string>();
  const tools = new Set<string>();
  const schemaFields = new Set<string>();
  const optionSources = new Set<string>();
  const keysOf = (node: ts.Node | undefined, into: Set<string>) => {
    if (!node || !ts.isObjectLiteralExpression(node)) return;
    for (const property of node.properties) {
      const name = propertyName(property);
      if (name) into.add(name);
    }
  };
  for (const source of sources) {
    const constants = new Map<string, string>();
    visitAll(source, node => {
      const value = ts.isVariableDeclaration(node) ? literalText(node.initializer) : undefined;
      if (value !== undefined && ts.isIdentifier((node as ts.VariableDeclaration).name)) {
        constants.set((node as ts.VariableDeclaration).name.getText(), value);
      }
    });
    const textOf = (node: ts.Node | undefined) =>
      node && ts.isIdentifier(node) ? constants.get(node.text) : literalText(node);
    const visit = (node: ts.Node, inPage: boolean): void => {
      let page = inPage;
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'SessionConfig') {
        for (const member of node.members)
          if (member.name && ts.isIdentifier(member.name)) settings.add(member.name.text);
      }
      if (ts.isObjectLiteralExpression(node)) {
        const fields = new Map(
          node.properties.filter(ts.isPropertyAssignment).map(p => [propertyName(p), p.initializer] as const),
        );
        const key = textOf(fields.get('key'));
        if (!inPage && key && fields.has('title') && (fields.has('content') || fields.has('frame'))) {
          pages.add(key);
          page = true;
          keysOf(fields.get('actions'), actions);
          keysOf(fields.get('sources'), dataSources);
        }
        const tool = textOf(fields.get('name'));
        if (tool && fields.has('description') && fields.has('parameters')) tools.add(tool);
        const field = ts.isPropertyAssignment(node.parent) ? propertyName(node.parent) : undefined;
        if (field && /[^a-z]/.test(field) && ((fields.has('type') && fields.has('label')) || fields.has('fields'))) {
          schemaFields.add(field);
        }
        const optionSource = textOf(fields.get('dynamicOptions'));
        if (optionSource) optionSources.add(optionSource);
      }
      ts.forEachChild(node, child => visit(child, page));
    };
    visit(source, false);
  }
  return { pages, actions, dataSources, settings, tools, schemaFields, optionSources };
}

type Collected = ReturnType<typeof collectKeys>;

/** 一个包的源码 */
function* sourcesOf(pkg: string): Generator<ts.SourceFile> {
  const src = join(PACKAGES, pkg, 'src');
  if (existsSync(src)) for (const file of walk(src, /\.tsx?$/)) yield parse(file);
}

/** 各包（客户端自己除外）收集到的，按包目录名 */
const COLLECTED = new Map(
  readdirSync(PACKAGES)
    .filter(pkg => pkg !== 'plugin-webui-client')
    .map(pkg => [pkg, collectKeys(sourcesOf(pkg))] as const),
);

/** 各包收集到的某一类合在一起 */
const collected = (pick: (keys: Collected) => Set<string>) =>
  new Set([...COLLECTED.values()].flatMap(keys => [...pick(keys)]));

/** zod schema 的内部定义：只走到收集字段名要用的几种 */
interface SchemaNode {
  _def: { typeName: string; [key: string]: unknown };
}

/** 会话协议各方法、各推送的 schema 里出现的字段名 */
function protocolFields(): Set<string> {
  const names = new Set<string>();
  const visit = (schema: SchemaNode): void => {
    const def = schema._def;
    switch (def.typeName) {
      case 'ZodObject':
        for (const [name, field] of Object.entries((def.shape as () => Record<string, SchemaNode>)())) {
          names.add(name);
          visit(field);
        }
        return;
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion':
        for (const option of def.options as SchemaNode[]) visit(option);
        return;
      case 'ZodArray':
        visit(def.type as SchemaNode);
        return;
      case 'ZodRecord':
        visit(def.valueType as SchemaNode);
        return;
      case 'ZodOptional':
      case 'ZodNullable':
        visit(def.innerType as SchemaNode);
        return;
      case 'ZodEffects':
        visit(def.schema as SchemaNode);
        return;
    }
  };
  for (const { params, result } of Object.values(sessionMethods)) {
    visit(params as unknown as SchemaNode);
    visit(result as unknown as SchemaNode);
  }
  for (const params of Object.values(sessionNotifications)) visit(params as unknown as SchemaNode);
  return names;
}

/**
 * 插件前端消息的类型里出现的字段名：从握手与两个方向的消息联合出发，顺着同一文件里引用到的类型走（会话协议的部分
 * 已在协议的字段里）
 */
function frameFields(): Set<string> {
  const names = new Set<string>();
  const declarations = new Map<string, ts.Node>();
  const source = parse(join(PACKAGES, 'api-webui/src/frame.ts'));
  visitAll(source, node => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) declarations.set(node.name.text, node);
  });
  const seen = new Set<string>();
  const follow = (name: string): void => {
    const declaration = declarations.get(name);
    if (!declaration || seen.has(name)) return;
    seen.add(name);
    visitAll(declaration, node => {
      if (ts.isPropertySignature(node) && ts.isIdentifier(node.name)) names.add(node.name.text);
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) follow(node.typeName.text);
    });
  };
  for (const root of ['FrameHello', 'FrameMessage', 'FrameHostMessage']) follow(root);
  return names;
}

/** 管理面事件与前端消息的类型里出现的字段名 */
function adminFields(): Set<string> {
  const names = new Set<string>();
  visitAll(parse(join(PACKAGES, 'api-webui/src/index.ts')), node => {
    if (!ts.isTypeAliasDeclaration(node) || !['WebuiAdminEvent', 'WebuiAdminClientMessage'].includes(node.name.text)) {
      return;
    }
    visitAll(node.type, member => {
      if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) names.add(member.name.text);
    });
  });
  return names;
}

/** 契约包：插件与宿主之间的约定，按 package.json 的类型关键词认 */
const CONTRACT_KEYWORDS = ['aalis-api', 'aalis-schema', 'aalis-core'];

/** 宿主契约的词汇，按契约包：源码里的标识符与字符串字面量里的词，即服务名、事件名、字段名与取值 */
function contractWords(): Map<string, Set<string>> {
  const byPackage = new Map<string, Set<string>>();
  for (const pkg of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, pkg, 'package.json');
    const keywords: string[] = existsSync(manifest) ? (JSON.parse(read(manifest)).keywords ?? []) : [];
    if (!keywords.some(keyword => CONTRACT_KEYWORDS.includes(keyword))) continue;
    const words = new Set<string>();
    for (const source of sourcesOf(pkg)) {
      visitAll(source, node => {
        if (ts.isIdentifier(node)) words.add(node.text);
        for (const word of wordsIn(stringText(node) ?? '')) words.add(word);
      });
    }
    byPackage.set(pkg, words);
  }
  return byPackage;
}

// ----- 守卫 -----

describe('WebUI 客户端的写法', () => {
  it('扫描范围不空：源码、样式与首帧主题脚本都在', () => {
    expect(SCRIPTS.length).toBeGreaterThan(15);
    expect(STYLES.length).toBeGreaterThan(10);
    expect(SOURCES.map(rel)).toEqual(expect.arrayContaining([TOKEN_FILE, STORAGE_MODULE, THEME_SCRIPT, 'index.html']));
  });

  it('颜色只来自主题令牌：客户端源码里没有颜色字面量', () => {
    const hex = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i;
    const fn = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
    const named = /:\s*[^;{}]*\b(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver)\b/i;
    const hits = SOURCES.flatMap(file =>
      read(file)
        .split('\n')
        .map((line, index) => ({ line, at: `${rel(file)}:${index + 1}` }))
        .filter(({ line }) => hex.test(line) || fn.test(line) || (file.endsWith('.css') && named.test(line)))
        .map(({ at, line }) => `${at} ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it('组件样式不写 px，线宽 1px、2px 除外；尺寸、间距与圆角引用令牌', () => {
    const hits = STYLES.filter(file => rel(file) !== TOKEN_FILE).flatMap(file =>
      [...read(file).matchAll(/(\d*\.?\d+)px\b/g)]
        .filter(match => match[1] !== '1' && match[1] !== '2')
        .map(match => `${rel(file)} ${match[0]}`),
    );
    expect(hits).toEqual([]);
  });

  it('组件样式的字号与动画、过渡的时长只引用令牌（根字号的 100% 除外）', () => {
    const hits = STYLES.filter(file => rel(file) !== TOKEN_FILE).flatMap(file =>
      [...read(file).matchAll(/\b(font-size|animation|transition)\s*:\s*([^;}]+)/g)]
        .filter(([, property, value]) => {
          const literal = value.replace(/var\(--[\w-]+\)/g, '').trim();
          return property === 'font-size' ? /\d/.test(literal) && literal !== '100%' : /\d/.test(literal);
        })
        .map(match => `${rel(file)} ${match[0].trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it('内联 style 只设 CSS 变量', () => {
    const hits = findNodes(SCRIPTS, node => {
      if (!ts.isJsxAttribute(node) || node.name.getText() !== 'style') return false;
      const value = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
      const object = value && unwrap(value);
      return (
        !object ||
        !ts.isObjectLiteralExpression(object) ||
        object.properties.some(
          property =>
            !ts.isPropertyAssignment(property) ||
            !ts.isStringLiteral(property.name) ||
            !property.name.text.startsWith('--'),
        )
      );
    });
    expect(hits).toEqual([]);
  });

  it('不用原生的 alert、confirm、prompt 与 window.open', () => {
    const NATIVE = new Set(['alert', 'confirm', 'prompt']);
    const GLOBALS = new Set(['window', 'globalThis', 'self']);
    const hits = findNodes(SCRIPTS, node => {
      if (!ts.isCallExpression(node)) return false;
      const callee = node.expression;
      if (ts.isIdentifier(callee)) return NATIVE.has(callee.text);
      return (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        GLOBALS.has(callee.expression.text) &&
        (NATIVE.has(callee.name.text) || callee.name.text === 'open')
      );
    });
    expect(hits).toEqual([]);
  });

  it('不用原生的选择框：选择一律用能过滤、手机上从底部弹出的 Select 组件，样式里也没有 select 元素', () => {
    const hits = findNodes(
      SCRIPTS,
      node =>
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ['select', 'option', 'optgroup'].includes(node.tagName.getText()),
    );
    const styled = STYLES.filter(file =>
      /(^|[\s,(>+~])select\b(?![-\w])/m.test(read(file).replace(/\/\*[\s\S]*?\*\//g, '')),
    );
    expect([...hits, ...styled.map(rel)]).toEqual([]);
  });

  it('浏览器存储只经存储模块读写，首帧主题脚本除外', () => {
    const allowed = new Set([STORAGE_MODULE, THEME_SCRIPT]);
    const hits = findNodes(
      SCRIPTS.filter(file => !allowed.has(rel(file))),
      node => ts.isIdentifier(node) && (node.text === 'localStorage' || node.text === 'sessionStorage'),
    );
    expect(hits).toEqual([]);
  });

  it('不写死主机、端口与 WebSocket 地址：地址由页面所在的源推出；回环地址只出现在认本机网址的模块里', () => {
    const hits = SOURCES.flatMap(file =>
      [...(rel(file) === LOOPBACK_MODULE ? [] : LOOPBACK_HOSTS), 'ws://', 'wss://']
        .filter(text => read(file).includes(text))
        .map(text => `${rel(file)} ${text}`),
    );
    expect(hits).toEqual([]);
    const module = read(join(CLIENT, LOOPBACK_MODULE));
    expect(LOOPBACK_HOSTS.filter(host => !module.includes(host))).toEqual([]);
  });

  it('dangerouslySetInnerHTML 只出现在白名单里的文件，白名单的文件都在', () => {
    const hits = findNodes(
      SCRIPTS.filter(file => !DANGEROUS_HTML_FILES.has(rel(file))),
      node => ts.isJsxAttribute(node) && node.name.getText() === 'dangerouslySetInnerHTML',
    );
    expect(hits).toEqual([]);
    for (const file of DANGEROUS_HTML_FILES) expect(existsSync(join(CLIENT, file)), file).toBe(true);
  });
});

describe('WebUI 客户端只认契约不认插件', () => {
  const pages = collected(keys => keys.pages);
  const actions = collected(keys => keys.actions);
  const dataSources = collected(keys => keys.dataSources);
  const settings = collected(keys => keys.settings);
  const tools = collected(keys => keys.tools);
  const excluded = new Set([...protocolFields(), ...adminFields(), ...frameFields()]);

  it('收集到的登记与排除表不空：判据没有因为写法变化失效', () => {
    expect([...pages]).toEqual(expect.arrayContaining(['paper', 'paper-room', 'skills', 'doctor', 'uploads']));
    expect([...actions]).toEqual(
      expect.arrayContaining(['cancelTask', 'runDiagnostics', 'approveWork', 'deleteUpload']),
    );
    expect([...settings]).toEqual(expect.arrayContaining(['llm', 'persona', 'enabledToolGroups', 'paperEnabled']));
    expect([...tools]).toEqual(expect.arrayContaining(['exec', 'file_write', 'analyze_image']));
    expect([...excluded]).toEqual(
      expect.arrayContaining(['sessionId', 'epoch', 'seq', 'type', 'entry', 'nonce', 'target', 'tokens', 'code']),
    );
  });

  it('插件前端页面也按判据收集：带 key、title 与 frame 的对象是页面，动作名与数据源名取它的 actions 与 sources', () => {
    const declared = ts.createSourceFile(
      'zz-frame-page.ts',
      `const KEY = 'zz-board';
      webui.definePage({
        key: KEY,
        title: '看板',
        frame: { module: import.meta.url },
        sources: { zzCards: { data: () => [] }, 'zz-card': { data: () => null } },
        actions: { zzArchive: { label: '归档', effect: 'write', handler: () => undefined } },
      });`,
      ts.ScriptTarget.Latest,
      true,
    );
    const keys = collectKeys([declared]);
    expect([[...keys.pages], [...keys.actions], [...keys.dataSources]]).toEqual([
      ['zz-board'],
      ['zzArchive'],
      ['zzCards', 'zz-card'],
    ]);
  });

  it('客户端源码不出现插件包名', () => {
    const hits = SOURCES.filter(file => read(file).includes('@aalis/plugin-')).map(rel);
    expect(hits).toEqual([]);
  });

  it('客户端不依赖对话代理的契约：源码与 package.json 都不出现 api-agent，用量的分项名由条目给出', () => {
    const files = [...SOURCES, join(CLIENT, 'package.json')];
    expect(files.filter(file => read(file).includes('@aalis/api-agent')).map(rel)).toEqual([]);
  });

  it('字符串字面量不等于插件登记的页面键、动作名、数据源名、设置键或工具名', () => {
    const forbidden = new Map<string, string>();
    for (const key of pages) forbidden.set(key, '页面键');
    for (const name of actions) forbidden.set(name, '动作名');
    for (const name of dataSources) forbidden.set(name, '数据源名');
    for (const key of settings) forbidden.set(key, '设置键');
    for (const name of tools) forbidden.set(name, '工具名');
    const hits: string[] = [];
    for (const file of SCRIPTS) {
      const source = parse(file);
      visitAll(source, node => {
        const text = literalText(node);
        if (text === undefined || excluded.has(text) || !forbidden.has(text)) return;
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        hits.push(`${rel(file)}:${line} '${text}' 是${forbidden.get(text)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe('WebUI 服务端只认契约不认插件', () => {
  /** 守着的包：会话协议、webui-server（含框架托管与转发）与 session-server */
  const SCOPES = ['api-session-protocol', 'plugin-webui-server', 'plugin-session-server'];
  /** 协议的 schema：字段名也查 */
  const PROTOCOL = 'api-session-protocol';
  const PLUGINS = readdirSync(PACKAGES).filter(pkg => pkg.startsWith('plugin-'));
  const CONTRACT = contractWords();
  /** 守着的包能用的契约词汇：别的契约包里的（会话协议自己也是契约包，它的词不能给自己作证） */
  const contractFor = (scope: string) =>
    new Set([...CONTRACT].filter(([pkg]) => pkg !== scope).flatMap(([, words]) => [...words]));
  const optionSources = collected(keys => keys.optionSources);
  const filesOf = (scope: string) => [...walk(join(PACKAGES, scope, 'src'), /\.ts$/)];
  /** 一个包登记的全部词 */
  const registered = (pkg: string) => Object.values(COLLECTED.get(pkg) ?? {}).flatMap(words => [...words]);

  it('扫描范围不空：三个包的源码都在，含框架托管与转发的路由', () => {
    const files = SCOPES.flatMap(filesOf).map(file => relative(PACKAGES, file));
    expect(files).toEqual(
      expect.arrayContaining([
        'api-session-protocol/src/index.ts',
        'plugin-webui-server/src/routes/frames.ts',
        'plugin-webui-server/src/routes/pages.ts',
        'plugin-session-server/src/index.ts',
      ]),
    );
  });

  it('收集到的插件词汇、可选项来源与契约词汇不空：判据没有因为写法变化失效', () => {
    expect([...collected(keys => keys.tools)]).toEqual(
      expect.arrayContaining(['math_eval', 'file_read', 'http_request']),
    );
    expect([...collected(keys => keys.schemaFields)]).toEqual(
      expect.arrayContaining(['discoverModels', 'summaryLLM', 'numberTheory']),
    );
    expect([...optionSources]).toEqual(expect.arrayContaining(['toolGroups', 'gateway-scopes', 'llm-thinking']));
    expect([...contractFor(PROTOCOL)]).toEqual(expect.arrayContaining(['webui-client', 'skipArchive', 'sessionKind']));
    expect(contractFor(PROTOCOL).has('sessionProtocol')).toBe(false);
  });

  it('按判据收集：带 name、description 与 parameters 的是工具，带 type 与 label 的对象、带 fields 的分组是字段（单个小写词不收），dynamicOptions 是可选项来源', () => {
    const declared = ts.createSourceFile(
      'zz-tool.ts',
      `const TOOL = 'zz_lookup';
      const configSchema = defineConfig({
        zzLimits: { label: '上限', fields: { zzPerDay: { type: 'number', label: '每天' }, port: { type: 'number', label: '端口' } } },
        zzGroups: { type: 'multiselect', label: '分组', dynamicOptions: 'zzGroupSource' },
      });
      tools.register({ type: 'function', function: { name: TOOL, description: '查', parameters: { type: 'object' } } });`,
      ts.ScriptTarget.Latest,
      true,
    );
    const keys = collectKeys([declared]);
    expect([[...keys.tools], [...keys.schemaFields], [...keys.optionSources]]).toEqual([
      ['zz_lookup'],
      ['zzLimits', 'zzPerDay', 'zzGroups'],
      ['zzGroupSource'],
    ]);
  });

  it('源码、注释与 package.json 不出现别的插件的名字：包名，以及不是契约里的词的短名', () => {
    const hits: string[] = [];
    for (const scope of SCOPES) {
      const contract = contractFor(scope);
      const names = PLUGINS.filter(pkg => pkg !== scope).flatMap(pkg => {
        const short = pkg.slice('plugin-'.length);
        return contract.has(short) ? [pkg] : [pkg, short];
      });
      const patterns = names.map(name => [name, new RegExp(`(?<![\\w-])${name}(?![\\w-])`)] as const);
      for (const file of [...filesOf(scope), join(PACKAGES, scope, 'package.json')]) {
        read(file)
          .split('\n')
          .forEach((line, index) => {
            const hit = patterns.find(([, pattern]) => pattern.test(line));
            if (hit) hits.push(`${relative(ROOT, file)}:${index + 1} ${hit[0]}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });

  it('字符串字面量里的词（协议另加字段名）不是别的插件登记的工具名、设置键、字段名、页面键、动作名或数据源名', () => {
    const hits: string[] = [];
    for (const scope of SCOPES) {
      const allowed = new Set([...contractFor(scope), ...optionSources]);
      const owners = new Map<string, string>();
      for (const pkg of PLUGINS.filter(pkg => pkg !== scope)) {
        for (const word of registered(pkg)) if (!allowed.has(word)) owners.set(word, pkg);
      }
      for (const file of filesOf(scope)) {
        const source = parse(file);
        visitAll(source, node => {
          const text = stringText(node);
          const field =
            scope === PROTOCOL &&
            (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) &&
            (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
              ? node.name.text
              : undefined;
          for (const word of [...wordsIn(text ?? ''), ...(field ? [field] : [])]) {
            const owner = owners.get(word);
            if (!owner) continue;
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            hits.push(`${relative(ROOT, file)}:${line} '${word}' 是 ${owner} 登记的`);
          }
        });
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('插件前端的写法', () => {
  it('iframe、postMessage 与 MessageChannel 只出现在框架模块里，框架模块里都有', () => {
    const words = ['<iframe', 'postMessage', 'MessageChannel'];
    const hits = SCRIPTS.filter(file => !rel(file).startsWith(FRAME_MODULE)).flatMap(file =>
      words.filter(word => read(file).includes(word)).map(word => `${rel(file)} ${word}`),
    );
    expect(hits).toEqual([]);
    const module = SCRIPTS.filter(file => rel(file).startsWith(FRAME_MODULE))
      .map(read)
      .join('\n');
    expect(words.filter(word => !module.includes(word))).toEqual([]);
  });

  it('客户端与服务端的源码都不出现 allow-same-origin：框架的 sandbox 只取 FRAME_SANDBOX', () => {
    const server = [...walk(join(PACKAGES, 'plugin-webui-server', 'src'), /\.ts$/)];
    const hits = [...SOURCES, ...server]
      .filter(file => read(file).includes('allow-same-origin'))
      .map(file => relative(ROOT, file));
    expect(server.length).toBeGreaterThan(10);
    expect(hits).toEqual([]);
  });
});
