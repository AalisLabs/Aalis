import { describe, expect, it } from 'vitest';
import {
  describeUnmet,
  type PluginSnapshot,
  type UnmetDependencies,
  unmetDependencies,
} from '../../packages/api-doctor/src/index.js';

// ════════════════════════════════════════════════════════════
// 「缺」与「在等」的共享判据：pending 插件没满足的 required 服务沿声明提供它的插件追到根。根失败、停用、没有已装的
// 插件提供、互相等待成环是「缺」；根在启动是「在等」。runtime 的启动告警、plugin-doctor、webui-server 与 plugin-cli
// 都调它。输入只是普通数据：插件状态快照（按 uses 的 kind 分 required 与 optional）与当前有提供者的服务名
// ════════════════════════════════════════════════════════════

type State = PluginSnapshot['state'];

/** 一个插件的快照：requires 与 optional 是它 uses 里的服务，provides 是它声明提供的 */
function plugin(
  instanceId: string,
  state: State,
  fields: { requires?: string[]; optional?: string[]; provides?: string[]; error?: string } = {},
): PluginSnapshot {
  return {
    instanceId,
    state,
    provides: fields.provides,
    error: fields.error,
    uses: [
      ...(fields.requires ?? []).map(service => ({ key: service, service, kind: 'required' as const })),
      ...(fields.optional ?? []).map(service => ({ key: service, service, kind: 'optional' as const })),
    ],
  };
}

const none: UnmetDependencies = { lacking: [], waiting: [] };

interface Case {
  name: string;
  plugins: PluginSnapshot[];
  /** 当前有提供者的服务名 */
  available?: string[];
  /** 要看的 pending 插件 */
  of: string;
  expected: UnmetDependencies;
}

