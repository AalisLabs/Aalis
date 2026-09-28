import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditRawConfig, readPluginSources } from '../helpers/raw-config-audit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'test/architecture/__raw-config-fixture.ts');
const prelude = `
import { config as rawDescriptor, definePlugin, type BoundOf } from '@aalis/core';
import { parseConfig as read } from '@aalis/schema-config';
import type { HostConfig } from '@aalis/api-host-config';
const uses = { config: rawDescriptor };
type Caps = BoundOf<typeof uses>;
const aliasedUses = { settings: rawDescriptor };
type AliasCaps = BoundOf<typeof aliasedUses>;
const schema = { token: { type: 'string', label: 'Token' } } as const;
const helper = (_value: unknown) => {};
declare const hostConfig: Pick<HostConfig, 'getPluginConfig'>;
`;

const fixture = (body: string) => auditRawConfig(ROOT, [FIXTURE], new Map([[FIXTURE, `${prelude}\n${body}`]]));

describe('插件原始 config 读取守卫', () => {
  it('识别解析器别名与解构别名；解析结果和 HostConfig 文档读取可自由使用', () => {
    const result = fixture(`
      function run(caps: Caps) {
        const { config: settings } = caps;
        const config = read(schema, settings);
        helper(config.token);
        const document = hostConfig.getPluginConfig('instance');
        helper(document.token);
      }
      function direct(caps: Caps) { const parsed = read(schema, caps.config); helper(parsed.token); }
    `);
    expect(result.violations).toEqual([]);
    expect(result.rawSites).toBe(2);
    expect(result.parseCalls).toBe(2);
  });

  it.each([
    ['属性读取', 'function run(caps: Caps) { helper(caps.config.token); }'],
    ['方括号读取', "function run(caps: Caps) { helper(caps['config'].token); }"],
    ['解构后读取', 'function run(caps: Caps) { const {config: settings}=caps; helper(settings.token); }'],
    [
      '原始值断言',
      'function run(caps: Caps) { const {config: settings}=caps; helper(settings as Record<string, unknown>); }',
    ],
    ['传给 helper', 'function run(caps: Caps) { const {config: settings}=caps; helper(settings); }'],
    ['别名变量', 'function run(caps: Caps) { const raw=caps.config; read(schema, raw); }'],
    ['仿冒解析器', 'function run(caps: Caps) { const other={parseConfig:helper}; other.parseConfig(caps.config); }'],
    ['参数解构', 'function run({config: settings}: Caps) { helper(settings.token); }'],
    ['uses 属性别名', 'function run(caps: AliasCaps) { helper(caps.settings.token); }'],
    ['uses 属性解构', 'function run({settings: input}: AliasCaps) { helper(input.token); }'],
    [
      '解析器局部遮蔽',
      'function run(caps: Caps) { const read=(_schema:unknown,_raw:unknown)=>{}; read(schema,caps.config); }',
    ],
    [
      '解析器参数遮蔽',
      'function run(caps: Caps, read: (schema:unknown,raw:unknown)=>void) { read(schema,caps.config); }',
    ],
    [
      '显式 helper 签名',
      'function inspect(input:{config:Readonly<Record<string,unknown>>}) { helper(input.config.token); } function run(caps: Caps) { inspect(caps); }',
    ],
    [
      '显式插件 apply 签名',
      'interface ExplicitCaps { settings: Readonly<Record<string,unknown>> } function run(input:ExplicitCaps) { helper(input.settings.token); } definePlugin({name:"probe",uses:{settings:rawDescriptor},apply:run});',
    ],
  ])('%s 会报告原始读取', (_name, body) => {
    const result = fixture(body);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('扫描第一方插件源码，并统计已解析的绑定，避免空目录误绿', () => {
    const files = readPluginSources(ROOT);
    const result = auditRawConfig(ROOT, files);
    expect(result.files).toBeGreaterThan(150);
    expect(result.parseCalls).toBeGreaterThan(40);
    expect(result.rawSites).toBeGreaterThan(40);
    expect(result.violations).toEqual([]);
  });
});
