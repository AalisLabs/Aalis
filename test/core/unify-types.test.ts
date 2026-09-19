import { describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { definePlugin, defineService, optional, services } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 类型推导：uses 声明 → apply 参数。负向用例用 @ts-expect-error 钉住——该行若不再报错，
// tsc（test/architecture/test-types.test.ts）会把多余的 expect-error 当错误报出来。
// ════════════════════════════════════════════════════════════

interface KvService {
  get(key: string): number | undefined;
}
const kv = defineService<KvService>('zz-kv');

describe('uses → apply 的类型推导', () => {
  it('声明即得；未声明、可选未处理、错误提供者、非描述符都在编译期被拒', () => {
    const plugin = definePlugin({
      name: 'typed',
      uses: { kv, maybe: optional(kv), tools, services },
      apply(caps) {
        // 正向：调用型 required → require()；注册型 → 门面；默认注入免声明
        const n: number | undefined = caps.kv.require().get('a');
        caps.tools.register({
          definition: {
            type: 'function',
            function: { name: 'x', description: '', parameters: { type: 'object', properties: {} } },
          },
          handler: async () => '',
        });
        caps.events.on('app:ready', () => {});
        caps.logger.info(String(n));
        caps.lifecycle.onDispose(() => {});
        const own: Readonly<Record<string, unknown>> = caps.config;
        void own;

        // 负向 1：未声明的能力不可见
        // @ts-expect-error hooks 未在 uses 里声明
        caps.hooks;

        // 负向 2：可选的调用型没有 require()，current 可能为空必须处理
        // @ts-expect-error optional 的 ServiceRef 不含 require
        caps.maybe.require();
        // @ts-expect-error current 可能是 undefined
        caps.maybe.current.get('a');
        caps.maybe.current?.get('a');

        // 负向 3：提供者实现必须符合描述符的提供者类型
        caps.services.provide(kv, { get: () => 1 });
        // @ts-expect-error 错误的提供者形状
        caps.services.provide(kv, { fetch: () => 1 });

        // 负向 4：绑定接口不是提供者——拿不到原始枢纽的带归属参数的登记口
        // @ts-expect-error 绑定门面的 register 不接受 contextId
        caps.tools.register({} as never, 'someone-else');
      },
    });
    expect(plugin.inject).toEqual({ required: ['zz-kv', 'tools'], optional: ['zz-kv'] });

    // 负向 5：uses 的值必须是描述符（编译期拒；绕过类型的 JS 调用方在定义期得到明确报错）
    expect(() =>
      definePlugin({
        name: 'bad',
        // @ts-expect-error 字符串不是描述符
        uses: { tools: 'tools' },
        apply() {},
      }),
    ).toThrow('不是服务描述符');
  });

  it('uses 的键与默认注入重名在定义期报错', () => {
    expect(() => definePlugin({ name: 'clash', uses: { events: kv }, apply() {} })).toThrow('与默认注入重名');
  });
});
