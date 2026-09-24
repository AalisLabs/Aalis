import { afterEach, describe, expect, it } from 'vitest';
import {
  type App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import type { PluginManager } from '../../packages/core/src/orchestration/plugin.js';
import type { PluginRecord } from '../../packages/core/src/orchestration/plugin-activation.js';
import { activationHost, createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

const dependency = defineService<{ value: number }>('activation-required-loss');
// apply 解构的绑定会遮住描述符；恢复提供者仍使用契约描述符。
const dependencyDescriptor = dependency;
const owned = defineService<{ attempt: number }>('activation-owned-resource');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

const apps: App[] = [];
const releases: Array<() => void> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}
function world() {
  const errors: unknown[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args) => void warnings.push(args.map(String).join(' ')),
    error: (...args) => void errors.push(...args),
    child: () => logger,
  };
  const app = createInspectableApp({
    config: { name: 'T', plugins: {}, logLevel: 'error' },
    logger,
    disposeTimeoutMs: 0,
  });
  apps.push(app);
  const host = app.bind({ provide, services });
  return { app, host, errors, warnings, logger };
}
function record(app: App) {
  return app.plugins.getPlugin('consumer') as PluginRecord;
}
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
    const off = host.provide(dependency, { value: 1 });
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
          provide(owned, { attempt });
          lifecycle.onDispose(async () => {
            if (attempt === 1) {
              cleanupEntered.resolve();
              await cleanupGate.promise;
            }
            live.delete(attempt);
            cleaned.push(attempt);
          });
          entered.resolve();
          await applyGate.promise;
          dependency.require();
        },
      }),
    );
    await entered.promise;
    off();
    applyGate.resolve();
    await cleanupEntered.promise;
    expect(host.services.get(owned.name), '登记先撤回，不能暴露失败激活').toBeUndefined();
    expect([...live], '资源清理正在等待真实完成').toEqual([1]);
    cleanupGate.resolve();
    await registering;
    await app.plugins.idle();
    expect(record(app).state).toBe('pending');
    expect(record(app).activation).toBeUndefined();
    expect(record(app).error).toBeUndefined();
    expect(cleaned).toEqual([1]);
    expect([...live]).toEqual([]);

    host.provide(dependency, { value: 2 });
    await app.plugins.idle();
    expect(record(app).state).toBe('active');
    expect(applies).toBe(2);
    expect(host.services.get(owned.name)).toEqual({ attempt: 2 });
    await app.stop();
    expect(cleaned).toEqual([1, 2]);
    expect([...live]).toEqual([]);
  });

  it.each([false, true])('catch 前已恢复仍回滚后重激活，不依赖变化通知来补重试（通知切断=%s）', async muted => {
    const { app, host } = world();
    // 切断根激活的全部监听（含 PluginManager 对服务上下线的订阅）：重试不能依赖另一条通知补唤醒
    if (muted) activationHost(app).runtime.events.unregisterByOwner(rootActivation(app).owner);
    let off = host.provide(dependency, { value: 1 });
    const trace: string[] = [];
    let applies = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency, lifecycle },
        apply({ dependency, lifecycle }) {
          const attempt = ++applies;
          trace.push(`apply:${attempt}`);
          lifecycle.onDispose(() => {
            trace.push(`cleanup:${attempt}`);
          });
          if (attempt !== 1) return void dependency.require();
          off();
          try {
            dependency.require();
          } catch (error) {
            off = host.provide(dependencyDescriptor, { value: 2 });
            throw error;
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(record(app).state).toBe('active');
    expect(applies).toBe(2);
    expect(trace).toEqual(['apply:1', 'cleanup:1', 'apply:2']);
  });

  it('依赖在异步回滚期间恢复，也必须等旧资源清理完成才重新激活', async () => {
    const { app, host } = world();
    const cleanupEntered = deferred();
    const cleanupGate = deferred();
    const off = host.provide(dependency, { value: 1 });
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
            lifecycle.onDispose(async () => {
              cleanupEntered.resolve();
              await cleanupGate.promise;
              trace.push('cleanup:1');
            });
            off();
          }
          dependency.require();
        },
      }),
    );
    await cleanupEntered.promise;
    host.provide(dependency, { value: 2 });
    await tick();
    expect(applies).toBe(1);
    expect(record(app).activation).toBeDefined();
    cleanupGate.resolve();
    await registering;
    await app.plugins.idle();
    expect(record(app).state).toBe('active');
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
      app.bind({ dependency }).dependency.require();
    } catch (error) {
      foreign = error;
    }
    const off = host.provide(dependency, { value: 1 });
    let applies = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency, maybe: optional(dependency) },
        apply({ maybe }) {
          applies++;
          off();
          if (kind === 'optional') return void maybe.require();
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
    expect(record(app).state).toBe('error');
    expect(record(app).activation).toBeUndefined();
    host.provide(dependency, { value: 2 });
    await app.plugins.idle();
    expect(record(app).state).toBe('error');
    expect(applies).toBe(1);
  });

  it('上一轮真实缺失错误被缓存后再次抛出，不得造成陈旧错误重试循环', async () => {
    const { app, host } = world();
    const off = host.provide(dependency, { value: 1 });
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
            dependency.require();
          } catch (error) {
            stale = error;
            host.provide(dependencyDescriptor, { value: 2 });
            throw error;
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(applies).toBe(2);
    expect(record(app).state).toBe('error');
    expect(record(app).activation).toBeUndefined();
  });

  it.each([
    'ordinary',
    'recompute',
    'register',
  ] as const)('持续制造真实缺失也须有界，%s 不能重置同一 flight 的自动重试预算', async mode => {
    const { app, host, warnings } = world();
    let off = host.provide(dependency, { value: 1 });
    let attempts = 0;
    let firstLimit = 0;
    let helpers = 0;
    let stable = false;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency },
        async apply({ dependency }) {
          attempts++;
          if (stable) return void dependency.require();
          // 错误实现也只能跑到保险丝，不能让测试挂死或占满微任务队列。
          if (attempts === 31) throw new Error('测试保险丝：自动重试未被收敛预算拦住');
          if (mode === 'recompute') await (app.plugins as PluginManager).recompute();
          if (mode === 'register') {
            await app.plugin(definePlugin({ name: `helper-${attempts}`, apply: () => void helpers++ }));
          }
          if (attempts === 1) firstLimit = app.plugins.getStatus().length * 2 + 8;
          off();
          try {
            dependency.require();
          } catch (error) {
            off = host.provide(dependencyDescriptor, { value: attempts });
            throw error;
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(attempts).toBeLessThanOrEqual(firstLimit);
    expect(record(app).state).toBe('pending');
    expect(record(app).activation).toBeUndefined();
    expect(record(app).error).toBeUndefined();
    expect(warnings.filter(message => message.includes('未收敛'))).toHaveLength(1);
    if (mode === 'register') expect(helpers, '新注册的正常插件仍须完成激活').toBe(attempts);

    stable = true;
    const previous = attempts;
    await (app.plugins as PluginManager).recompute();
    await app.plugins.idle();
    expect(record(app).state).toBe('active');
    expect(attempts).toBe(previous + 1);
  });

  it('预算告警里的新注册与 enable 请求不丢失，只暂缓失稳的 entry', async () => {
    const { app, host, logger } = world();
    let enabled = 0;
    await app.plugin(definePlugin({ name: 'normal', apply: () => void enabled++ }));
    await app.plugins.disable('normal');
    let inserted = 0;
    const operations: Promise<unknown>[] = [];
    const warn = logger.warn;
    let acted = false;
    logger.warn = (...args) => {
      warn(...args);
      if (acted || !String(args[0]).includes('未收敛')) return;
      acted = true;
      operations.push(app.plugin(definePlugin({ name: 'inserted', apply: () => void inserted++ })));
      operations.push(app.plugins.enable('normal'));
    };
    let off = host.provide(dependency, { value: 1 });
    let attempts = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency },
        apply({ dependency }) {
          if (++attempts === 41) throw new Error('测试保险丝：自动重试未被收敛预算拦住');
          off();
          try {
            dependency.require();
          } catch (error) {
            off = host.provide(dependencyDescriptor, { value: attempts });
            throw error;
          }
        },
      }),
    );
    await Promise.all(operations);
    await app.plugins.idle();
    expect(attempts).toBeLessThanOrEqual(12);
    expect(record(app).state).toBe('pending');
    expect(app.plugins.getPlugin('inserted')?.state).toBe('active');
    expect(app.plugins.getPlugin('normal')?.state).toBe('active');
    expect([inserted, enabled]).toEqual([1, 2]);
  });

  it.each(['disable', 'unload', 'stop'] as const)('%s 接管在飞初始化后，缺失错误不得抢回状态或重激活', async action => {
    const { app, host } = world();
    const entered = deferred();
    const gate = deferred();
    const off = host.provide(dependency, { value: 1 });
    let applies = 0;
    let cleaned = 0;
    const registering = app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { dependency, lifecycle },
        async apply({ dependency, lifecycle }) {
          applies++;
          lifecycle.onDispose(() => {
            cleaned++;
          });
          entered.resolve();
          await gate.promise;
          dependency.require();
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
    if (action === 'unload') expect(record(app)).toBeUndefined();
    else {
      expect(record(app).state).toBe(action === 'stop' ? 'disposed' : 'disabled');
      expect(record(app).activation).toBeUndefined();
    }
  });
});
