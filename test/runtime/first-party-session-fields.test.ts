import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { config, definePlugin, type PluginDefinition } from '../../packages/core/src/index.js';
import { type ConfigSchema, isSessionField } from '../../packages/schema-config/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// 声明了按会话字段的第一方插件：激活后 caps.config 上没有这些键，配置文档里写了也一样。插件只能经会话设置的读取器取它们。
// 每个插件换成同名、同一份 configSchema 的探针，与 runtime 一样按文档登记、经 core 激活，记下交给 apply 的 config：交出去的
// 配置只取决于名字、schema 与文档，探针不需要插件的其余依赖。名单写明是哪几个插件，免得扫描面塌了也照样绿。
// 这些插件的源码里都调了 fields(configSchema, …)：没调的插件读不到这些项，会话设置里也不列它们。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

/** 现在声明了按会话字段的第一方插件 */
const DECLARING = [
  '@aalis/plugin-agent',
  '@aalis/plugin-checkpoint',
  '@aalis/plugin-flow-control',
  '@aalis/plugin-i18n',
  '@aalis/plugin-memory-summary',
  '@aalis/plugin-memory-vector',
  '@aalis/plugin-persona',
  '@aalis/plugin-session-manager',
  '@aalis/plugin-skills',
  '@aalis/plugin-subtask',
  '@aalis/plugin-tools',
  '@aalis/plugin-trigger-laya',
  '@aalis/plugin-trigger-policy',
  '@aalis/plugin-user-relation',
];

/** 第一方插件里 configSchema 顶层写了 session 的：实例 id → 定义、带标记的键与包目录 */
async function declaring(): Promise<Map<string, { definition: PluginDefinition; keys: string[]; dir: string }>> {
  const out = new Map<string, { definition: PluginDefinition; keys: string[]; dir: string }>();
  for (const pkg of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, pkg, 'package.json');
    const entry = join(PACKAGES, pkg, 'src/index.ts');
    if (!existsSync(manifest) || !existsSync(entry)) continue;
    const meta = JSON.parse(readFileSync(manifest, 'utf-8')) as { keywords?: string[] };
    if (!meta.keywords?.includes('aalis-plugin')) continue;
    const definition = ((await import(entry)) as { default?: PluginDefinition }).default;
    const schema = (definition?.configSchema ?? {}) as ConfigSchema;
    const keys = Object.keys(schema).filter(key => isSessionField(schema[key]));
    if (definition && keys.length > 0) out.set(definition.name, { definition, keys, dir: join(PACKAGES, pkg) });
  }
  return out;
}

/** 经会话设置的门面取读取器的两个名字：读取门面与管理面（子任务插件） */
const FACADES = new Set(['sessionFields', 'sessionSettings']);

/** 源码里有没有 `<…>.sessionFields.use.fields(configSchema, …)`（或经 sessionSettings） */
function callsFields(file: string, source: string): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const facade = (node: ts.Expression) =>
    (ts.isIdentifier(node) && FACADES.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) && FACADES.has(node.name.text));
  const isCall = (node: ts.Node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'fields' &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.name.text === 'use' &&
    facade(node.expression.expression.expression) &&
    node.arguments[0] !== undefined &&
    ts.isIdentifier(node.arguments[0]) &&
    node.arguments[0].text === 'configSchema';
  const visit = (node: ts.Node): boolean => isCall(node) || (ts.forEachChild(node, visit) ?? false);
  return visit(sf);
}

/** 一个目录下的全部 .ts 源文件 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('第一方插件的按会话字段不进运行态配置', () => {
  it('配置文档里写了这些键，激活后 caps.config 上这些键都是 undefined', async () => {
    const found = await declaring();
    expect([...found.keys()].sort()).toEqual(DECLARING);
    for (const [id, { definition, keys }] of found) {
      const schema = definition.configSchema as ConfigSchema;
      const written = Object.fromEntries(
        keys.map(key => {
          const field = schema[key];
          return [key, 'default' in field ? field.default : '<写了的值>'];
        }),
      );
      const { app, store } = hostedApp({ plugins: { [id]: written } });
      let seen: Readonly<Record<string, unknown>> | undefined;
      const probe = definePlugin({
        name: id,
        configSchema: schema,
        uses: { config },
        apply: caps => {
          seen = caps.config.use;
        },
      });
      try {
        await registerFromDoc(app, store, probe);
        await app.plugins.idle();
      } finally {
        await app.stop();
      }
      expect(seen, `${id} 激活了`).toBeDefined();
      for (const key of keys) expect(seen?.[key], `${id}.${key}`).toBeUndefined();
    }
  }, 120_000);
});

describe('第一方插件的按会话声明', () => {
  it('适用全部会话种类的不写 appliesTo，只适用一部分时才写：同一个意思只有一种写法', async () => {
    for (const [id, { definition, keys }] of await declaring()) {
      const schema = definition.configSchema as ConfigSchema;
      for (const key of keys) {
        const kinds = (schema[key] as { session: { appliesTo?: readonly string[] } }).session.appliesTo;
        expect(kinds && [...kinds].sort(), `${id}.${key}`).not.toEqual(['owner', 'room', 'task']);
      }
    }
  }, 120_000);
});

describe('声明了按会话字段的第一方插件都调了 fields()', () => {
  it('每个插件的源码里都有 fields(configSchema, …)', async () => {
    const missing = [...(await declaring())]
      .filter(([, { dir }]) => !sources(join(dir, 'src')).some(file => callsFields(file, readFileSync(file, 'utf-8'))))
      .map(([id]) => id);
    expect(missing, '在 apply 里调 caps.sessionFields.use.fields(configSchema, caps) 拿读取器').toEqual([]);
  }, 120_000);

  it('认得读取门面与管理面、属性访问与解构出的门面；别的方法、别的 schema 不算', () => {
    const yes = [
      'const f = caps.sessionFields.use.fields(configSchema, caps);',
      'register(caps.sessionSettings.use.fields(configSchema, caps));',
      'const { sessionFields } = caps; sessionFields.use.fields(configSchema, { config, document });',
    ];
    const no = [
      'caps.sessionFields.use.getAll();',
      'caps.sessionFields.use.fields(otherSchema, caps);',
      'caps.other.use.fields(configSchema, caps);',
      '// caps.sessionFields.use.fields(configSchema, caps)',
    ];
    expect(yes.map(src => callsFields('x.ts', src))).toEqual(yes.map(() => true));
    expect(no.map(src => callsFields('x.ts', src))).toEqual(no.map(() => false));
  });
});