const CASES: Case[] = [
  {
    name: '根失败：链是直接提供者，根带它的失败说明',
    plugins: [
      plugin('a', 'pending', { requires: ['llm'] }),
      plugin('model', 'error', { provides: ['llm'], error: '缺少配置项 apiKey' }),
    ],
    of: 'a',
    expected: {
      lacking: [
        { service: 'llm', chain: ['model'], root: { kind: 'error', instance: 'model', error: '缺少配置项 apiKey' } },
      ],
      waiting: [],
    },
  },
  {
    name: '根已停用',
    plugins: [plugin('a', 'pending', { requires: ['llm'] }), plugin('model', 'disabled', { provides: ['llm'] })],
    of: 'a',
    expected: {
      lacking: [{ service: 'llm', chain: ['model'], root: { kind: 'disabled', instance: 'model' } }],
      waiting: [],
    },
  },
  {
    name: '没有提供者：没有已装的插件声明提供它',
    plugins: [plugin('a', 'pending', { requires: ['llm'] })],
    of: 'a',
    expected: { lacking: [{ service: 'llm', chain: [], root: { kind: 'unprovided', service: 'llm' } }], waiting: [] },
  },
  {
    name: '链：A 要 B 提供的，B 要 C 提供的，C 失败；链从直接提供者追到根',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'] }),
      plugin('b', 'pending', { requires: ['sc'], provides: ['sb'] }),
      plugin('c', 'error', { provides: ['sc'], error: '打不开数据库' }),
    ],
    of: 'a',
    expected: {
      lacking: [{ service: 'sb', chain: ['b', 'c'], root: { kind: 'error', instance: 'c', error: '打不开数据库' } }],
      waiting: [],
    },
  },
  {
    name: '链尾没有提供者：根写出那个没人提供的服务',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'] }),
      plugin('b', 'pending', { requires: ['sc'], provides: ['sb'] }),
    ],
    of: 'a',
    expected: { lacking: [{ service: 'sb', chain: ['b'], root: { kind: 'unprovided', service: 'sc' } }], waiting: [] },
  },
  {
    name: '在启动：直接提供者在激活中，是在等，不是缺',
    plugins: [plugin('a', 'pending', { requires: ['llm'] }), plugin('model', 'activating', { provides: ['llm'] })],
    of: 'a',
    expected: {
      lacking: [],
      waiting: [{ service: 'llm', chain: ['model'], root: { kind: 'starting', instance: 'model' } }],
    },
  },
  {
    name: '在启动：链的根在更深处激活中（含转入后台的慢激活），同样是在等',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'] }),
      plugin('b', 'pending', { requires: ['sc'], provides: ['sb'] }),
      { ...plugin('c', 'activating', { provides: ['sc'] }), slow: true } as PluginSnapshot,
    ],
    of: 'a',
    expected: {
      lacking: [],
      waiting: [{ service: 'sb', chain: ['b', 'c'], root: { kind: 'starting', instance: 'c' } }],
    },
  },
  {
    name: '在启动：提供者 pending 而它要的都在了，马上就激活，同样是在等',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'] }),
      plugin('b', 'pending', { requires: ['logger'], provides: ['sb'] }),
    ],
    available: ['logger'],
    of: 'a',
    expected: { lacking: [], waiting: [{ service: 'sb', chain: ['b'], root: { kind: 'starting', instance: 'b' } }] },
  },
  {
    name: '提供者在运行却没在提供（运行中撤回了条目，例如模型全被删了）：是缺，不是在等，根写它没提供的服务',
    plugins: [plugin('a', 'pending', { requires: ['llm'] }), plugin('model', 'active', { provides: ['llm'] })],
    of: 'a',
    expected: {
      lacking: [{ service: 'llm', chain: ['model'], root: { kind: 'withdrawn', instance: 'model', service: 'llm' } }],
      waiting: [],
    },
  },
  {
    name: '链的更深处在运行却没在提供：根写那一层没提供的服务',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'] }),
      plugin('b', 'pending', { requires: ['sc'], provides: ['sb'] }),
      plugin('c', 'active', { provides: ['sc'] }),
    ],
    of: 'a',
    expected: {
      lacking: [{ service: 'sb', chain: ['b', 'c'], root: { kind: 'withdrawn', instance: 'c', service: 'sc' } }],
      waiting: [],
    },
  },
  {
    name: '一个服务两个提供者：一个在运行却没在提供、一个在启动时只是在等',
    plugins: [
      plugin('a', 'pending', { requires: ['llm'] }),
      plugin('model', 'active', { provides: ['llm'] }),
      plugin('model:backup', 'activating', { provides: ['llm'] }),
    ],
    of: 'a',
    expected: {
      lacking: [],
      waiting: [{ service: 'llm', chain: ['model:backup'], root: { kind: 'starting', instance: 'model:backup' } }],
    },
  },
  {
    name: '两点成环：互相等待，点名环上的插件',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'], provides: ['sa'] }),
      plugin('b', 'pending', { requires: ['sa'], provides: ['sb'] }),
    ],
    of: 'a',
    expected: {
      lacking: [{ service: 'sb', chain: ['b'], root: { kind: 'cycle', instances: ['a', 'b'] } }],
      waiting: [],
    },
  },
  {
    name: '三点成环',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'], provides: ['sa'] }),
      plugin('b', 'pending', { requires: ['sc'], provides: ['sb'] }),
      plugin('c', 'pending', { requires: ['sa'], provides: ['sc'] }),
    ],
    of: 'a',
    expected: {
      lacking: [{ service: 'sb', chain: ['b', 'c'], root: { kind: 'cycle', instances: ['a', 'b', 'c'] } }],
      waiting: [],
    },
  },
  {
    name: '环不含起点：起点挂在环外，环点名的是环上的两个',
    plugins: [
      plugin('d', 'pending', { requires: ['sa'] }),
      plugin('a', 'pending', { requires: ['sb'], provides: ['sa'] }),
      plugin('b', 'pending', { requires: ['sa'], provides: ['sb'] }),
    ],
    of: 'd',
    expected: {
      lacking: [{ service: 'sa', chain: ['a', 'b'], root: { kind: 'cycle', instances: ['a', 'b'] } }],
      waiting: [],
    },
  },
  {
    name: '一个服务两个提供者都没起来：各自追到自己的根',
    plugins: [
      plugin('a', 'pending', { requires: ['llm'] }),
      plugin('model', 'error', { provides: ['llm'], error: '连不上' }),
      plugin('model:backup', 'disabled', { provides: ['llm'] }),
    ],
    of: 'a',
    expected: {
      lacking: [
        { service: 'llm', chain: ['model'], root: { kind: 'error', instance: 'model', error: '连不上' } },
        { service: 'llm', chain: ['model:backup'], root: { kind: 'disabled', instance: 'model:backup' } },
      ],
      waiting: [],
    },
  },
  {
    name: '一个服务两个提供者：一个在启动、一个失败时只是在等，启动完就有',
    plugins: [
      plugin('a', 'pending', { requires: ['llm'] }),
      plugin('model', 'error', { provides: ['llm'], error: '连不上' }),
      plugin('model:backup', 'activating', { provides: ['llm'] }),
    ],
    of: 'a',
    expected: {
      lacking: [],
      waiting: [{ service: 'llm', chain: ['model:backup'], root: { kind: 'starting', instance: 'model:backup' } }],
    },
  },
  {
    name: '提供者自己既缺又等：它起不来，缺的那条是根，在等的那条不算',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'] }),
      plugin('b', 'pending', { requires: ['sc', 'sd'], provides: ['sb'] }),
      plugin('c', 'activating', { provides: ['sc'] }),
      plugin('d', 'disabled', { provides: ['sd'] }),
    ],
    of: 'a',
    expected: {
      lacking: [{ service: 'sb', chain: ['b', 'd'], root: { kind: 'disabled', instance: 'd' } }],
      waiting: [],
    },
  },
  {
    name: '提供者缺的两样都由同一个失败的插件提供：链与根相同的只算一条',
    plugins: [
      plugin('a', 'pending', { requires: ['sb'] }),
      plugin('b', 'pending', { requires: ['sc', 'sd'], provides: ['sb'] }),
      plugin('c', 'error', { provides: ['sc', 'sd'], error: '连不上' }),
    ],
    of: 'a',
    expected: {
      lacking: [{ service: 'sb', chain: ['b', 'c'], root: { kind: 'error', instance: 'c', error: '连不上' } }],
      waiting: [],
    },
  },
  {
    name: '起点自己既缺又等：两项各列',
    plugins: [
      plugin('a', 'pending', { requires: ['llm', 'embedding'] }),
      plugin('model', 'activating', { provides: ['llm'] }),
    ],
    of: 'a',
    expected: {
      lacking: [{ service: 'embedding', chain: [], root: { kind: 'unprovided', service: 'embedding' } }],
      waiting: [{ service: 'llm', chain: ['model'], root: { kind: 'starting', instance: 'model' } }],
    },
  },
  {
    name: '没有提供者按当前有提供者的服务名判：宿主在根上提供的服务不在任何插件的 provides 里，不算缺',
    plugins: [plugin('a', 'pending', { requires: ['host-config', 'llm'] })],
    available: ['host-config'],
    of: 'a',
    expected: { lacking: [{ service: 'llm', chain: [], root: { kind: 'unprovided', service: 'llm' } }], waiting: [] },
  },
  {
    name: '只看 required：optional 的服务没有提供者也不算',
    plugins: [plugin('a', 'pending', { requires: ['llm'], optional: ['embedding'] })],
    of: 'a',
    expected: { lacking: [{ service: 'llm', chain: [], root: { kind: 'unprovided', service: 'llm' } }], waiting: [] },
  },
  {
    name: '已卸载在途的不算提供者',
    plugins: [plugin('a', 'pending', { requires: ['llm'] }), plugin('model', 'disposed', { provides: ['llm'] })],
    of: 'a',
    expected: { lacking: [{ service: 'llm', chain: [], root: { kind: 'unprovided', service: 'llm' } }], waiting: [] },
  },
  {
    name: 'pending 而要的都在：什么都不缺（马上就激活）',
    plugins: [plugin('a', 'pending', { requires: ['logger'] })],
    available: ['logger'],
    of: 'a',
    expected: none,
  },
];

