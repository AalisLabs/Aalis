import { afterEach, describe, expect, it } from 'vitest';
import {
  type App,
  type AppOptions,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { deferred } from '../helpers/deferred.js';
import { activationOf, createInspectableApp } from '../helpers/inspectable-app.js';

const dependency = defineService<{ value: number }>('activation-required-loss');
// apply 解构的绑定会遮住描述符；恢复提供者仍使用契约描述符。
const dependencyDescriptor = dependency;
const owned = defineService<{ attempt: number }>('activation-owned-resource');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

const apps: App[] = [];
const releases: Array<() => void> = [];
function world(options: Partial<AppOptions> = {}) {
  const errors: unknown[] = [];
  const debugs: string[] = [];
  const logger: Logger = {
    debug: (...args) => void debugs.push(args.map(String).join(' ')),
    info() {},
    warn() {},
    error: (...args) => void errors.push(...args),
    child: () => logger,
  };
  const app = createInspectableApp({
    logLevel: 'error',
    logger,
    disposeTimeoutMs: 0,
    ...options,
  });
  apps.push(app);
  const host = app.bind({ provide, services });
  return { app, host, errors, debugs };
}
const consumer = (app: App) => app.plugins.getPlugin('consumer')!;
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const app of apps.splice(0)) await app.stop();
});

