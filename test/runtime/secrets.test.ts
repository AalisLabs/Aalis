import { describe, expect, it } from 'vitest';
import {
  describeDangling,
  isSecretValue,
  plainSecretPaths,
  referencedKeys,
  resolveSecrets,
  splitSecrets,
} from '../../packages/runtime/src/secrets.js';
import type { ConfigSchema } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — 配置文档与运行态之间的密钥换算
//
// 拆：密钥字段上的非空明文换成引用，值暂存。顶层与分组里的字段写进基线同一位置引用的键（共用者跟着变），
// 数组元素里的一律新建键（重排后按下标找到的可能是别的元素的键）。新键 `<实例>.<路径>`，被占用时加 -2、-3。
// 解：引用换成密钥存储里的值；键不在时引用原样留着、列进 dangling，不回落任何东西。
// ════════════════════════════════════════════════════════════

const SCHEMA = {
  apiKey: { type: 'string', label: 'Key', secret: true },
  env: { type: 'map', label: 'Env', secret: true },
  name: { type: 'string', label: 'Name' },
  auth: { label: 'A', fields: { token: { type: 'string', label: 'T', secret: true } } },
  conns: {
    type: 'array',
    label: 'C',
    items: { url: { type: 'string', label: 'U' }, token: { type: 'string', label: 'T', secret: true } },
  },
} satisfies ConfigSchema;

const free = () => false;

describe('isSecretValue', () => {
  it.each([
    ['sk', true],
    [0, true],
    [{ A: '1' }, true],
    [['x'], true],
    ['', false],
    [null, false],
    [undefined, false],
    [{}, false],
    [[], false],
    [{ $secret: 'k' }, false],
  ])('%j → %s', (value, expected) => {
    expect(isSecretValue(value)).toBe(expected);
  });
});

describe('splitSecrets', () => {
  it('没有引用时新建缺省键：顶层、分组、数组元素（路径不带下标）；非密钥字段与空值不动', () => {
    const { doc, writes, placed } = splitSecrets(
      SCHEMA,
      'p:x',
      { apiKey: 'sk-PLACEHOLDER', name: 'n', env: {}, auth: { token: 't1' }, conns: [{ url: 'u', token: '' }] },
      {},
      free,
    );
    expect(doc).toEqual({
      apiKey: { $secret: 'p:x.apiKey' },
      name: 'n',
      env: {},
      auth: { token: { $secret: 'p:x.auth.token' } },
      conns: [{ url: 'u', token: '' }],
    });
    expect([...writes]).toEqual([
      ['p:x.apiKey', 'sk-PLACEHOLDER'],
      ['p:x.auth.token', 't1'],
    ]);
    expect(placed).toEqual([
      { path: 'apiKey', key: 'p:x.apiKey' },
      { path: 'auth.token', key: 'p:x.auth.token' },
    ]);
  });

  it('顶层与分组：写进基线同一位置引用的键（即使那个键被占用，也就是被共用）', () => {
    const base = { apiKey: { $secret: 'shared' }, auth: { token: { $secret: 'g' } } };
    const inUse = new Set(['shared', 'g']);
    const { doc, writes } = splitSecrets(SCHEMA, 'p', { apiKey: 'new', auth: { token: 'new2' } }, base, key =>
      inUse.has(key),
    );
    expect(doc).toEqual({ apiKey: { $secret: 'shared' }, auth: { token: { $secret: 'g' } } });
    expect([...writes]).toEqual([
      ['shared', 'new'],
      ['g', 'new2'],
    ]);
  });

  it('数组元素：一律新建键，被占用的（另一个元素还在用、存储里已有）依次加后缀，同一次拆出的也不重复', () => {
    const base = { conns: [{ url: 'a', token: { $secret: 'p.conns.token' } }] };
    const taken = new Set(['p.conns.token', 'p.conns.token-2']);
    const { doc, writes } = splitSecrets(
      SCHEMA,
      'p',
      {
        conns: [
          { url: 'a', token: { $secret: 'p.conns.token' } },
          { url: 'b', token: 'tb' },
          { url: 'c', token: 'tc' },
        ],
      },
      base,
      key => taken.has(key),
    );
    expect(doc.conns).toEqual([
      { url: 'a', token: { $secret: 'p.conns.token' } },
      { url: 'b', token: { $secret: 'p.conns.token-3' } },
      { url: 'c', token: { $secret: 'p.conns.token-4' } },
    ]);
    expect([...writes.keys()]).toEqual(['p.conns.token-3', 'p.conns.token-4']);
  });

  it('map 整个值是一个密钥', () => {
    const { doc, writes } = splitSecrets(SCHEMA, 'mcp', { env: { TOKEN: 'v' } }, {}, free);
    expect(doc).toEqual({ env: { $secret: 'mcp.env' } });
    expect(writes.get('mcp.env')).toEqual({ TOKEN: 'v' });
  });
});

describe('resolveSecrets', () => {
  it('引用换成存储里的值；键不在时引用原样留着并列进 dangling（不删、不回落）', () => {
    const store = new Map<string, unknown>([['k1', 'v1']]);
    const { config, dangling } = resolveSecrets(
      SCHEMA,
      { apiKey: { $secret: 'k1' }, conns: [{ url: 'u', token: { $secret: 'gone' } }], name: { $secret: 'k1' } },
      key => (store.has(key) ? { value: store.get(key) } : undefined),
    );
    expect(config).toEqual({
      apiKey: 'v1',
      conns: [{ url: 'u', token: { $secret: 'gone' } }],
      name: { $secret: 'k1' },
    });
    expect(dangling).toEqual([{ path: 'conns.token', key: 'gone' }]);
    expect(describeDangling('p', dangling)).toBe(
      'p 引用的密钥不在 secrets.yaml 里：conns.token（键 gone）；用 parseConfig 读配置的插件会激活失败，在 WebUI 重新填写或在 secrets.yaml 里补上这些键',
    );
  });
});

describe('referencedKeys 与 plainSecretPaths', () => {
  it('referencedKeys 不看 schema，收全部引用', () => {
    expect([...referencedKeys({ a: { $secret: 'x' }, b: [{ c: { $secret: 'y' } }], d: 'z' })]).toEqual(['x', 'y']);
  });

  it('plainSecretPaths 只报密钥字段上的非空明文，同一路径的数组元素只报一次', () => {
    expect(
      plainSecretPaths(SCHEMA, {
        apiKey: { $secret: 'k' },
        name: 'n',
        env: { A: 'b' },
        conns: [{ token: 'a' }, { token: 'b' }, { token: '' }],
      }),
    ).toEqual(['env', 'conns.token']);
  });
});
