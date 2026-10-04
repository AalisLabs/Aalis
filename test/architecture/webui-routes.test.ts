import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { contractRoutes } from '../helpers/webui-contract.js';

// ════════════════════════════════════════════════════════════
// 管理面 REST 的路由登记守卫：路由一律经 route() 登记，键就是契约（api-webui 的 rest.ts）里的键，处理函数的回应在编译期按契约核；
// 直接在 express 上登记带路径的只许是挂载（use 带路径）。实际登记的路由与契约的路由表逐条对上，由
// test/plugins/webui-rest-contract.test.ts 在启动时记下真实的登记来核。
// 宿主给框架的公用文件在 /frames/_base/ 下，由插件前端的挂载托管，契约里逐个列出，与 api-webui 随包带的文件对上。
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');
const SERVER = join(ROOT, 'packages/plugin-webui-server/src');
/** api-webui 给框架的公用文件的源：.ts 编译成 .js，样式原样复制 */
const FRAME_BASE = join(ROOT, 'packages/api-webui/frame');
const BASE_PREFIX = 'GET /frames/_base/';
/** express 上登记路由的方法 */
const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.ts')) yield full;
  }
}

const literalText = (node: ts.Node | undefined) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

/** route() 的键，以及收不了的写法 */
function registrations(): { keys: string[]; problems: string[] } {
  const keys: string[] = [];
  const problems: string[] = [];
  for (const file of walk(SERVER)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const where = `${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const [first, second] = node.arguments;
        if (ts.isIdentifier(node.expression) && node.expression.text === 'route') {
          const key = literalText(second);
          if (key === undefined) problems.push(`${where} route() 的键不是字符串字面量`);
          else keys.push(key);
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const path = literalText(first);
          if (path !== undefined && /^[/{]/.test(path) && VERBS.has(method)) {
            problems.push(`${where} 直接在 express 上登记 ${method} ${path}，要经 route()`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys, problems };
}

describe('管理面 REST 的路由登记', () => {
  const contract = contractRoutes();
  const declared = [...contract.json, ...contract.file];
  const { keys, problems } = registrations();

  it('收集判据不空：契约两张表与 route() 的登记都收到了', () => {
    expect(contract.json.length).toBeGreaterThan(30);
    expect(contract.file.length).toBeGreaterThan(5);
    expect(keys).toContain('GET /api/plugins');
    expect(keys).toContain('POST /api/auth/login');
  });

  it('路由一律经 route() 登记，键是字符串字面量；直接在 express 上登记的只有挂载', () => {
    expect(problems).toEqual([]);
  });

  it('契约里同一个键只列一次', () => {
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('/frames/_base/ 下列出的就是 api-webui 随包带的公用文件', () => {
    const shipped = readdirSync(FRAME_BASE)
      .filter(name => /\.(ts|css)$/.test(name))
      .map(name => `${BASE_PREFIX}${name.replace(/\.ts$/, '.js')}`);
    expect(declared.filter(key => key.startsWith(BASE_PREFIX)).sort()).toEqual(shipped.sort());
  });
});
