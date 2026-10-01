import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 第一方插件的配置字段，名字像凭据的必须显式声明 `secret`
//
// `secret: true` 决定值存进 secrets.yaml、WebUI 不回显；漏标的凭据会以明文留在配置文件里、经 WebUI 读接口回到浏览器。
// 名字像凭据却不是凭据的（如 memoryTokenBudget）写 `secret: false`，表明判断过。
// 判据：camelCase 拆词后含 key、token、secret、password、passphrase、credential(s)、apikey 之一，或字段名就是 uri
// （连接串可能带账号密码）。字段形状按「对象字面量里同时有 type 与 label」认，工具参数的 JSON Schema 没有 label，不在其列。
// 名字看不出来的凭据（如 mcp-client 的 env）靠逐个判断，不在这道闸里。
// ════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../..');
const CREDENTIAL_WORDS = new Set([
  'key',
  'token',
  'secret',
  'password',
  'passphrase',
  'credential',
  'credentials',
  'apikey',
]);

function looksLikeCredential(name: string): boolean {
  if (name === 'uri') return true;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/);
  return words.some(word => CREDENTIAL_WORDS.has(word));
}

/** 名字像凭据、却没写 secret 的配置字段：`文件:行 字段名` */
function undeclaredCredentialFields(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      const keys = new Set(
        node.initializer.properties.flatMap(p =>
          ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : [],
        ),
      );
      if (name && keys.has('type') && keys.has('label') && looksLikeCredential(name) && !keys.has('secret')) {
        out.push(`${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) yield path;
  }
}

describe('第一方配置字段的 secret 声明', () => {
  it('判据本身：漏标的凭据报出来，显式写了 secret（true 或 false）的、不像凭据的、没有 label 的不报', () => {
    const source = `const s = {
      apiKey: { type: 'string', label: 'K' },
      fixedToken: { type: 'string', label: 'T', secret: true },
      maxTokens: { type: 'number', label: 'M' },
      memoryTokenBudget: { type: 'number', label: 'B', secret: false },
      uri: { type: 'string', label: 'U' },
      skillsUri: { type: 'string', label: 'S' },
      token: { type: 'string', description: 'tool param' },
    };`;
    expect(undeclaredCredentialFields('x.ts', source)).toEqual(['x.ts:2 apiKey', 'x.ts:6 uri']);
  });

  it('packages/*/src 里没有漏标的', () => {
    const missing: string[] = [];
    let scanned = 0;
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        scanned++;
        missing.push(...undeclaredCredentialFields(relative(ROOT, file), readFileSync(file, 'utf-8')));
      }
    }
    expect(scanned, '扫描范围不能是空的').toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
