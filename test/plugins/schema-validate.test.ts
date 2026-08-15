import { describe, expect, it } from 'vitest';
import { type ConfigSchema, validateConfig } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// validateConfig — 只读结构校验（defaultsFrom 的姊妹函数）
// 戒律：只读不改值；只解释中立词汇；外来类型放行；options 非白名单；
// undefined/null 视为未配置仅 required 报缺。政策（warn/拦截）在调用方。
// ════════════════════════════════════════════════════════════

const field = (type: string, extra?: Record<string, unknown>) =>
  ({ type, label: 'F', ...extra }) as ConfigSchema[string];

describe('validateConfig 标量类型', () => {
  it('string/textarea：非 string 报错，string 通过', () => {
    const schema: ConfigSchema = { a: field('string'), b: field('textarea') };
    expect(validateConfig(schema, { a: 'x', b: 'y' })).toEqual([]);
    const issues = validateConfig(schema, { a: 1, b: true });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({ path: 'a', message: '期望 string，得到 number', kind: 'invalid' });
    expect(issues[1].path).toBe('b');
  });

  it('number：有限数值通过；NaN/Infinity/字符串报错', () => {
    const schema: ConfigSchema = { n: field('number') };
    expect(validateConfig(schema, { n: 0 })).toEqual([]);
    expect(validateConfig(schema, { n: -1.5 })).toEqual([]);
    expect(validateConfig(schema, { n: 'abc' })[0].message).toBe('期望有限数值，得到 string');
    expect(validateConfig(schema, { n: Number.NaN })[0].message).toBe('期望有限数值，得到 NaN');
    expect(validateConfig(schema, { n: Number.POSITIVE_INFINITY })[0].message).toBe('期望有限数值，得到 Infinity');
  });

  it('boolean：非 boolean 报错', () => {
    const schema: ConfigSchema = { b: field('boolean') };
    expect(validateConfig(schema, { b: false })).toEqual([]);
    expect(validateConfig(schema, { b: 'true' })[0].message).toBe('期望 boolean，得到 string');
  });
});

describe('validateConfig select / multiselect', () => {
  it('select：string 或 number 通过，其余报错', () => {
    const schema: ConfigSchema = { s: field('select', { options: [{ label: 'A', value: 'a' }] }) };
    expect(validateConfig(schema, { s: 'a' })).toEqual([]);
    expect(validateConfig(schema, { s: 3 })).toEqual([]);
    expect(validateConfig(schema, { s: { v: 1 } })[0].message).toBe('期望 string 或 number，得到 object');
  });

  it('select 不把 options 当取值白名单（allowCustom 是宿主属性，本包看不见）', () => {
    const schema: ConfigSchema = { s: field('select', { options: [{ label: 'A', value: 'a' }] }) };
    expect(validateConfig(schema, { s: 'not-in-options' })).toEqual([]);
  });

  it('multiselect：需为数组，元素需为 string/number，选项外元素放行', () => {
    const schema: ConfigSchema = { m: field('multiselect', { options: [{ label: 'A', value: 'a' }] }) };
    expect(validateConfig(schema, { m: ['a', 'custom-host', 8] })).toEqual([]);
    expect(validateConfig(schema, { m: 'a' })[0].message).toBe('期望数组，得到 string');
    const issues = validateConfig(schema, { m: ['ok', { bad: 1 }] });
    expect(issues).toEqual([{ path: 'm[1]', message: '期望 string 或 number 元素，得到 object', kind: 'invalid' }]);
  });
});

describe('validateConfig required 与缺失语义', () => {
  it('undefined 与 null（YAML 裸键）视为未配置：required 报缺，非 required 跳过', () => {
    const schema: ConfigSchema = { req: field('string', { required: true }), opt: field('number') };
    expect(validateConfig(schema, {})).toEqual([{ path: 'req', message: '必填字段缺失', kind: 'missing' }]);
    expect(validateConfig(schema, { req: null, opt: null })).toEqual([
      { path: 'req', message: '必填字段缺失', kind: 'missing' },
    ]);
    expect(validateConfig(schema, { req: '' })).toEqual([]);
  });

  it('空字符串与空数组是"已配置"，不算缺失', () => {
    const schema: ConfigSchema = {
      s: field('string', { required: true }),
      m: field('multiselect', { required: true }),
    };
    expect(validateConfig(schema, { s: '', m: [] })).toEqual([]);
  });
});