describe('unmetDependencies：缺与在等，沿链追到根', () => {
  it.each(CASES)('$name', ({ plugins, available = [], of, expected }) => {
    expect(unmetDependencies(plugins, available).get(of)).toEqual(expected);
  });

  it('只给 pending 的插件：失败、停用、在启动与运行中的不在结果里', () => {
    const result = unmetDependencies(
      [
        plugin('a', 'pending', { requires: ['llm'] }),
        plugin('model', 'error', { provides: ['llm'] }),
        plugin('off', 'disabled', { requires: ['llm'] }),
        plugin('up', 'active'),
        plugin('slow', 'activating'),
      ],
      [],
    );
    expect([...result.keys()]).toEqual(['a']);
  });

  it('同一个服务在 uses 里出现两次只算一条', () => {
    const snapshot = plugin('a', 'pending', { requires: ['llm', 'llm'] });
    expect(unmetDependencies([snapshot], []).get('a')?.lacking).toHaveLength(1);
  });

  it('环再大也会停下：十个插件首尾相接', () => {
    const ring = Array.from({ length: 10 }, (_, i) =>
      plugin(`p${i}`, 'pending', { requires: [`s${(i + 1) % 10}`], provides: [`s${i}`] }),
    );
    const found = unmetDependencies(ring, []).get('p0');
    expect(found?.lacking[0]?.root).toEqual({ kind: 'cycle', instances: ring.map(p => p.instanceId) });
  });
});

