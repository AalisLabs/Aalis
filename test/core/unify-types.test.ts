import { afterEach, describe, expect, it } from 'vitest';
import { type ToolService, tools } from '../../packages/api-tools/src/index.js';
import { assertValidInstanceId } from '../../packages/core/src/composition/plugin-definition.js';
import {
  App,
  definePlugin,
  defineService,
  logger,
  optional,
  type PluginDefinition,
  provide,
  type ServiceRef,
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

/** 第三方自定义门面：同时长得像 ServiceRef（current / require）又带自己的成员 */
interface Hybrid {
  readonly current: string | undefined;
  require(): string;
  register(item: string): () => void;
}
const hybrid = defineService<unknown, Hybrid>('zz-hybrid', () => ({
  current: undefined,
  require: () => '',
  register: () => () => {},
}));

describe('uses → apply 的类型推导', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop().catch(() => {});
  });

  it('声明即得；未声明不可见；required 与 optional 同一接口；提供者按描述符约束', async () => {
    const plugin = definePlugin({
      name: 'typed',
      uses: { kv, maybe: optional(kv), tools, provide, logger, hybrid: optional(hybrid) },
      apply(caps) {
        const n: number | undefined = caps.kv.require().get('a');
        caps.logger.info(String(n));
        caps.tools.register({
          definition: {
            type: 'function',
            function: { name: 'x', description: '', parameters: { type: 'object', properties: {} } },
          },
          handler: async () => '',
        });

        // optional 与 required 是同一个 ServiceRef：require() 合法（缺席时运行期抛错），follow 可用
        const ref: ServiceRef<KvService> = caps.maybe;
        // 不需要清理的 attach 不必显式 return
        ref.follow(provider => {
          provider.get('a');
        });
        ref.follow(provider => () => provider.get('a'));
        // @ts-expect-error attach 必须同步：async 回调的清理无处可取，类型上就拒掉
        ref.follow(async provider => {
          provider.get('a');
        });
        // 注册型门面与调用型同一套读面：tools 也有 require / all / follow
        const toolsRef: ServiceRef<ToolService> = caps.tools;
        toolsRef.all();
        caps.maybe.require();
        caps.maybe.current?.get('a');
        // @ts-expect-error current 可能是 undefined，未判空不得直接用
        caps.maybe.current.get('a');
        // @ts-expect-error required 的 current 同样可能为空
        caps.kv.current.get('a');

        // 第三方门面经 optional 后不丢成员
        caps.hybrid.register('x');
        caps.hybrid.require();

        // 未声明的能力不可见——包括内置的
        // @ts-expect-error events 未写进 uses
        caps.events;
        // @ts-expect-error lifecycle 未写进 uses
        caps.lifecycle;

        // 提供者实现必须符合描述符的提供者类型
        caps.provide(kv, { get: () => 1 });
        // @ts-expect-error 错误的提供者形状
        caps.provide(kv, { fetch: () => 1 });

        // 绑定接口不是提供者：拿不到原始枢纽带归属参数的登记口
        // @ts-expect-error 绑定门面的 register 不接受 contextId
        caps.tools.register({} as never, 'someone-else');
      },
    });
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    await app.plugin(plugin);
    await app.plugins.idle();
    const entry = app.plugins.getPlugin('typed');
    // 登记时已写入依赖表；全部服务（含 provide / logger）都进同一激活闸。
    // 本用例不提供 zz-kv / tools，插件保持 pending——钉的是条目上的服务名数组，不是 apply 是否跑过。
    expect(entry?.required, '所有服务统一参与激活闸').toEqual(['zz-kv', 'tools', 'provide', 'logger']);
    expect(entry?.optional).toEqual(['zz-kv', 'zz-hybrid']);
    expect(entry?.state).toBe('pending');

    // uses 的值必须是描述符：编译期拒；绕过类型的 JS 调用方在定义期得到明确报错
    expect(() =>
      definePlugin({
        name: 'bad',
        // @ts-expect-error 字符串不是描述符
        uses: { tools: 'tools' },
        apply() {},
      }),
    ).toThrow('不是服务描述符');
  });

  it('不声明任何能力的插件照样合法（归属与关闭由框架管理，不取决于声明了什么）', async () => {
    const bare = definePlugin({ name: 'bare', apply() {} });
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    await app.plugin(bare);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('bare')?.state).toBe('active');
    expect(app.plugins.getPlugin('bare')?.required).toEqual([]);
    expect(app.plugins.getPlugin('bare')?.optional).toEqual([]);
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

  it('name 不能含 instanceId 的 ":" 后缀分隔或子模块的 "#"', () => {
    expect(() =>
      definePlugin({
        name: 'mod:inst',
        apply() {},
      }),
    ).toThrow(/实例后缀/);

    expect(() =>
      definePlugin({
        name: 'parent#child',
        apply() {},
      }),
    ).toThrow('#');

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
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
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