describe('validateConfig 开放词汇表', () => {
  it('外来类型（declaration merging 注入，如 llm-ref）一律跳过放行', () => {
    const schema = { ref: { type: 'llm-ref', label: '模型' } } as unknown as ConfigSchema;
    expect(validateConfig(schema, { ref: { provider: 'x', model: 'y' } })).toEqual([]);
    expect(validateConfig(schema, { ref: 42 })).toEqual([]);
  });

  it('外来类型仍受 required 约束（缺失语义先于类型分派）', () => {
    const schema = { ref: { type: 'llm-ref', label: '模型', required: true } } as unknown as ConfigSchema;
    expect(validateConfig(schema, {})).toEqual([{ path: 'ref', message: '必填字段缺失', kind: 'missing' }]);
  });
});

describe('validateConfig SchemaGroup 递归', () => {
  const schema: ConfigSchema = {
    server: { label: '服务', fields: { port: { type: 'number', label: 'P' }, host: { type: 'string', label: 'H' } } },
  };

  it('嵌套字段带点号路径', () => {
    expect(validateConfig(schema, { server: { port: 'abc', host: 'ok' } })).toEqual([
      { path: 'server.port', message: '期望有限数值，得到 string', kind: 'invalid' },
    ]);
  });

  it('分组值非对象报错；undefined/null 跳过', () => {
    expect(validateConfig(schema, { server: 'oops' })[0]).toEqual({
      path: 'server',
      message: '期望对象（分组），得到 string',
      kind: 'invalid',
    });
    expect(validateConfig(schema, { server: [1] })[0].message).toBe('期望对象（分组），得到 array');
    expect(validateConfig(schema, {})).toEqual([]);
  });
});

describe('validateConfig SchemaArray 递归', () => {
  const schema: ConfigSchema = {
    servers: { type: 'array', label: '列表', items: { name: { type: 'string', label: 'N' } } },
  };

  it('非数组报错；元素非对象报错；元素字段带下标路径', () => {
    expect(validateConfig(schema, { servers: 'x' })[0].message).toBe('期望数组，得到 string');
    expect(validateConfig(schema, { servers: [null] })).toEqual([
      { path: 'servers[0]', message: '期望对象元素，得到 null', kind: 'invalid' },
    ]);
    expect(validateConfig(schema, { servers: [{ name: 'ok' }, { name: 7 }] })).toEqual([
      { path: 'servers[1].name', message: '期望 string，得到 number', kind: 'invalid' },
    ]);
  });

  it('undefined/null 跳过；合法数组通过', () => {
    expect(validateConfig(schema, {})).toEqual([]);
    expect(validateConfig(schema, { servers: [] })).toEqual([]);
  });
});

describe('validateConfig 边界', () => {
  it('schema 为 undefined 或空对象：恒返回空清单', () => {
    expect(validateConfig(undefined, { any: 1 })).toEqual([]);
    expect(validateConfig({}, { any: 1 })).toEqual([]);
  });

  it('config 里 schema 外的键不归校验器管（裁剪政策已有告警）', () => {
    const schema: ConfigSchema = { a: field('string') };
    expect(validateConfig(schema, { a: 'x', stray: 123 })).toEqual([]);
  });

  it('只读：不修改传入的 config 对象', () => {
    const schema: ConfigSchema = { a: field('number') };
    const config = { a: 'bad' };
    validateConfig(schema, config);
    expect(config).toEqual({ a: 'bad' });
  });
});

describe('validateConfig 畸形 schema 免疫（审计修复锁定）', () => {
  it('array 缺 items / fields 为 null：不抛、不报（最大代价=少一条警告）', () => {
    const noItems = { a: { type: 'array', label: 'x' } } as unknown as ConfigSchema;
    expect(validateConfig(noItems, { a: [{ k: 1 }] })).toEqual([]);
    const nullFields = { g: { label: 'x', fields: null } } as unknown as ConfigSchema;
    expect(validateConfig(nullFields, { g: { k: 1 } })).toEqual([]);
  });

  it('schema 条目为 null/原始值：跳过不抛', () => {
    const weird = { a: null, b: 'oops', c: { type: 'string', label: 'C' } } as unknown as ConfigSchema;
    expect(validateConfig(weird, { c: 1 })).toHaveLength(1);
  });
});

