import { describe, expect, it } from 'vitest';
import { type ConfigSchema, validateConfig } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// validateConfig — 只读结构校验（defaultsFrom 的姊妹函数）
// 戒律：只读不改值；只解释本包的词汇；外来类型放行；逐字段判定与 parseConfig 共用
// （标量宽容；没有 dynamicOptions 时 options 即取值范围，multiselect 另看 allowCustom）；
// undefined/null 视为未配置仅 required 报缺。政策（warn/拦截）在调用方。
// ════════════════════════════════════════════════════════════

const field = (type: string, extra?: Record<string, unknown>) =>
  ({ type, label: 'F', ...extra }) as ConfigSchema[string];

describe('validateConfig 标量类型', () => {
  it('string/textarea：string 通过，非 string 也非有限数字的报错', () => {
    const schema: ConfigSchema = { a: field('string'), b: field('textarea') };
    expect(validateConfig(schema, { a: 'x', b: 'y' })).toEqual([]);
    const issues = validateConfig(schema, { a: { v: 1 }, b: true });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({ path: 'a', message: '期望 string，得到 object', kind: 'invalid' });
    expect(issues[1]).toEqual({ path: 'b', message: '期望 string，得到 boolean', kind: 'invalid' });
  });

  it('string/textarea 标量宽容：有限数字按字符串收（YAML 里不加引号的 QQ 号、口令），NaN/Infinity 不收', () => {
    const schema: ConfigSchema = { a: field('string'), b: field('textarea', { pattern: '^\\d+$' }) };
    expect(validateConfig(schema, { a: 123456, b: 42 })).toEqual([]);
    expect(validateConfig(schema, { a: Number.NaN })[0].message).toBe('期望 string，得到 NaN');
  });

  it('number：有限数值通过；NaN/Infinity/非数字字符串报错', () => {
    const schema: ConfigSchema = { n: field('number') };
    expect(validateConfig(schema, { n: 0 })).toEqual([]);
    expect(validateConfig(schema, { n: -1.5 })).toEqual([]);
    expect(validateConfig(schema, { n: 'abc' })[0].message).toBe('期望有限数值，得到 string');
    expect(validateConfig(schema, { n: Number.NaN })[0].message).toBe('期望有限数值，得到 NaN');
    expect(validateConfig(schema, { n: Number.POSITIVE_INFINITY })[0].message).toBe('期望有限数值，得到 Infinity');
  });

  it('number 标量宽容：去掉首尾空白后能完整解析为有限数的字符串照收；空串、部分数字、Infinity 字符串不收', () => {
    const schema: ConfigSchema = { n: field('number', { min: 1, integer: true }) };
    expect(validateConfig(schema, { n: '42' })).toEqual([]);
    expect(validateConfig(schema, { n: ' 8080 ' })).toEqual([]);
    for (const bad of ['', '  ', '12px', 'Infinity']) {
      expect(validateConfig(schema, { n: bad }), bad).toEqual([
        { path: 'n', message: '期望有限数值，得到 string', kind: 'invalid' },
      ]);
    }
    // 换算后的数照样受约束键检查
    expect(validateConfig(schema, { n: '0' })).toEqual([{ path: 'n', message: '小于下限 1', kind: 'invalid' }]);
    expect(validateConfig(schema, { n: '1.5' })).toEqual([{ path: 'n', message: '期望整数', kind: 'invalid' }]);
  });

  it('boolean：非 boolean 报错，字符串与数字都不转换', () => {
    const schema: ConfigSchema = { b: field('boolean') };
    expect(validateConfig(schema, { b: false })).toEqual([]);
    expect(validateConfig(schema, { b: 'true' })[0].message).toBe('期望 boolean，得到 string');
    expect(validateConfig(schema, { b: 1 })[0].message).toBe('期望 boolean，得到 number');
  });
});

