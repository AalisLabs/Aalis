import { afterEach, describe, expect, it } from 'vitest';
import {
  type App,
  DefaultLogger,
  definePlugin,
  defineService,
  events,
  hooks,
  type Logger,
  LogHub,
  lifecycle,
  parseInstanceId,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { Resources } from '../../packages/core/src/infrastructure/resources.js';
// DisposableChain 不从包根导出（内部实现细节）；直接从源文件导入测试。
import { DisposableChain } from '../../packages/core/src/kernel/disposable-chain.js';
import { EventBus } from '../../packages/core/src/primitives/events.js';
import { activationHost, createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// 内核与原语的边角路径：超时放弃等待、重入退订、已被整体清走后的旧句柄等。
// 这些分支平时不走，一旦出错表现为挂死、漏报或把无关项点名，故逐条钉住可观察行为。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const never = () => new Promise<void>(() => {});

function capture() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (message, ...args) => void warnings.push([message, ...args.map(String)].join(' ')),
    error: (message, ...args) => void warnings.push([message, ...args.map(String)].join(' ')),
    child: () => logger,
  };
  return { logger, warnings };
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function world() {
  const { logger, warnings } = capture();
  const app = createInspectableApp({
    config: { name: 'kernel-edges', logLevel: 'error', plugins: {} },
    logger,
    disposeTimeoutMs: 300,
  });
  apps.push(app);
  return { app, warnings };
}

describe('DisposableChain 排空期的迟到登记', () => {
  it('迟到登记的异步清理超时：放弃等待并点名；期间已落定的迟到项不被点名', async () => {
    const { logger, warnings } = capture();
    const chain = new DisposableChain(logger);
    const order: string[] = [];
    chain.push(() => {
      // 链已被取走：这两项就地执行，由本段收口等待
      chain.push(() => sleep(5).then(() => void order.push('fast')), 'late-fast');
      chain.push(never, 'late-stuck');
    }, 'origin');

    await chain.disposeAsync(30);

    expect(order, '快的迟到项在超时前已落定').toEqual(['fast']);
    expect(warnings).toEqual(['DisposableChain: 迟到登记的异步清理 [late-stuck] 超过 30ms，放弃等待']);
  });

  it('排空途中重复调用 disposeAsync 不扰动在途排空：之后的迟到登记仍由首个排空等到', async () => {
    const chain = new DisposableChain();
    const order: string[] = [];
    let release!: () => void;
    chain.push(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
      'slow',
    );

    const first = chain.disposeAsync().then(() => void order.push('first done'));
    const second = chain.disposeAsync();
    chain.push(() => sleep(10).then(() => void order.push('late done')), 'late');
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(['late done', 'first done']);
  });
});

describe('Resources 段收口等在飞撤回', () => {
  it('超时放弃时只点名仍未落定的撤回，等待期间已落定并出账的不点名', async () => {
    const { logger, warnings } = capture();
    const life = new Resources('t', logger);
    life.holdInflight(sleep(5), 'fast-withdraw');
    life.holdInflight(never(), 'stuck-withdraw');

    await life.disposeAsync(30);

    expect(warnings).toEqual(['Resources "t": 等待 stuck-withdraw 的撤回超过 30ms，放弃等待']);
  });
});

describe('Activation 等待在飞拆卸', () => {
  it('激活已被父级的关闭计划接管：后来者的 disposeAsync 超过自己的上限时告警并放弃等待', async () => {
    const { app, warnings } = world();
    const host = activationHost(app);
    const parent = host.create(rootActivation(app), 'parent');
    const child = host.create(parent, 'parent/child');
    child.resources.onDispose(never, 'stuck');

    let parentClosed = false;
    const closingParent = parent.disposeAsync(200).then(() => {
      parentClosed = true;
    });
    await child.disposeAsync(30);

    expect(parentClosed, '后来者按自己的 30ms 返回，不等在飞的父级计划').toBe(false);
    expect(warnings).toContain('激活 "parent/child": 等待在飞拆卸超过 30ms，放弃等待');
    await closingParent;
  });
});

describe('EventBus sticky 补发', () => {
  it('补发微任务执行前已退订的监听不再收到补发，仍在的监听照常收到', async () => {
    const bus = new EventBus();
    bus.markSticky('app:ready');
    await bus.emit('app:ready');

    const fired: string[] = [];
    const off = bus.on('app:ready', () => void fired.push('cancelled'));
    bus.on('app:ready', () => void fired.push('kept'));
    off();
    await tick();

    expect(fired).toEqual(['kept']);
  });
});

describe('HookRegistry 旧退订句柄', () => {
  const HOOK = '__t:kernel-edges-hook' as never;

  it('插件在 onDispose 里自行退订中间件：拆卸时钩子键已被整体清走，旧句柄无害返回、不产生告警', async () => {
    const { app, warnings } = world();
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'self-unsubscribe',
        uses: { hooks, lifecycle },
        apply({ hooks, lifecycle }) {
          lifecycle.onDispose(
            hooks.middleware(HOOK, async (_data, next) => {
              seen.push('plugin');
              await next();
            }),
          );
        },
      }),
    );
    const host = app.bind({ hooks });
    await host.hooks.run(HOOK, {} as never);
    expect(seen).toEqual(['plugin']);

    await app.plugins.unload('self-unsubscribe');

    expect(warnings, '按归属清走后再执行的退订闭包不得抛错').toEqual([]);
    seen.length = 0;
    const reached = await host.hooks.run(HOOK, {} as never, async () => void seen.push('default'));
    expect(reached).toBe(true);
    expect(seen).toEqual(['default']);
  });
});

