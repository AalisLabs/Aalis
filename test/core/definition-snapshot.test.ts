import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  type PluginDefinition,
  provide,
} from '../../packages/core/src/index.js';

// 定义在登记时取定：core 用到的字段（name、displayName、reusable、apply、uses、provides）当场读一次，之后各处读这一份。
// 登记后再改定义对象不生效；读字段、拷配置这些会执行外部代码的步骤都在查重之前，查重与写入之间不再执行外部代码。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function makeApp(): App {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  return app;
}

describe('定义登记时取定', () => {
  it('每个字段只读一次：登记、激活、查状态之后 getter 各只执行过一次', async () => {
    const app = makeApp();
    const reads: Record<string, number> = {};
    const counted = <T>(key: string, value: T) => ({
      get() {
        reads[key] = (reads[key] ?? 0) + 1;
        return value;
      },
      enumerable: true,
    });
    const definition = Object.defineProperties({} as PluginDefinition, {
      name: counted('name', 'counted'),
      displayName: counted('displayName', '计数'),
      reusable: counted('reusable', false),
      uses: counted('uses', { lifecycle }),
      provides: counted('provides', []),
      apply: counted('apply', () => {}),
    });
    await app.plugins.register(definition);
    await app.plugins.idle();
    app.plugins.getStatus();
    await app.plugins.bounce('counted');
    await app.plugins.idle();
    app.plugins.getStatus();
    expect(app.plugins.getPlugin('counted')?.state).toBe('active');
    expect(reads).toEqual({ name: 1, displayName: 1, reusable: 1, uses: 1, provides: 1, apply: 1 });
  });

  it('定义校验不过（uses、provides 里有不是描述符的项）：各字段同样只读一次', async () => {
    const app = makeApp();
    for (const extra of [{ uses: { bad: 1 } }, { provides: [1] }]) {
      let reads = 0;
      const definition = Object.defineProperty({ apply() {}, ...extra }, 'name', {
        get() {
          reads++;
          return 'bad-def';
        },
        enumerable: true,
      }) as unknown as PluginDefinition;
      expect(await app.plugins.register(definition)).toBe(false);
      expect(reads).toBe(1);
    }
  });

  it('登记后就地往 uses 里加一项、改 optional 包装指向的服务：激活仍按登记时那份', async () => {
    const app = makeApp();
    const a = defineService<{ who(): string }>('snapshot-a');
    const b = defineService<{ who(): string }>('snapshot-b');
    app.bind({ provide }).provide.use(a, { who: () => 'a' });
    app.bind({ provide }).provide.use(b, { who: () => 'b' });
    const seen: unknown[] = [];
    const uses: Record<string, unknown> = { dep: optional(a) };
    const definition = {
      name: 'inplace',
      uses,
      apply: (caps: { dep: { use: { who(): string } } }) => {
        seen.push(Object.keys(caps), caps.dep.use.who());
      },
    } as unknown as PluginDefinition;
    await app.plugins.register(definition, {}, undefined, { disabled: true });
    uses.extra = b;
    (uses.dep as { optional: unknown }).optional = b;
    await app.plugins.enable('inplace');
    await app.plugins.idle();
    expect(seen).toEqual([['dep'], 'a']);
  });

  it('登记后把定义的 uses 换掉：提供者下线时日志仍点名登记时依赖的那个服务', async () => {
    const infos: string[] = [];
    const logger: Logger = {
      debug() {},
      info: (...a) => void infos.push(a.map(String).join(' ')),
      warn() {},
      error() {},
      child: () => logger,
    };
    const app = new App({ name: 'T', logger });
    apps.push(app);
    const real = defineService<{ v: number }>('snapshot-real');
    const withdraw = app.bind({ provide }).provide.use(real, { v: 1 });
    const consumer = definePlugin({ name: 'needs-real', uses: { real }, apply() {} });
    await app.plugin(consumer);
    await app.plugins.idle();
    (consumer as { uses?: object }).uses = { ghost: defineService('snapshot-ghost') };
    withdraw();
    await app.plugins.idle();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(infos.find(line => line.includes('不可用，停用插件: needs-real'))).toContain('依赖 "snapshot-real" 不可用');
  });

  it('apply 以登记的定义对象作 this 调用', async () => {
    const app = makeApp();
    let seen: unknown;
    const definition = {
      name: 'this-check',
      apply(this: unknown) {
        seen = this;
      },
    } as PluginDefinition;
    await app.plugin(definition);
    await app.plugins.idle();
    expect(seen).toBe(definition);
  });

  it('reusable 的 getter 抛错：批量登记只拒这一条，其余照常登记并激活', async () => {
    const app = makeApp();
    let applied = 0;
    const good = definePlugin({ name: 'good', apply: () => void applied++ });
    const weird = {
      name: 'weird',
      apply() {},
      get reusable(): boolean {
        throw new Error('reusable boom');
      },
    } as PluginDefinition;
    const results = await app.pluginAll([{ definition: good }, { definition: weird, instanceId: 'weird:1' }]);
    await app.plugins.idle();
    expect(results).toEqual([true, false]);
    expect(applied).toBe(1);
    expect(app.plugins.getStatus().map(s => `${s.instanceId}:${s.state}`)).toEqual(['good:active']);
  });

  it('登记项本身读不出（为 null、字段的 getter 抛错）：批量登记只拒这一条，其余照常登记并激活', async () => {
    const app = makeApp();
    let applied = 0;
    const good = definePlugin({ name: 'good', apply: () => void applied++ });
    const throwing = {
      definition: definePlugin({ name: 'other', apply() {} }),
      get config(): Record<string, unknown> {
        throw new Error('item boom');
      },
    };
    const results = await app.pluginAll([{ definition: good }, null as never, throwing]);
    await app.plugins.idle();
    expect(results).toEqual([true, false, false]);
    expect(applied).toBe(1);
    expect(app.plugins.getStatus().map(s => `${s.instanceId}:${s.state}`)).toEqual(['good:active']);
  });

  it('登记项的字段在原型链上或是 class 的 getter：照样读到，各只读一次', async () => {
    const app = makeApp();
    const inherited = Object.assign(Object.create({ disabled: true }), {
      definition: definePlugin({ name: 'inherited', apply() {} }),
    });
    let reads = 0;
    class Item {
      get definition(): PluginDefinition {
        reads++;
        return definePlugin({ name: 'getter', apply() {} });
      }
    }
    const results = await app.pluginAll([inherited, new Item()]);
    await app.plugins.idle();
    expect(results).toEqual([true, true]);
    expect(reads).toBe(1);
    expect(app.plugins.getStatus().map(s => `${s.instanceId}:${s.state}`)).toEqual([
      'inherited:disabled',
      'getter:active',
    ]);
  });

  // 手写的定义对象（不经 definePlugin，那里另读一次）：登记时只读一次
  it('uses 的项是 getter：登记只读一次，激活闸与查状态交出的依赖用的是绑定那一次读到的值', async () => {
    const app = makeApp();
    const a = defineService<object>('t:snapshot-a');
    const b = defineService<object>('t:snapshot-b');
    let reads = 0;
    const uses = {
      get dep() {
        reads++;
        return reads === 1 ? a : optional(b);
      },
    };
    await app.plugins.register({ name: 'getter-uses', uses, apply() {} } as PluginDefinition);
    await app.plugins.idle();
    expect(reads).toBe(1);
    expect(app.plugins.getStatus()[0]).toMatchObject({
      state: 'pending',
      uses: [{ key: 'dep', service: 't:snapshot-a', kind: 'required' }],
    });
  });

  it('登记项的 disabled 只认 true：1 这类真值不算，照常激活', async () => {
    const app = makeApp();
    const results = await app.pluginAll([
      { definition: definePlugin({ name: 'truthy', apply() {} }), disabled: 1 as unknown as boolean },
    ]);
    await app.plugins.idle();
    expect(results).toEqual([true]);
    expect(app.plugins.getStatus().map(s => `${s.instanceId}:${s.state}`)).toEqual(['truthy:active']);
  });

  it('多实例登记也只读一次 reusable：第二次读才抛的 getter 不影响登记', async () => {
    const app = makeApp();
    let reads = 0;
    const definition = {
      name: 'multi',
      apply() {},
      get reusable(): boolean {
        if (++reads > 1) throw new Error('reusable read twice');
        return true;
      },
    } as PluginDefinition;
    expect(await app.pluginAll([{ definition, instanceId: 'multi:1' }])).toEqual([true]);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('multi:1')?.state).toBe('active');
  });

  it('改查状态交出的 uses 与 provides 碰不到注册表：再查照旧，重启照常激活', async () => {
    const app = makeApp();
    const svc = defineService<{ v: number }>('snapshot-provided');
    await app.plugin(
      definePlugin({
        name: 'stat',
        uses: { provide },
        provides: [svc],
        apply: ({ provide }) => void provide.use(svc, { v: 1 }),
      }),
    );
    await app.plugins.idle();
    const before = structuredClone(app.plugins.getStatus());
    const [handed] = app.plugins.getStatus();
    (handed.uses[0] as { kind: string }).kind = 'optional';
    handed.provides?.push('snapshot-extra');
    expect(app.plugins.getStatus()).toEqual(before);
    await app.plugins.bounce('stat');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('stat')?.state).toBe('active');
  });

  it('配置的 getter 在拷贝时重入登记同一 id：只登记、只启动一份', async () => {
    const app = makeApp();
    await app.plugins.idle();
    const svc = defineService<{ gen: number }>('snapshot-dup');
    let gen = 0;
    const definition = definePlugin({
      name: 'dup',
      uses: { provide },
      provides: [svc],
      apply({ provide }) {
        provide.use(svc, { gen: ++gen });
      },
    });
    let inner: Promise<boolean> | undefined;
    const config = {
      get mode() {
        inner ??= app.plugin(definition, { mode: 'inner' });
        return 'outer';
      },
    };
    const outer = await app.plugin(definition, config);
    await app.plugins.idle();
    expect([outer, await inner]).toEqual([false, true]);
    expect(gen).toBe(1);
    expect(app.plugins.getPlugin('dup')?.config).toEqual({ mode: 'inner' });
  });
});
