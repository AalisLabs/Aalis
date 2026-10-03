import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sessionMethods, sessionNotifications } from '../../packages/api-session-protocol/src/index.js';

// ════════════════════════════════════════════════════════════
// WebUI 客户端的写法守卫：
// - 兼容与写法：颜色只来自主题令牌，组件 CSS 不写 px（线宽 1px、2px 除外），字号与时长只引用令牌，内联 style 只设 CSS 变量，
//   不用原生对话框与 window.open，浏览器存储只经存储模块（首帧主题脚本除外），不写死主机与端口，
//   dangerouslySetInnerHTML 只许出现在白名单里的文件；
// - 只认契约不认插件：不出现插件包名，字符串字面量不等于任何插件登记的页面键、动作名或设置键。
//   与会话协议、管理面事件里的字段同名的不查，这份排除表从 schema 与类型定义算出。
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
/** 可以用 dangerouslySetInnerHTML 的文件：只给 Mermaid 渲染组件（输出经严格安全级别） */
const DANGEROUS_HTML_FILES = new Set<string>(['src/markdown/Mermaid.tsx']);

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

// ----- 插件登记的页面键、动作名与设置键 -----

/**
 * 从全部插件的源码收集：页面键取页面声明（带 key、title 与 content 的对象，标签不算）的 key，key 写成本文件里的字符串常量
 * 时取常量的值；动作名取页面声明的 actions 对象的键；设置键取各包对 SessionConfig 的扩展（登记的键必须是 SessionConfig 的键）
 */
function registeredKeys() {
  const pages = new Set<string>();
  const actions = new Set<string>();
  const settings = new Set<string>();
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src');
    if (pkg === 'plugin-webui-client' || !existsSync(src)) continue;
    for (const file of walk(src, /\.tsx?$/)) {
      const source = parse(file);
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
        if (!inPage && ts.isObjectLiteralExpression(node)) {
          const fields = new Map(
            node.properties.filter(ts.isPropertyAssignment).map(p => [propertyName(p), p.initializer] as const),
          );
          const key = textOf(fields.get('key'));
          if (key && fields.has('title') && fields.has('content')) {
            pages.add(key);
            page = true;
            const declared = fields.get('actions');
            if (declared && ts.isObjectLiteralExpression(declared)) {
              for (const property of declared.properties) actions.add(propertyName(property) ?? '');
            }
          }
        }
        ts.forEachChild(node, child => visit(child, page));
      };
      visit(source, false);
    }
  }
  actions.delete('');
  return { pages, actions, settings };
}

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

  it('浏览器存储只经存储模块读写，首帧主题脚本除外', () => {
    const allowed = new Set([STORAGE_MODULE, THEME_SCRIPT]);
    const hits = findNodes(
      SCRIPTS.filter(file => !allowed.has(rel(file))),
      node => ts.isIdentifier(node) && (node.text === 'localStorage' || node.text === 'sessionStorage'),
    );
    expect(hits).toEqual([]);
  });

  it('不写死主机、端口与 WebSocket 地址：地址由页面所在的源推出', () => {
    const hits = SOURCES.flatMap(file =>
      ['localhost', '127.0.0.1', 'ws://', 'wss://']
        .filter(text => read(file).includes(text))
        .map(text => `${rel(file)} ${text}`),
    );
    expect(hits).toEqual([]);
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
  const { pages, actions, settings } = registeredKeys();
  const excluded = new Set([...protocolFields(), ...adminFields()]);

  it('收集到的登记与排除表不空：判据没有因为写法变化失效', () => {
    expect([...pages]).toEqual(expect.arrayContaining(['paper', 'paper-room', 'skills', 'doctor', 'uploads']));
    expect([...actions]).toEqual(
      expect.arrayContaining(['cancelTask', 'runDiagnostics', 'approveWork', 'deleteUpload']),
    );
    expect([...settings]).toEqual(expect.arrayContaining(['llm', 'persona', 'enabledToolGroups', 'paperEnabled']));
    expect([...excluded]).toEqual(expect.arrayContaining(['sessionId', 'epoch', 'seq', 'type', 'entry']));
  });

  it('客户端源码不出现插件包名', () => {
    const hits = SOURCES.filter(file => read(file).includes('@aalis/plugin-')).map(rel);
    expect(hits).toEqual([]);
  });

  it('字符串字面量不等于插件登记的页面键、动作名或设置键', () => {
    const forbidden = new Map<string, string>();
    for (const key of pages) forbidden.set(key, '页面键');
    for (const name of actions) forbidden.set(name, '动作名');
    for (const key of settings) forbidden.set(key, '设置键');
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
