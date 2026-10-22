import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, definePlugin, type PluginDefinition } from '../../packages/core/src/index.js';
import { type ConfigSchema, isSessionField } from '../../packages/schema-config/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// 声明了按会话字段的第一方插件：激活后 caps.config 上没有这些键，配置文档里写了也一样。插件只能经会话设置的读取器取它们。
// 每个插件换成同名、同一份 configSchema 的探针，与 runtime 一样按文档登记、经 core 激活，记下交给 apply 的 config：交出去的
// 配置只取决于名字、schema 与文档，探针不需要插件的其余依赖。名单写明是哪几个插件，免得扫描面塌了也照样绿。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

/** 现在声明了按会话字段的第一方插件 */
const DECLARING = [
  '@aalis/plugin-agent',
  '@aalis/plugin-flow-control',
  '@aalis/plugin-i18n',
  '@aalis/plugin-memory-history',
  '@aalis/plugin-memory-summary',
  '@aalis/plugin-memory-vector',
  '@aalis/plugin-paper',
  '@aalis/plugin-persona',
  '@aalis/plugin-skills',
  '@aalis/plugin-subtask',
  '@aalis/plugin-tool-session',
  '@aalis/plugin-tools',
  '@aalis/plugin-trigger-laya',
  '@aalis/plugin-trigger-policy',
  '@aalis/plugin-user-relation',
];

/** 第一方插件里 configSchema 顶层写了 session 的：实例 id → 带标记的键 */
async function declaring(): Promise<Map<string, { definition: PluginDefinition; keys: string[] }>> {
  const out = new Map<string, { definition: PluginDefinition; keys: string[] }>();
  for (const pkg of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, pkg, 'package.json');
    const entry = join(PACKAGES, pkg, 'src/index.ts');
    if (!existsSync(manifest) || !existsSync(entry)) continue;
    const meta = JSON.parse(readFileSync(manifest, 'utf-8')) as { keywords?: string[] };
    if (!meta.keywords?.includes('aalis-plugin')) continue;
    const definition = ((await import(entry)) as { default?: PluginDefinition }).default;
    const schema = (definition?.configSchema ?? {}) as ConfigSchema;
    const keys = Object.keys(schema).filter(key => isSessionField(schema[key]));
    if (definition && keys.length > 0) out.set(definition.name, { definition, keys });
  }
  return out;
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
