import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ROOM_SETTINGS } from '../../packages/plugin-paper/src/rooms.js';

// ════════════════════════════════════════════════════════════
// 每个值只有一个入口：同一个插件既登记某个会话设置项、又在插件配置里放同名的键，同一个值就有两处能改（会话设置分层、
// 插件配置一份），改了一处另一处照样起作用。会话设置项的默认值写在登记里，不取插件配置。
//
// 按语法树查 packages/*/src，测试不在其列：
// - 插件配置的键：`defineConfig({ ... })` 对象字面量的顶层键；
// - 登记的设置项的键：本包里形如 `{ key: '<键>', field: { ... } }` 的对象字面量，以及 `registerSetting(<常量>)` 传入的、
//   在别的包里定义的设置项常量（如 api-memory 的召回范围）；经辅助函数生成、字面上没有键的（plugin-paper 的六项），
//   直接取包导出的定义（GENERATED）。
// 第三方插件靠插件作者指南写明，不做运行时检查。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

interface PackageKeys {
  config: Set<string>;
  settings: Set<string>;
  /** `registerSetting(<常量>)` 传入的常量名 */
  registered: Set<string>;
}

const nameOf = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/** 设置项形状的对象字面量的键：同时有字符串字面量的 key 与 field */
function settingKey(node: ts.ObjectLiteralExpression): string | undefined {
  let key: string | undefined;
  let field = false;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = nameOf(property.name);
    if (name === 'key' && ts.isStringLiteral(property.initializer)) key = property.initializer.text;
    if (name === 'field') field = true;
  }
  return field ? key : undefined;
}

/** 扫一个源文件：键记进本包，设置项常量（`const X = { key, field }`）记进全仓的常量表 */
function scanFile(fileName: string, text: string, keys: PackageKeys, constants: Map<string, string>): void {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      const [arg] = node.arguments;
      if (name === 'defineConfig' && arg && ts.isObjectLiteralExpression(arg)) {
        for (const property of arg.properties) {
          const key = property.name && nameOf(property.name);
          if (key) keys.config.add(key);
        }
      }
      if (name === 'registerSetting' && arg && ts.isIdentifier(arg)) keys.registered.add(arg.text);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const key = settingKey(node);
      if (key !== undefined) {
        keys.settings.add(key);
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          constants.set(node.parent.name.text, key);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** 经辅助函数生成、语法树里扫不出键的设置项：包 → 它导出的定义 */
const GENERATED: Record<string, ReadonlyArray<{ key: string }>> = { 'plugin-paper': ROOM_SETTINGS };

/** 每个包里插件配置与登记的设置项同名的键：`包 键` */
function sameNameKeys(packages: Map<string, Array<[file: string, text: string]>>): string[] {
  const constants = new Map<string, string>();
  const scanned = new Map<string, PackageKeys>();
  for (const [pkg, files] of packages) {
    const keys: PackageKeys = { config: new Set(), settings: new Set(), registered: new Set() };
    for (const [file, text] of files) scanFile(file, text, keys, constants);
    scanned.set(pkg, keys);
  }
  return [...scanned].flatMap(([pkg, keys]) => {
    const settings = new Set([...keys.settings, ...(GENERATED[pkg] ?? []).map(setting => setting.key)]);
    for (const name of keys.registered) {
      const key = constants.get(name);
      if (key !== undefined) settings.add(key);
    }
    return [...keys.config].filter(key => settings.has(key)).map(key => `${pkg} ${key}`);
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('会话设置项与插件配置不同名', () => {
  it('判据本身：本包登记的与别的包里定义、本包登记的都算；不同包之间、插件配置分组里的键不算', () => {
    const probe = new Map<string, Array<[string, string]>>([
      [
        'api-shared',
        [['shared.ts', "export const SHARED_SETTING: SessionSetting = { key: 'scope', field: { type: 'string' } };"]],
      ],
      [
        'plugin-a',
        [
          [
            'index.ts',
            [
              "const configSchema = defineConfig({ limit: { type: 'number', label: 'L' }, scope: { type: 'string', label: 'S' },",
              "  group: { label: 'G', fields: { mode: { type: 'string', label: 'M' } } } });",
              "const settings = (limit: number): SessionSetting[] => [{ key: 'limit', field: { type: 'number', default: limit } }];",
              'for (const setting of settings(cfg.limit)) caps.sessionManager.registerSetting(setting);',
              'sessionManager.registerSetting(SHARED_SETTING);',
              "caps.sessionManager.registerSetting({ key: 'mode', field: { type: 'string' } });",
            ].join('\n'),
          ],
        ],
      ],
      ['plugin-b', [['index.ts', "const configSchema = defineConfig({ mode: { type: 'string', label: 'M' } });"]]],
    ]);
    expect(sameNameKeys(probe)).toEqual(['plugin-a limit', 'plugin-a scope']);
  });

  const packages = new Map<string, Array<[string, string]>>();
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const src = join(ROOT, 'packages', pkg, 'src');
    if (existsSync(src))
      packages.set(
        pkg,
        sourceFiles(src).map(file => [file, readFileSync(file, 'utf8')]),
      );
  }

  it('第一方插件没有同名的键', () => {
    expect(sameNameKeys(packages)).toEqual([]);
  });

  it('守卫没扫空：本包字面量登记的、登记别的包里定义的常量的、经辅助函数生成的，都认得出来', () => {
    const probed = new Map(packages);
    for (const [pkg, key] of [
      ['plugin-persona', 'persona'],
      ['plugin-agent', 'maxToolIterations'],
      ['plugin-memory-history', 'memoryRecallScope'],
      ['plugin-paper', 'paperEnabled'],
    ]) {
      probed.set(pkg, [
        ...(packages.get(pkg) ?? []),
        ['probe.ts', `defineConfig({ ${key}: { type: 'string', label: 'P' } });`],
      ]);
    }
    expect(sameNameKeys(probed)).toEqual(
      expect.arrayContaining([
        'plugin-persona persona',
        'plugin-agent maxToolIterations',
        'plugin-memory-history memoryRecallScope',
        'plugin-paper paperEnabled',
      ]),
    );
  });
});