describe('validateConfig 声明了 default 即不算缺失（审计修复锁定）', () => {
  it('数组元素 required+default 省略时不报缺（默认值不参与合并，靠声明放行）', () => {
    const schema: ConfigSchema = {
      jobs: {
        type: 'array',
        label: 'J',
        items: {
          name: { type: 'string', label: 'N', required: true },
          platform: { type: 'string', label: 'P', required: true, default: 'internal' },
        },
      },
    };
    expect(validateConfig(schema, { jobs: [{ name: 'x' }] })).toEqual([]);
    expect(validateConfig(schema, { jobs: [{}] })).toEqual([
      { path: 'jobs[0].name', message: '必填字段缺失', kind: 'missing' },
    ]);
  });

  it('顶层 required+default 未配置也不报缺（调用点合并默认值后此判恒假，语义一致）', () => {
    const schema: ConfigSchema = { p: field('string', { required: true, default: 'v' }) };
    expect(validateConfig(schema, {})).toEqual([]);
  });
});

describe('validateConfig 约束键（min/max/integer/pattern/step）', () => {
  it('min/max 含边界；违约报 invalid 并带界值', () => {
    const schema: ConfigSchema = { port: field('number', { min: 1, max: 65535 }) };
    expect(validateConfig(schema, { port: 1 })).toEqual([]);
    expect(validateConfig(schema, { port: 65535 })).toEqual([]);
    expect(validateConfig(schema, { port: 0 })).toEqual([{ path: 'port', message: '小于下限 1', kind: 'invalid' }]);
    expect(validateConfig(schema, { port: 70000 })).toEqual([
      { path: 'port', message: '大于上限 65535', kind: 'invalid' },
    ]);
  });

  it('integer：小数报错，整数通过；负整数合法', () => {
    const schema: ConfigSchema = { n: field('number', { integer: true }) };
    expect(validateConfig(schema, { n: -3 })).toEqual([]);
    expect(validateConfig(schema, { n: 1.5 })).toEqual([{ path: 'n', message: '期望整数', kind: 'invalid' }]);
  });

  it('类型错时只报类型错，不叠报约束错', () => {
    const schema: ConfigSchema = { n: field('number', { min: 1, integer: true }) };
    const issues = validateConfig(schema, { n: 'abc' });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('期望有限数值，得到 string');
  });

  it('pattern：匹配通过、不匹配报 invalid；textarea 同规', () => {
    const schema: ConfigSchema = {
      host: field('string', { pattern: '^[a-z.]+$' }),
      body: field('textarea', { pattern: '^\\d+$' }),
    };
    expect(validateConfig(schema, { host: 'a.example', body: '123' })).toEqual([]);
    expect(validateConfig(schema, { host: 'BAD HOST', body: '123' })).toEqual([
      { path: 'host', message: '不匹配模式 ^[a-z.]+$', kind: 'invalid' },
    ]);
  });

  it('非法 pattern（schema 自身缺陷）：跳过该检查，不抛不误伤', () => {
    const schema: ConfigSchema = { s: field('string', { pattern: '[unclosed' }) };
    expect(validateConfig(schema, { s: 'anything' })).toEqual([]);
  });

  it('step 不校验（纯 UI 提示）；约束键出现在不适用类型上被忽略', () => {
    const schema: ConfigSchema = {
      n: field('number', { step: 5 }),
      s: field('string', { min: 3, max: 5, integer: true } as Record<string, unknown>),
      b: field('boolean', { pattern: 'x' } as Record<string, unknown>),
    };
    expect(validateConfig(schema, { n: 7, s: 'longer-than-five', b: true })).toEqual([]);
  });

  it('约束键在数组元素字段上同样生效（含路径）', () => {
    const schema: ConfigSchema = {
      servers: {
        type: 'array',
        label: 'S',
        items: { port: { type: 'number', label: 'P', min: 1, max: 65535, integer: true } },
      },
    };
    expect(validateConfig(schema, { servers: [{ port: 8080 }, { port: 0 }] })).toEqual([
      { path: 'servers[1].port', message: '小于下限 1', kind: 'invalid' },
    ]);
  });
});
