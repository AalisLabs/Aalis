import { describe, expect, it } from 'vitest';
import { type ConfigSchema, defaultsFrom } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// defaultsFrom：configSchema 是插件配置的唯一声明来源，默认值全部由此派生。
// 派生规则一旦漂移，49 个包的首启配置与 yaml 回填会一起歪，所以单独钉住。
// ════════════════════════════════════════════════════════════
describe('defaultsFrom 派生规则', () => {
  it('平面字段取 default；没写 default 的不产出键', () => {
    const schema: ConfigSchema = {
      a: { type: 'number', label: 'A', default: 5 },
      b: { type: 'string', label: 'B' },
    };
    expect(defaultsFrom(schema)).toEqual({ a: 5 });
  });

  it('SchemaGroup 递归 fields，总是产出嵌套对象', () => {
    const schema: ConfigSchema = {
      g: {
        label: 'G',
        fields: { x: { type: 'boolean', label: 'X', default: true }, y: { type: 'string', label: 'Y' } },
      },
      empty: { label: 'E', fields: {} },
    };
    expect(defaultsFrom(schema)).toEqual({ g: { x: true }, empty: {} });
  });

  it('SchemaArray 取 default 数组', () => {
    const schema: ConfigSchema = {
      list: { type: 'array', label: 'L', items: { k: { type: 'string', label: 'K' } }, default: [{ k: 'v' }] },
    };
    expect(defaultsFrom(schema)).toEqual({ list: [{ k: 'v' }] });
  });

  it('undefined / 空 schema 产出空对象', () => {
    expect(defaultsFrom(undefined)).toEqual({});
    expect(defaultsFrom({})).toEqual({});
  });

  it('default 显式为 falsy 值（0 / false / 空串 / 空数组）也如实产出', () => {
    const schema: ConfigSchema = {
      n: { type: 'number', label: 'N', default: 0 },
      b: { type: 'boolean', label: 'B', default: false },
      s: { type: 'string', label: 'S', default: '' },
      l: { type: 'multiselect', label: 'L', default: [] },
    };
    expect(defaultsFrom(schema)).toEqual({ n: 0, b: false, s: '', l: [] });
  });

  it('array / object default 返回拷贝，改派生结果不写脏 schema', () => {
    const hosts = ['localhost'];
    const job = { k: 'v' };
    const extra = { host: '127.0.0.1' };
    const schema: ConfigSchema = {
      hosts: { type: 'multiselect', label: 'H', default: hosts },
      list: { type: 'array', label: 'L', items: { k: { type: 'string', label: 'K' } }, default: [job] },
      extra: { type: 'textarea', label: 'E', default: extra },
    };
    const derived = defaultsFrom(schema) as {
      hosts: string[];
      list: Array<{ k: string }>;
      extra: { host: string };
    };
    derived.hosts.push('injected');
    derived.list[0].k = 'mutated';
    derived.list.push({ k: 'x' });
    derived.extra.host = 'mutated';
    expect(hosts).toEqual(['localhost']);
    expect(job).toEqual({ k: 'v' });
    expect(extra).toEqual({ host: '127.0.0.1' });
    expect(defaultsFrom(schema)).toEqual({
      hosts: ['localhost'],
      list: [{ k: 'v' }],
      extra: { host: '127.0.0.1' },
    });
  });

  it('非纯对象 default 保引用（Date 不被拆成普通对象）', () => {
    const stamp = new Date('2020-01-01');
    const schema: ConfigSchema = {
      stamp: { type: 'string', label: 'S', default: stamp },
    };
    expect(defaultsFrom(schema).stamp).toBe(stamp);
  });
});