describe('validateConfig select / multiselect', () => {
  it('select：非 string / number 报类型错', () => {
    const schema: ConfigSchema = { s: field('select', { options: [{ label: 'A', value: 'a' }] }) };
    expect(validateConfig(schema, { s: 'a' })).toEqual([]);
    expect(validateConfig(schema, { s: { v: 1 } })[0].message).toBe('期望 string 或 number，得到 object');
  });

  it('select 有静态 options 时即取值范围：按字符串与选项值比较，选项外的值报 invalid 并列出可选值', () => {
    const schema: ConfigSchema = {
      s: field('select', {
        options: [
          { label: 'A', value: 'a' },
          { label: '二', value: 2 },
        ],
      }),
    };
    expect(validateConfig(schema, { s: 2 })).toEqual([]);
    // WebUI 把数字选项存成字符串
    expect(validateConfig(schema, { s: '2' })).toEqual([]);
    expect(validateConfig(schema, { s: 'not-in-options' })).toEqual([
      { path: 's', message: '不是可选值（"a"、2）之一', kind: 'invalid' },
    ]);
    expect(validateConfig(schema, { s: 3 })[0].path).toBe('s');
  });

  it('select 没有 options、options 为空或声明了 dynamicOptions：只查是 string 或 number', () => {
    const schema: ConfigSchema = {
      none: field('select'),
      empty: field('select', { options: [] }),
      dyn: field('select', { dynamicOptions: 'embedding', options: [{ label: 'A', value: 'a' }] }),
    };
    expect(validateConfig(schema, { none: 'x', empty: 7, dyn: 'from-service' })).toEqual([]);
  });

  it('multiselect：需为数组；元素需为 string/number 且在选项内，逐元素报错', () => {
    const schema: ConfigSchema = {
      m: field('multiselect', {
        options: [
          { label: 'A', value: 'a' },
          { label: '八', value: 8 },
        ],
      }),
    };
    expect(validateConfig(schema, { m: ['a', 8, '8'] })).toEqual([]);
    expect(validateConfig(schema, { m: 'a' })[0].message).toBe('期望数组，得到 string');
    expect(validateConfig(schema, { m: ['a', { bad: 1 }, 'custom-host'] })).toEqual([
      { path: 'm[1]', message: '期望 string 或 number 元素，得到 object', kind: 'invalid' },
      { path: 'm[2]', message: '不是可选值（"a"、8）之一', kind: 'invalid' },
    ]);
  });

  it('multiselect 有 allowCustom 或 dynamicOptions 时不查成员资格，只查元素类型', () => {
    const schema: ConfigSchema = {
      custom: field('multiselect', { allowCustom: true, options: [{ label: 'A', value: 'a' }] }),
      dyn: field('multiselect', { dynamicOptions: 'toolGroups', options: [{ label: 'A', value: 'a' }] }),
    };
    expect(validateConfig(schema, { custom: ['a', 'custom-host', 8], dyn: ['web'] })).toEqual([]);
    expect(validateConfig(schema, { custom: [null] })).toEqual([
      { path: 'custom[0]', message: '期望 string 或 number 元素，得到 null', kind: 'invalid' },
    ]);
  });

  it('select 声明了 allowCustom：不查成员资格', () => {
    const schema: ConfigSchema = { s: field('select', { allowCustom: true, options: [{ label: 'A', value: 'a' }] }) };
    expect(validateConfig(schema, { s: 'b' })).toEqual([]);
  });
});

