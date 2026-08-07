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
});
