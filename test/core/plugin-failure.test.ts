import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  type CoreFailureCode,
  definePlugin,
  defineService,
  type Logger,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { summarizeError } from '../../packages/core/src/infrastructure/logger.js';

// ════════════════════════════════════════════════════════════
// 插件失败只存一份：记录上是抛出的原值 failure，error 是投影时由它现算的摘要；core 自己的失败是挂 code 与数据的普通 Error。
// 展示值（插件显示名、服务提供者的 label）core 不读、不校验，原样转交给展示方。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function world() {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const app = new App({ name: 'plugin-failure', logLevel: 'error', logger });
  apps.push(app);
  return app;
}

/** 某个失败带的 code 与数据属性 */
const coded = (code: CoreFailureCode, data: Record<string, unknown>) => expect.objectContaining({ code, ...data });

describe('插件失败', () => {
  it('failure 是 apply 抛出的原值，error 由它现算；getStatus 与 getPlugin 一致', async () => {
    const app = world();
    const thrown = new Error('外层', { cause: new Error('内层') });
    await app.plugin(
      definePlugin({
        name: 'broken',
        apply() {
          throw thrown;
        },
      }),
    );
    await app.plugins.idle();
    const entry = app.plugins.getPlugin('broken')!;
    expect(entry.state).toBe('error');
    expect(entry.failure).toBe(thrown);
    expect(entry.error).toBe(summarizeError(thrown));
    const status = app.plugins.getStatus().find(s => s.instanceId === 'broken')!;
    expect(status.failure).toBe(thrown);
    expect(status.error).toBe(summarizeError(thrown));
  });

  it.each(['enable', 'bounce'] as const)('%s 之后重新激活成功，failure 与 error 都清掉', async action => {
    const app = world();
    let attempts = 0;
    await app.plugin(
      definePlugin({
        name: 'flaky',
        apply() {
          if (++attempts === 1) throw new Error('第一次失败');
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('flaky')!.failure).toBeInstanceOf(Error);
    await app.plugins[action]('flaky');
    await app.plugins.idle();
    const entry = app.plugins.getPlugin('flaky')!;
    expect(entry.state).toBe('active');
    expect(entry.failure).toBeUndefined();
    expect(entry.error).toBeUndefined();
  });

  it('抛出 undefined（或不带值的 reject）时 failure 换成说明它的 Error，error 照旧是 undefined 的说明', async () => {
    const app = world();
    await app.plugin(definePlugin({ name: 'silent', apply: () => Promise.reject() }));
    await app.plugins.idle();
    const entry = app.plugins.getPlugin('silent')!;
    expect(entry.state).toBe('error');
    expect(entry.failure).toBeInstanceOf(Error);
    expect(entry.error).toBe('undefined');
  });

  it('disable 清掉上一次的失败', async () => {
    const app = world();
    await app.plugin(
      definePlugin({
        name: 'broken',
        apply() {
          throw new Error('坏了');
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.disable('broken');
    expect(app.plugins.getPlugin('broken')!.failure).toBeUndefined();
    expect(app.plugins.getPlugin('broken')!.error).toBeUndefined();
  });
});

describe('core 自己的失败带 code', () => {
  it('provides 声明的服务没有登记：provides-not-registered，services 列出缺的', async () => {
    const app = world();
    const declared = defineService<object>('__t:failure-declared');
    await app.plugin(definePlugin({ name: 'liar', provides: [declared], apply() {} }));
    await app.plugins.idle();
    const entry = app.plugins.getPlugin('liar')!;
    expect(entry.failure).toEqual(coded('provides-not-registered', { services: ['__t:failure-declared'] }));
    expect(entry.error).toContain('声明 provides');
  });

  it('独占登记期间再登记同名：exclusive-conflict，service 是服务名', async () => {
    const app = world();
    const solo = defineService<object>('__t:failure-solo');
    app.bind({ provide }).provide.use(solo, {}, { exclusive: true });
    await app.plugin(
      definePlugin({
        name: 'intruder',
        uses: { provide },
        apply({ provide }) {
          provide.use(solo, {});
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('intruder')!.failure).toEqual(
      coded('exclusive-conflict', { service: '__t:failure-solo' }),
    );
  });

  it('选不到提供者：service-unavailable，指名缺席与钉住失效都给 provider', async () => {
    const app = world();
    const kv = defineService<{ tag: string }>('__t:failure-kv');
    const host = app.bind({ provide });
    const off = host.provide.use(kv, { tag: 'a' }, { entryId: 'a' });
    let selection: { use: { tag: string }; of(id: string): { tag: string }; list(): { use: { tag: string } }[] };
    await app.plugin(
      definePlugin({
        name: 'reader',
        uses: { kv: optional(kv) },
        apply({ kv }) {
          selection = kv;
        },
      }),
    );
    await app.plugins.idle();
    const pinned = selection!.list()[0].use;
    const named = selection!.of('a');
    off();
    const thrown = (read: () => unknown) => {
      try {
        read();
      } catch (err) {
        return err;
      }
      throw new Error('应当抛错');
    };
    expect(thrown(() => selection.use.tag)).toEqual(coded('service-unavailable', { service: '__t:failure-kv' }));
    expect((thrown(() => selection.use.tag) as { provider?: string }).provider).toBeUndefined();
    expect(thrown(() => named.tag)).toEqual(coded('service-unavailable', { service: '__t:failure-kv', provider: 'a' }));
    host.provide.use(kv, { tag: 'a2' }, { entryId: 'a' });
    expect(thrown(() => pinned.tag)).toEqual(
      coded('service-unavailable', { service: '__t:failure-kv', provider: 'a' }),
    );
    expect((thrown(() => pinned.tag) as Error).name).toBe('ServiceUnavailableError');
  });
});

describe('展示值原样转交', () => {
  const display = { i18n: '@t/display', key: 'name', source: '显示名' };

  it('插件显示名：getStatus 原样给出', async () => {
    const app = world();
    await app.plugin(definePlugin({ name: 'shown', displayName: display, apply() {} }));
    await app.plugins.idle();
    expect(app.plugins.getStatus().find(s => s.instanceId === 'shown')!.displayName).toBe(display);
  });

  it('服务提供者的 label：inspect、all 与选择层的条目原样给出', async () => {
    const app = world();
    const labelled = defineService<object>('__t:failure-labelled');
    const host = app.bind({ provide, services });
    host.provide.use(labelled, {}, { label: display });
    expect(host.services.use.inspect(labelled)[0].label).toBe(display);
    expect(host.services.use.all(labelled)[0].label).toBe(display);
    let label: unknown;
    await app.plugin(
      definePlugin({
        name: 'lister',
        uses: { labelled },
        apply({ labelled }) {
          label = labelled.list()[0].label;
        },
      }),
    );
    await app.plugins.idle();
    expect(label).toBe(display);
  });
});
