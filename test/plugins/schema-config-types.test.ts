import { describe, expect, it } from 'vitest';
import { runTscProbe } from '../helpers/tsc-probe.js';

// ════════════════════════════════════════════════════════════
// defineConfig 的 const 推导与 ConfigOf 推出的配置值类型。
//
// 负向用例不能放进 test/（test-types 绊线要求零错），故写到临时目录、spawn tsc、断言错误落点。
// 负向探针由正向夹具追加错误行而成：正向夹具零错即「去掉错误就能编过」，防恒真。
// ════════════════════════════════════════════════════════════

const GOOD = `import { config, definePlugin, logger } from '@aalis/core';
import type { ModelRef } from '@aalis/api-llm';
import {
  CORE_CONFIG_SCHEMA,
  type ConfigOf,
  type ConfigSchema,
  type SchemaField,
  defineConfig,
  parseConfig,
} from '@aalis/schema-config';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): void {}

const LEVELS = ['low', 'high'] as const;

const configSchema = defineConfig({
  name: { type: 'string', label: '名称', default: 'x' },
  token: { type: 'string', label: '口令', required: true },
  note: { type: 'textarea', label: '备注' },
  port: { type: 'number', label: '端口', default: 8080 },
  // default 写成 undefined 等于没有默认值（parseConfig 按未声明处理），仍是可选
  retries: { type: 'number', label: '重试', default: undefined },
  debug: { type: 'boolean', label: '调试' },
  mode: {
    type: 'select',
    label: '模式',
    default: 'a',
    options: [
      { label: 'A', value: 'a' },
      { label: '二', value: 2 },
    ],
  },
  level: { type: 'select', label: '档位', default: 'low', options: LEVELS.map(v => ({ label: v, value: v })) },
  free: { type: 'select', label: '无选项' },
  pick: { type: 'select', label: '补全', allowCustom: true, options: [{ label: '自动', value: '' }] },
  model: { type: 'select', label: '动态', dynamicOptions: 'embedding', options: [{ label: 'A', value: 'a' }] },
  tags: { type: 'multiselect', label: '标签', default: [], options: [{ label: 'A', value: 'a' }] },
  hosts: { type: 'multiselect', label: '主机', allowCustom: true, options: [{ label: 'A', value: 'a' }] },
  groups: { type: 'multiselect', label: '分组', dynamicOptions: 'toolGroups' },
  args: { type: 'list', label: '参数', default: [] },
  env: { type: 'map', label: '环境变量' },
  llm: { type: 'llm-ref', label: '模型' },
  audio: {
    label: '音频',
    fields: {
      prefer: { type: 'select', label: '后端', options: [{ label: '自动', value: '' }], default: '' },
      think: { type: 'boolean', label: '思考' },
    },
  },
  servers: {
    type: 'array',
    label: '服务',
    default: [],
    items: {
      id: { type: 'string', label: 'ID', required: true },
      port: { type: 'number', label: '端口' },
    },
  },
  jobs: { type: 'array', label: '任务', items: { name: { type: 'string', label: '名称' } } },
});

type Config = ConfigOf<typeof configSchema>;
assertType<
  Equal<
    Config,
    {
      name: string;
      token: string;
      port: number;
      mode: 'a' | 2;
      level: 'low' | 'high';
      tags: 'a'[];
      args: string[];
      audio: { prefer: ''; think?: boolean | undefined };
      servers: { id: string; port?: number | undefined }[];
      note?: string | undefined;
      retries?: number | undefined;
      debug?: boolean | undefined;
      free?: string | undefined;
      pick?: string | undefined;
      model?: string | undefined;
      hosts?: string[] | undefined;
      groups?: string[] | undefined;
      env?: Record<string, string> | undefined;
      llm?: ModelRef | undefined;
      jobs?: { name?: string | undefined }[] | undefined;
    }
  >
>();

// 返回值可赋给 ConfigSchema 与 PluginMeta.configSchema；parseConfig 的返回类型即 ConfigOf，可改写
const asSchema: ConfigSchema = configSchema;
void asSchema;
export default definePlugin({
  name: 'probe-schema-config',
  configSchema,
  uses: { config, logger },
  apply({ config, logger }) {
    const cfg = parseConfig(configSchema, config, logger);
    assertType<Equal<typeof cfg, Config>>();
    cfg.port = Math.max(1, cfg.port);
    cfg.args.push('-v');
  },
});

// 运行时改写 options（WebUI 读的是这个活对象）：经 ConfigSchema / SchemaField 类型的引用
const live: ConfigSchema = configSchema;
const group = live.audio;
if (group && 'fields' in group && group.fields.prefer) {
  group.fields.prefer.options = [{ label: '自动', value: '' }, ...['whisper'].map(p => ({ label: p, value: p }))];
}
const prefer: SchemaField = configSchema.audio.fields.prefer;
prefer.options?.push({ label: 'asr', value: 'asr' });

// 宽类型 schema 照常可用
const core = parseConfig(CORE_CONFIG_SCHEMA, {});
void core.name;
`;

const BAD_LINES = [
  "const badLiteral: Config['mode'] = 'z'; // BAD-NARROW",
  'declare const parsed: Config; const badOptional: number = parsed.note.length; // BAD-OPTIONAL',
  "configSchema.audio.fields.prefer.options = [{ label: 'y', value: 'other' }]; // BAD-READONLY",
  "defineConfig({ x: { type: 'nope', label: 'X' } }); // BAD-TYPE",
];
const BAD = `${GOOD}\n${BAD_LINES.join('\n')}\n`;

function lineOf(source: string, marker: string): number {
  return source.split('\n').findIndex(l => l.includes(marker)) + 1;
}

describe('defineConfig / ConfigOf 类型', () => {
  it('正向：字面量保留、ConfigOf 推导、可赋给 ConfigSchema 与 PluginMeta.configSchema、经宽类型引用改写 options', () => {
    const errs = runTscProbe(GOOD);
    expect(errs, `合法声明必须放行，实际：${errs.join('\n') || '（零错误）'}`).toEqual([]);
  });

  it('负向：选项外的字面量、未判空的可选字段、直接改写推出的只读属性、未登记的字段类型各报一条', () => {
    const errs = runTscProbe(BAD);
    expect(errs, `应恰好四条错误，实际：\n${errs.join('\n')}`).toHaveLength(BAD_LINES.length);
    for (const marker of ['BAD-NARROW', 'BAD-OPTIONAL', 'BAD-READONLY', 'BAD-TYPE']) {
      const line = lineOf(BAD, marker);
      expect(
        errs.some(e => e.includes(`fixture.ts(${line},`)),
        `${marker} 应报错：\n${errs.join('\n')}`,
      ).toBe(true);
    }
  });
});