describe('validateConfig list / map', () => {
  it('list：需为数组、元素需为 string（有限数字按字符串收）；保序与重复项不查', () => {
    const schema: ConfigSchema = { args: field('list') };
    expect(validateConfig(schema, { args: ['-e', 'A', '-e', 'A', '/p with space', ''] })).toEqual([]);
    expect(validateConfig(schema, { args: ['--port', 8080] })).toEqual([]);
    expect(validateConfig(schema, { args: '-y pkg' })).toEqual([
      { path: 'args', message: '期望数组，得到 string', kind: 'invalid' },
    ]);
    expect(validateConfig(schema, { args: ['ok', true] })).toEqual([
      { path: 'args[1]', message: '期望 string 元素，得到 boolean', kind: 'invalid' },
    ]);
  });

  it('map：需为对象、每个值需为 string，逐值带点号路径', () => {
    const schema: ConfigSchema = { env: field('map') };
    expect(validateConfig(schema, { env: { TOKEN: 'x', EMPTY: '' } })).toEqual([]);
    expect(validateConfig(schema, { env: {} })).toEqual([]);
    expect(validateConfig(schema, { env: 'KEY=VALUE' })).toEqual([
      { path: 'env', message: '期望对象（映射），得到 string', kind: 'invalid' },
    ]);
    expect(validateConfig(schema, { env: ['KEY=VALUE'] })[0].message).toBe('期望对象（映射），得到 array');
    // 不加引号的端口号照常可用
    expect(validateConfig(schema, { env: { PORT: 8080, OK: 'y' } })).toEqual([]);
    expect(validateConfig(schema, { env: { DEBUG: true, OK: 'y' } })).toEqual([
      { path: 'env.DEBUG', message: '期望 string 值，得到 boolean', kind: 'invalid' },
    ]);
  });
});

describe('validateConfig required 与缺失语义', () => {
  it('undefined 与 null（YAML 裸键）视为未配置：required 报缺，非 required 跳过', () => {
    const schema: ConfigSchema = { req: field('string', { required: true }), opt: field('number') };
    expect(validateConfig(schema, {})).toEqual([{ path: 'req', message: '必填字段缺失', kind: 'missing' }]);
    expect(validateConfig(schema, { req: null, opt: null })).toEqual([
      { path: 'req', message: '必填字段缺失', kind: 'missing' },
    ]);
    expect(validateConfig(schema, { req: '' })).toEqual([{ path: 'req', message: '必填字段缺失', kind: 'missing' }]);
  });

  it('必填字段的空串算未配置（与 parseConfig 一致），空数组算已配置；非必填的空串照常是值', () => {
    const schema: ConfigSchema = {
      s: field('string', { required: true }),
      m: field('multiselect', { required: true }),
      o: field('string'),
      d: field('string', { required: true, default: 'x' }),
    };
    expect(validateConfig(schema, { s: '', m: [], o: '', d: '' })).toEqual([
      { path: 's', message: '必填字段缺失', kind: 'missing' },
    ]);
  });
});

describe("validateConfig onInvalid: 'error'", () => {
  it('严格策略不改变判定与缺省报告，集合坏成员仍逐个定位', () => {
    const schema: ConfigSchema = {
      port: field('number', { default: 80, onInvalid: 'error' }),
      args: field('list', { onInvalid: 'error' }),
    };
    expect(validateConfig(schema, {})).toEqual([]);
    expect(validateConfig(schema, { port: null })).toEqual([]);
    expect(validateConfig(schema, { port: 'bad', args: ['ok', false] })).toEqual([
      { path: 'port', message: '期望有限数值，得到 string', kind: 'invalid' },
      { path: 'args[1]', message: '期望 string 元素，得到 boolean', kind: 'invalid' },
    ]);
  });

  it('map 保留键与稀疏集合位置判为 invalid', () => {
    const schema: ConfigSchema = {
      env: field('map', { onInvalid: 'error' }),
      args: field('list', { onInvalid: 'error' }),
      choices: field('multiselect', { onInvalid: 'error' }),
    };
    const args = ['first'];
    args[2] = 'third';
    const choices = ['a'];
    choices[2] = 'b';
    expect(
      validateConfig(schema, {
        env: JSON.parse('{"GOOD":"ok","__proto__":"bad"}'),
        args,
        choices,
      }),
    ).toEqual([
      { path: 'env.__proto__', message: '保留键不可用', kind: 'invalid' },
      { path: 'args[1]', message: '期望 string 元素，得到 undefined', kind: 'invalid' },
      { path: 'choices[1]', message: '期望 string 或 number 元素，得到 undefined', kind: 'invalid' },
    ]);
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
    expect(validateConfig(schema, { servers: [{ name: 'ok' }, { name: false }] })).toEqual([
      { path: 'servers[1].name', message: '期望 string，得到 boolean', kind: 'invalid' },
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
    expect(validateConfig(weird, { c: true })).toHaveLength(1);
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