describe('describeUnmet：启动告警、诊断与回执里的一句', () => {
  it('缺的逐条写服务、链与根的情形，在等的写等待谁启动，同一个根只写一次', () => {
    expect(
      describeUnmet({
        lacking: [
          { service: 'sb', chain: ['b', 'c'], root: { kind: 'error', instance: 'c', error: '打不开数据库' } },
          { service: 'llm', chain: ['model'], root: { kind: 'disabled', instance: 'model' } },
          { service: 'embedding', chain: [], root: { kind: 'unprovided', service: 'embedding' } },
          { service: 'sd', chain: ['d'], root: { kind: 'unprovided', service: 'se' } },
          { service: 'sa', chain: ['b'], root: { kind: 'cycle', instances: ['a', 'b'] } },
          { service: 'llm', chain: ['e', 'f'], root: { kind: 'withdrawn', instance: 'f', service: 'sf' } },
        ],
        waiting: [
          { service: 'sx', chain: ['x'], root: { kind: 'starting', instance: 'x' } },
          { service: 'sy', chain: ['y', 'x'], root: { kind: 'starting', instance: 'x' } },
        ],
      }),
    ).toBe(
      [
        '缺少服务 sb（b → c 失败：打不开数据库）',
        '缺少服务 llm（model 已停用）',
        '缺少服务 embedding（没有已装的插件提供）',
        '缺少服务 sd（d → 没有已装的插件提供 se）',
        '缺少服务 sa（b → 互相等待成环：a、b）',
        '缺少服务 llm（e → f 在运行但没有提供 sf）',
        '等待 x 启动',
      ].join('；'),
    );
  });

  it('根失败而没有失败说明：写「原因见日志」', () => {
    expect(
      describeUnmet({ lacking: [{ service: 's', chain: ['p'], root: { kind: 'error', instance: 'p' } }], waiting: [] }),
    ).toBe('缺少服务 s（p 失败：原因见日志）');
  });
});
