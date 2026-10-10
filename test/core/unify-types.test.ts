import { afterEach, describe, expect, it } from 'vitest';
import { assertValidInstanceId } from '../../packages/core/src/composition/plugin-definition.js';
import {
  App,
  definePlugin,
  defineService,
  logger,
  optional,
  type PluginDefinition,
  provide,
  type ServiceSelection,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 类型推导：uses 声明 → apply 参数。负向用例用 @ts-expect-error 钉住——该行若不再报错，
// tsc（test/architecture/test-types.test.ts）会把多余的 expect-error 当错误报出来。
// 没有默认注入：没写进 uses 的能力（含 logger / events）在类型上就不存在。
// ════════════════════════════════════════════════════════════

interface KvService {
  get(key: string): number | undefined;
}
const kv = defineService<KvService>('zz-kv');

/** 登记型契约：业务层由绑定给出，登记口不带归属参数 */
interface Registry {
  register(item: string, owner: string): () => void;
}
interface BoundRegistry {
  register(item: string): () => void;
}
const registry = defineService<Registry, BoundRegistry>('zz-registry', port => {
  const ledger = port.registrar<string>({ key: item => item, register: (hub, item) => hub.register(item, port.id) });
  return { register: item => ledger.add(item) };
});

/** 契约的成员恰好与选择层同名：它们只在业务层 */
interface Hybrid {
  readonly current: string | undefined;
  list(): string[];
  use: number;
}
const hybrid = defineService<Hybrid>('zz-hybrid');

describe('uses → apply 的类型推导', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop().catch(() => {});
  });

  it('声明即得；未声明不可见；required 与 optional 同一选择层；业务层按描述符推导', async () => {
    const plugin = definePlugin({
      name: 'typed',
      uses: { kv, maybe: optional(kv), registry, provide, logger, hybrid: optional(hybrid) },
      apply(caps) {
        const n: number | undefined = caps.kv.use.get('a');
        caps.logger.use.info(String(n));
        caps.registry.use.register('x');
        // @ts-expect-error 业务层的登记口不接受归属参数：拿不到原始枢纽
        caps.registry.use.register('x', 'someone-else');

        // optional 与 required 是同一个选择层；use、of 与 list() 条目的 use 都是业务层类型
        const selection: ServiceSelection<KvService> = caps.maybe;
        const handles: KvService[] = [selection.use, selection.of('x'), ...selection.list().map(p => p.use)];
        const bound: BoundRegistry[] = [caps.registry.use, caps.registry.of('x'), caps.registry.list()[0].use];
        const present: boolean = selection.present;
        void [handles, bound, present];
        // 不需要清理的 attach 不必显式 return
        selection.follow(handle => {
          handle.get('a');
        });
        selection.follow(handle => () => handle.get('a'));
        // @ts-expect-error attach 必须同步：async 回调的清理无处可取，类型上就拒掉
        selection.follow(async handle => {
          handle.get('a');
        });

        // 选择层成员由 core 定、契约覆盖不了：同名成员只在业务层
        const names: string[] = caps.hybrid.use.list();
        const count: number = caps.hybrid.use.use;
        void [names, count, caps.hybrid.use.current];
        // @ts-expect-error 选择层的 list 列的是提供者，不是契约的 list
        const wrong: string[] = caps.hybrid.list();
        void wrong;
        // 选择层没有旧写法，也没有写偏好的操作
        // @ts-expect-error 没有 current
        void caps.kv.current;
        // @ts-expect-error 没有 require
        caps.kv.require();
        // @ts-expect-error 没有 all
        caps.kv.all();
        // @ts-expect-error 偏好只经管理面设
        caps.kv.prefer('x');
        // @ts-expect-error 偏好只经管理面设
        caps.kv.unprefer();

        // 未声明的能力不可见——包括内置的
        // @ts-expect-error events 未写进 uses
        caps.events;
        // @ts-expect-error lifecycle 未写进 uses
        caps.lifecycle;

        // 提供者实现必须符合描述符的提供者类型
        caps.provide.use(kv, { get: () => 1 });
        // @ts-expect-error 错误的提供者形状
        caps.provide.use(kv, { fetch: () => 1 });
      },
    });
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await app.plugin(plugin);
    await app.plugins.idle();
    const status = app.plugins.getStatus().find(p => p.instanceId === 'typed');
    const kinds = (kind: 'required' | 'optional') => status?.uses.filter(u => u.kind === kind).map(u => u.service);
    // 登记时已写入依赖表；全部服务（含 provide / logger）都进同一激活闸。
    // 本用例不提供 zz-kv / zz-registry，插件保持 pending——钉的是状态里的依赖声明，不是 apply 是否跑过。
    expect(kinds('required'), '所有服务统一参与激活闸').toEqual(['zz-kv', 'zz-registry', 'provide', 'logger']);
    expect(kinds('optional')).toEqual(['zz-kv', 'zz-hybrid']);
    expect(status, '依赖信息只留 uses').not.toHaveProperty('requiredServices');
    expect(status?.state).toBe('pending');

    // uses 的值必须是描述符：编译期拒；绕过类型的 JS 调用方在定义期得到明确报错
    expect(() =>
      definePlugin({
        name: 'bad',
        // @ts-expect-error 字符串不是描述符
        uses: { kv: 'zz-kv' },
        apply() {},
      }),
    ).toThrow('不是服务描述符');
  });

  it('不声明任何能力的插件照样合法（归属与关闭由框架管理，不取决于声明了什么）', async () => {
    const bare = definePlugin({ name: 'bare', apply() {} });
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await app.plugin(bare);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('bare')?.state).toBe('active');
    expect(app.plugins.getStatus().find(p => p.instanceId === 'bare')?.uses).toEqual([]);
  });
});