describe('初始化期间 required 依赖消失', () => {
  it('撤回失败激活的登记、等真实资源清理后留 pending；依赖恢复重新 apply', async () => {
    const { app, host } = world();
    const entered = deferred();
    const applyGate = deferred();
    const cleanupEntered = deferred();
    const cleanupGate = deferred();
    releases.push(entered.resolve, applyGate.resolve, cleanupEntered.resolve, cleanupGate.resolve);
    const off = host.provide.use(dependency, { value: 1 });
    const live = new Set<number>();
    const cleaned: number[] = [];
    let applies = 0;
    const registering = app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency, provide, lifecycle },
        provides: [owned],
        async apply({ dependency, provide, lifecycle }) {
          const attempt = ++applies;
          live.add(attempt);
          provide.use(owned, { attempt });
          lifecycle.use.onDispose(async () => {
            if (attempt === 1) {
              cleanupEntered.resolve();
              await cleanupGate.promise;
            }
            live.delete(attempt);
            cleaned.push(attempt);
          });
          entered.resolve();
          await applyGate.promise;
          dependency.use.value;
        },
      }),
    );
    await entered.promise;
    off();
    applyGate.resolve();
    await cleanupEntered.promise;
    expect(host.services.use.get(owned.name), '登记先撤回，不能暴露失败激活').toBeUndefined();
    expect([...live], '资源清理正在等待真实完成').toEqual([1]);
    cleanupGate.resolve();
    await registering;
    await app.plugins.idle();
    expect(consumer(app).state).toBe('pending');
    expect(activationOf(app, 'consumer')).toBeUndefined();
    expect(consumer(app).error).toBeUndefined();
    expect(cleaned).toEqual([1]);
    expect([...live]).toEqual([]);

    host.provide.use(dependency, { value: 2 });
    await app.plugins.idle();
    expect(consumer(app).state).toBe('active');
    expect(applies).toBe(2);
    expect(host.services.use.get(owned.name)).toEqual({ attempt: 2 });
    await app.stop();
    expect(cleaned).toEqual([1, 2]);
    expect([...live]).toEqual([]);
  });

  it('catch 前已恢复仍回滚后重激活', async () => {
    const { app, host } = world();
    let off = host.provide.use(dependency, { value: 1 });
    const trace: string[] = [];
    let applies = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency, lifecycle },
        apply({ dependency, lifecycle }) {
          const attempt = ++applies;
          trace.push(`apply:${attempt}`);
          lifecycle.use.onDispose(() => {
            trace.push(`cleanup:${attempt}`);
          });
          if (attempt !== 1) return void dependency.use.value;
          off();
          try {
            dependency.use.value;
          } catch (error) {
            off = host.provide.use(dependencyDescriptor, { value: 2 });
            throw error;
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(consumer(app).state).toBe('active');
    expect(applies).toBe(2);
    expect(trace).toEqual(['apply:1', 'cleanup:1', 'apply:2']);
  });

  it('依赖在异步回滚期间恢复，也必须等旧资源清理完成才重新激活', async () => {
    const { app, host } = world();
    const cleanupEntered = deferred();
    const cleanupGate = deferred();
    releases.push(cleanupEntered.resolve, cleanupGate.resolve);
    const off = host.provide.use(dependency, { value: 1 });
    const trace: string[] = [];
    let applies = 0;
    const registering = app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency, lifecycle },
        apply({ dependency, lifecycle }) {
          const attempt = ++applies;
          trace.push(`apply:${attempt}`);
          if (attempt === 1) {
            lifecycle.use.onDispose(async () => {
              cleanupEntered.resolve();
              await cleanupGate.promise;
              trace.push('cleanup:1');
            });
            off();
          }
          dependency.use.value;
        },
      }),
    );
    await cleanupEntered.promise;
    host.provide.use(dependency, { value: 2 });
    await tick();
    expect(applies).toBe(1);
    expect(activationOf(app, 'consumer')).toBeDefined();
    cleanupGate.resolve();
    await registering;
    await app.plugins.idle();
    expect(consumer(app).state).toBe('active');
    expect(trace).toEqual(['apply:1', 'cleanup:1', 'apply:2']);
  });

  it.each([
    'business',
    'forged',
    'prototype-forged',
    'optional',
    'foreign',
  ] as const)('%s 错误即使撞上 required 缺席也仍为 error，不借用重试资格', async kind => {
    const { app, host } = world();
    let foreign: unknown;
    try {
      app.bind({ dependency }).dependency.use.value;
    } catch (error) {
      foreign = error;
    }
    const off = host.provide.use(dependency, { value: 1 });
    let applies = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency, maybe: optional(dependency) },
        apply({ maybe }) {
          applies++;
          off();
          if (kind === 'optional') return void maybe.use.value;
          if (kind === 'foreign') throw foreign;
          if (kind === 'prototype-forged') {
            throw Object.create(Object.getPrototypeOf(foreign), { message: { value: '伪造相同错误原型' } });
          }
          if (kind === 'forged') {
            const fake = new Error('服务 "activation-required-loss" 不可用（"consumer" 声明的依赖当前没有提供者）');
            fake.name = 'ServiceUnavailableError';
            throw fake;
          }
          throw new Error('业务处理失败');
        },
      }),
    );
    await app.plugins.idle();
    expect(consumer(app).state).toBe('error');
    expect(activationOf(app, 'consumer')).toBeUndefined();
    host.provide.use(dependency, { value: 2 });
    await app.plugins.idle();
    expect(consumer(app).state).toBe('error');
    expect(applies).toBe(1);
  });

  it('上一轮真实缺失错误被缓存后再次抛出，不得造成陈旧错误重试循环', async () => {
    const { app, host } = world();
    const off = host.provide.use(dependency, { value: 1 });
    let stale: unknown;
    let applies = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency },
        apply({ dependency }) {
          if (++applies > 1) throw stale;
          off();
          try {
            dependency.use.value;
          } catch (error) {
            stale = error;
            host.provide.use(dependencyDescriptor, { value: 2 });
            throw error;
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(applies).toBe(2);
    expect(consumer(app).state).toBe('error');
    expect(activationOf(app, 'consumer')).toBeUndefined();
  });

  it('初始化里连着 30 次用到已被撤的 required 依赖：每次回到 pending、依赖在就再装，不按次数停下；不再丢时照常激活', async () => {
    const { app, host, errors, debugs } = world();
    let off = host.provide.use(dependency, { value: 1 });
    let attempts = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency },
        apply({ dependency }) {
          if (++attempts > 30) return void dependency.use.value;
          off();
          try {
            dependency.use.value;
          } catch (error) {
            off = host.provide.use(dependencyDescriptor, { value: attempts });
            throw error;
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(attempts).toBe(31);
    expect(consumer(app).state).toBe('active');
    expect([consumer(app).error, consumer(app).failure]).toEqual([undefined, undefined]);
    expect(errors).toEqual([]);
    expect(debugs.filter(message => message.includes('等待依赖恢复'))).toHaveLength(30);
  });

  it('转入后台的初始化连着 12 次在途中丢 required 依赖：每次被拆、回到 pending、依赖回来再装，不按次数停下', async () => {
    const { app, host, errors, debugs } = world({ slowThresholdMs: 10, disposeTimeoutMs: 1000 });
    let off = host.provide.use(dependency, { value: 1 });
    let attempts = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency },
        async apply({ dependency }) {
          if (++attempts > 12) return void dependency.use.value;
          // 先转入后台，再让自己的 required 依赖下线：重算在 apply 抛错之前就把它拆掉
          await new Promise(resolve => setTimeout(resolve, 15));
          off();
          try {
            dependency.use.value;
          } catch (error) {
            off = host.provide.use(dependencyDescriptor, { value: attempts });
            throw error;
          }
        },
      }),
    );
    const deadline = Date.now() + 5000;
    while (consumer(app).state !== 'active' && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    await app.plugins.idle();
    expect(attempts).toBe(13);
    // 12 次都是转入后台之后被重算拆掉的：apply 随后抛出的不可用错误落在已被接手的激活上
    expect(debugs.filter(message => message.includes('激活中止且已被接手'))).toHaveLength(12);
    expect(consumer(app).state).toBe('active');
    expect([consumer(app).error, consumer(app).failure]).toEqual([undefined, undefined]);
    expect(errors).toEqual([]);
  });

  it.each(['disable', 'unload', 'stop'] as const)('%s 接管在飞初始化后，缺失错误不得抢回状态或重激活', async action => {
    const { app, host } = world();
    const entered = deferred();
    const gate = deferred();
    releases.push(entered.resolve, gate.resolve);
    const off = host.provide.use(dependency, { value: 1 });
    let applies = 0;
    let cleaned = 0;
    const registering = app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency, lifecycle },
        async apply({ dependency, lifecycle }) {
          applies++;
          lifecycle.use.onDispose(() => {
            cleaned++;
          });
          entered.resolve();
          await gate.promise;
          dependency.use.value;
        },
      }),
    );
    await entered.promise;
    off();
    const managing = action === 'stop' ? app.stop() : app.plugins[action]('consumer');
    gate.resolve();
    await Promise.all([registering, managing]);
    await app.plugins.idle();
    expect(applies).toBe(1);
    expect(cleaned).toBe(1);
    if (action === 'unload') expect(app.plugins.getPlugin('consumer')).toBeUndefined();
    else {
      expect(consumer(app).state).toBe(action === 'stop' ? 'disposed' : 'disabled');
      expect(activationOf(app, 'consumer')).toBeUndefined();
    }
  });
});