describe('ServiceContainer 偏好与独占登记', () => {
  it('独占登记的服务：偏好指向别的 contextId 被拒且不记录、不通知；指向独占者本身则接受', async () => {
    const { app } = world();
    const Solo = defineService<{ v: number }>('__t:kernel-edges:solo');
    const host = app.bind({ provide, services, events });
    host.provide(Solo, { v: 1 }, { exclusive: true });
    const changed: string[] = [];
    host.events.on('service:preference-changed', name => void changed.push(name));

    expect(host.services.prefer(Solo, 'someone-else')).toBe(false);
    expect(host.services.preferred(Solo)).toBeUndefined();
    expect(host.services.get(Solo)?.v).toBe(1);
    await tick();
    expect(changed, '被拒的偏好不发变更通知').toEqual([]);

    expect(host.services.prefer(Solo, 'root')).toBe(true);
    expect(host.services.preferred(Solo)).toBe('root');
    await tick();
    expect(changed).toEqual([Solo.name]);
  });
});

describe('DefaultLogger 附加参数与时间戳渲染', () => {
  function collect(now?: () => Date) {
    const hub = new LogHub();
    const entries: { message: string; timestamp: string }[] = [];
    hub.onEntry(e => void entries.push({ message: e.message, timestamp: e.timestamp }));
    return { log: new DefaultLogger('t', 'debug', hub, now), entries };
  }

  it('普通对象与数组按 JSON 渲染，循环引用退化为 String 而不抛', () => {
    const { log, entries } = collect();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    log.info('ctx', { a: 1, b: [2, 'x'] }, [1, 'y']);
    log.info('loop', circular);
    expect(entries.map(e => e.message)).toEqual(['ctx {"a":1,"b":[2,"x"]} [1,"y"]', 'loop [object Object]']);
  });

  it('字符串原样、null/undefined 与数字、布尔、bigint、symbol 走 String', () => {
    const { log, entries } = collect();
    log.info('vals', 'plain', null, undefined, 42, true, 10n, Symbol('s'));
    expect(entries[0].message).toBe('vals plain null undefined 42 true 10 Symbol(s)');
  });

  it('没有 stack 的 Error 退化为 name: message', () => {
    const { log, entries } = collect();
    const err = new Error('no stack here');
    err.name = 'CustomError';
    err.stack = undefined;
    log.error('failed:', err);
    expect(entries[0].message).toBe('failed: CustomError: no stack here');
  });

  it('时间戳偏移：UTC 输出 Z，西区为负号，东区为正号且保留非整点分钟', () => {
    const at = (timezoneOffset: number) => {
      // 本地字段固定为 2026-01-02 03:04:05.006，只替换偏移，结果与运行机器的时区无关
      const d = new Date(2026, 0, 2, 3, 4, 5, 6);
      d.getTimezoneOffset = () => timezoneOffset;
      return d;
    };
    const stamps = [0, 210, -345].map(offset => {
      const { log, entries } = collect(() => at(offset));
      log.info('x');
      return entries[0].timestamp;
    });
    expect(stamps).toEqual([
      '2026-01-02T03:04:05.006Z',
      '2026-01-02T03:04:05.006-03:30',
      '2026-01-02T03:04:05.006+05:45',
    ]);
  });
});

describe('parseInstanceId', () => {
  it('只把 "/" 之后的 ":" 当实例后缀：与插件 name 的校验同一切分规则', () => {
    expect(parseInstanceId('@scope/plugin:main')).toEqual({ moduleName: '@scope/plugin', suffix: 'main' });
    expect(parseInstanceId('@scope/plugin')).toEqual({ moduleName: '@scope/plugin' });
    // definePlugin 接受 "/" 之前带 ":" 的 name；它作 instanceId 时必须整体还原成模块名
    const name = definePlugin({ name: 'odd:scope/plugin', apply() {} }).name;
    expect(parseInstanceId(name)).toEqual({ moduleName: 'odd:scope/plugin' });
    expect(parseInstanceId(`${name}:alt`)).toEqual({ moduleName: 'odd:scope/plugin', suffix: 'alt' });
  });
});

describe('registrar 换提供者重挂', () => {
  interface Item {
    key: string;
  }
  function hub(onRegister?: (item: Item) => void) {
    const live = new Set<string>();
    return {
      values: () => [...live],
      register(item: Item): () => void {
        live.add(item.key);
        onRegister?.(item);
        return () => void live.delete(item.key);
      },
    };
  }
  const Registry = defineService<ReturnType<typeof hub>, { add(item: Item): () => void }>(
    '__t:kernel-edges:registrar',
    port => port.registrar<Item>({ key: item => item.key, register: (provider, item) => provider.register(item) }),
  );

  it('重挂途中某条目在前一条的 register 回调里被退订：跳过它，不挂到新提供者、不告警', async () => {
    const { app, warnings } = world();
    const host = app.bind({ provide });
    const first = hub();
    host.provide(Registry, first, { onBehalfOf: 'prov-1' });

    let offB!: () => void;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { registry: Registry },
        apply({ registry }) {
          registry.add({ key: 'a' });
          offB = registry.add({ key: 'b' });
        },
      }),
    );
    await app.plugins.idle();
    expect(first.values()).toEqual(['a', 'b']);

    const second = hub(item => {
      if (item.key === 'a') offB();
    });
    host.provide(Registry, second, { priority: 1, onBehalfOf: 'prov-2' });
    await tick();

    expect(first.values()).toEqual([]);
    expect(second.values()).toEqual(['a']);
    expect(warnings).toEqual([]);
  });
});