describe('定义对象的 name', () => {
  it('缺 name、空串在 definePlugin 即抛', () => {
    expect(() =>
      // @ts-expect-error name 是必填字段；运行期同样拒绝，不把 undefined 当实例 id
      definePlugin({
        apply() {},
      }),
    ).toThrow(/缺少合法 name/);

    expect(() =>
      definePlugin({
        name: '',
        apply() {},
      }),
    ).toThrow(/缺少合法 name/);
  });

  it('name 不能含 instanceId 的 ":" 后缀分隔；"#" 不受限', () => {
    expect(() =>
      definePlugin({
        name: 'mod:inst',
        apply() {},
      }),
    ).toThrow(/实例后缀/);

    expect(definePlugin({ name: 'parent#child', apply() {} }).name).toBe('parent#child');
    expect(() => assertValidInstanceId('mod:a#b')).not.toThrow();

    // 作用域包名含 '/'，不含 ':'——这是合法 name
    expect(definePlugin({ name: '@scope/plugin', apply() {} }).name).toBe('@scope/plugin');
  });

  it('空白 name（trim 后空）与空串同类拒绝', () => {
    expect(() => definePlugin({ name: '   ', apply() {} })).toThrow('插件定义缺少合法 name（须为非空字符串）');
    expect(() => definePlugin({ name: '\t\n', apply() {} })).toThrow('插件定义缺少合法 name（须为非空字符串）');
  });

  it('name 不能是 __proto__ / constructor / prototype', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(() => definePlugin({ name, apply() {} }), name).toThrow(
        `插件 "${name}" 的 name 不能使用危险键（__proto__ / constructor / prototype）`,
      );
    }
    expect(() => assertValidInstanceId('__proto__')).toThrow(
      'instanceId "__proto__" 不能使用危险键（__proto__ / constructor / prototype）',
    );
    // 闸只管写进普通对象当键时危险的原串；带空白的串本身不危险，id 存储时也不 trim
    expect(definePlugin({ name: ' __proto__ ', apply() {} }).name).toBe(' __proto__ ');
  });
});

describe('定义对象的 uses / apply / provides', () => {
  const asDef = (value: unknown) => value as PluginDefinition;
  const apps: App[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop().catch(() => {});
  });

  it('uses 为数字、布尔或数组在定义期拒绝', () => {
    expect(() => definePlugin(asDef({ name: 'u-num', uses: 5, apply() {} }))).toThrow(
      '插件 "u-num" 的 uses 必须是纯对象（不能是数组或原始值）',
    );
    expect(() => definePlugin(asDef({ name: 'u-bool', uses: true, apply() {} }))).toThrow(
      '插件 "u-bool" 的 uses 必须是纯对象（不能是数组或原始值）',
    );
    expect(() => definePlugin(asDef({ name: 'u-arr', uses: [], apply() {} }))).toThrow(
      '插件 "u-arr" 的 uses 必须是纯对象（不能是数组或原始值）',
    );
  });

  it('apply 非函数：definePlugin 抛；手写 register 返回 false 且不落账', async () => {
    expect(() => definePlugin(asDef({ name: 'no-apply' }))).toThrow('插件 "no-apply" 的 apply 必须是函数');
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    expect(await app.plugins.register(asDef({ name: 'no-apply' }))).toBe(false);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('no-apply')).toBeUndefined();
  });

  it('provides 元素非描述符：文案含原值', () => {
    expect(() => definePlugin(asDef({ name: 'prov-str', provides: ['zz-s5-kv'], apply() {} }))).toThrow(
      '插件 "prov-str" 的 provides 含有不是描述符的元素（zz-s5-kv）',
    );
  });
});
