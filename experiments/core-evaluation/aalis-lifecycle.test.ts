import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  App,
  ConfigManager,
  Context,
  ContributionRegistry,
  EventBus,
  HookRegistry,
  type Logger,
  ServiceContainer,
} from '../../packages/core/src/index.js';

// Evaluation probes, intentionally outside the normal test/ suite. A green
// probe means its observation was reproduced; contractPassed is the separate
// product assessment. No production implementation or external resource is used.
type Observation = {
  id: string;
  contract: string;
  contractPassed: boolean;
  expected: unknown;
  observed: unknown;
  source: string[];
};

const observations: Observation[] = [];
const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

function rootContext(): Context {
  return new Context({
    id: 'evaluation-root',
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger: silentLogger,
    config: new ConfigManager({ name: 'Core evaluation', logLevel: 'error', plugins: {} }),
  });
}

function memoryApp(): App {
  return new App({
    config: { name: 'Core evaluation', logLevel: 'error', plugins: {} },
    logger: silentLogger,
    disposeTimeoutMs: 1_000,
  });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

afterAll(() => {
  const path = fileURLToPath(new URL('./results/aalis-lifecycle-contracts.json', import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        suite: 'aalis-lifecycle',
        interpretation: 'Vitest pass means baseline reproduced; contractPassed evaluates the stated contract.',
        observations,
      },
      null,
      2,
    )}\n`,
  );
});

describe('Aalis Core lifecycle and provider contract evaluation', () => {
  it('provider preference, fallback, and replacement only remount on winner changes', async () => {
    const root = rootContext();
    const providerA = root.fork('provider-a');
    const providerB = root.fork('provider-b');
    const providerC = root.fork('provider-c');
    const watcher = root.fork('watcher');
    const trace: string[] = [];
    const winners: string[] = [];
    type Provider = { id: string };

    try {
      providerA.provide('evaluation-service', { id: 'a' }, { priority: 100 });
      const removeB = providerB.provide('evaluation-service', { id: 'b' }, { priority: 10 });
      const stopWatching = watcher.whenService<Provider>('evaluation-service', service => {
        trace.push(`attach:${service.id}`);
        return () => trace.push(`cleanup:${service.id}`);
      });
      const readWinner = () => {
        const winner = root.getService<Provider>('evaluation-service');
        const all = root.getAllServices<Provider>('evaluation-service');
        expect(all[0]?.instance).toBe(winner);
        winners.push(winner?.id ?? 'absent');
      };

      readWinner();
      const removeC = providerC.provide('evaluation-service', { id: 'c' }, { priority: -10 });
      removeC();
      const afterLoserChurn = [...trace];
      root.preferService('evaluation-service', 'provider-b');
      readWinner();
      removeB();
      readWinner();
      providerB.provide('evaluation-service', { id: 'b2' }, { priority: 10 });
      readWinner();
      stopWatching();

      const observed = { winners, afterLoserChurn, trace };
      const expected = {
        winners: ['a', 'b', 'a', 'b2'],
        afterLoserChurn: ['attach:a'],
        trace: ['attach:a', 'cleanup:a', 'attach:b', 'cleanup:b', 'attach:a', 'cleanup:a', 'attach:b2', 'cleanup:b2'],
      };
      expect(observed).toEqual(expected);
      observations.push({
        id: 'provider-winner-switching',
        contract:
          'Preference overrides priority; unavailable preference falls back; losing providers do not remount watchers.',
        contractPassed: true,
        expected,
        observed,
        source: ['packages/core/src/services.ts:99', 'packages/core/src/context.ts:402'],
      });
    } finally {
      await root.disposeAsync();
    }
  });

  it('unloading an initializing plugin waits for its later asynchronous disposer', async () => {
    const app = memoryApp();
    const entered = deferred();
    const acquire = deferred();
    const cleanupEntered = deferred();
    const finishCleanup = deferred();
    const trace: string[] = [];
    let unloadingSettled = false;
    let registering: Promise<unknown> | undefined;
    let unloading: Promise<void> | undefined;

    try {
      registering = app.plugin({
        name: 'initializing-provider',
        async apply(ctx) {
          trace.push('apply-entered');
          entered.release();
          await acquire.promise;
          trace.push('acquired');
          ctx.onDispose(async () => {
            trace.push('cleanup-entered');
            cleanupEntered.release();
            await finishCleanup.promise;
            trace.push('cleanup-finished');
          });
          ctx.provide('late-service', { id: 'should-not-register-after-unload' });
        },
      });
      await entered.promise;
      unloading = app.plugins.unload('initializing-provider').then(() => {
        unloadingSettled = true;
        trace.push('unload-returned');
      });
      acquire.release();
      await cleanupEntered.promise;
      const settledBeforeCleanup = unloadingSettled;
      finishCleanup.release();
      await Promise.all([registering, unloading]);
      await app.plugins.idle();

      const observed = {
        settledBeforeCleanup,
        trace,
        servicePresent: app.ctx.getService('late-service') !== undefined,
        pluginPresent: app.plugins.getPlugin('initializing-provider') !== undefined,
      };
      const expected = {
        settledBeforeCleanup: false,
        trace: ['apply-entered', 'acquired', 'cleanup-entered', 'cleanup-finished', 'unload-returned'],
        servicePresent: false,
        pluginPresent: false,
      };
      expect(observed).toEqual(expected);
      observations.push({
        id: 'initialization-unload-ordering',
        contract:
          'Unload waits for initialization and asynchronous cleanup; late service registration cannot resurrect the plugin.',
        contractPassed: true,
        expected,
        observed,
        source: [
          'packages/core/src/context.ts:807',
          'packages/core/src/context.ts:834',
          'packages/core/src/plugin-activation.ts:127',
        ],
      });
    } finally {
      acquire.release();
      finishCleanup.release();
      await Promise.allSettled([registering, unloading]);
      await app.stop();
    }
  });

  it('observes lost optional-service bounce when service-down is queued during another activation', async () => {
    async function scenario(contended: boolean) {
      const app = memoryApp();
      const blockEntered = deferred();
      const releaseBlock = deferred();
      let blocker: Promise<unknown> | undefined;
      let activations = 0;
      let cleanups = 0;
      let capturedProvider: unknown;
      const originalProvider = { id: 'external-provider' };
      const owner = app.ctx.fork('external-provider');

      try {
        const removeProvider = owner.provide('optional-resource', originalProvider);
        await app.plugins.idle();
        await app.plugin({
          name: 'caching-optional-consumer',
          inject: { optional: ['optional-resource'] },
          requiresBounceOnDepChange: true,
          apply(ctx) {
            activations++;
            capturedProvider = ctx.getService('optional-resource');
            ctx.onDispose(() => {
              cleanups++;
            });
          },
        });
        await app.plugins.idle();

        if (contended) {
          blocker = app.plugin({
            name: 'unrelated-initializing-plugin',
            async apply() {
              blockEntered.release();
              await releaseBlock.promise;
            },
          });
          await blockEntered.promise;
        }
        removeProvider();
        releaseBlock.release();
        await blocker;
        await app.plugins.idle();
        return {
          activations,
          cleanups,
          consumerState: app.plugins.getPlugin('caching-optional-consumer')?.state,
          providerAvailable: app.ctx.getService('optional-resource') !== undefined,
          retainedRemovedProvider: capturedProvider === originalProvider,
        };
      } finally {
        releaseBlock.release();
        await blocker;
        await app.stop();
      }
    }

    const idle = await scenario(false);
    const contended = await scenario(true);
    expect(idle).toEqual({
      activations: 2,
      cleanups: 1,
      consumerState: 'active',
      providerAvailable: false,
      retainedRemovedProvider: false,
    });
    expect(contended).toEqual({
      activations: 1,
      cleanups: 0,
      consumerState: 'active',
      providerAvailable: false,
      retainedRemovedProvider: true,
    });
    observations.push({
      id: 'queued-optional-service-down',
      contract:
        'An optional consumer opting into requiresBounceOnDepChange should remount after provider loss, including during unrelated activation.',
      contractPassed: false,
      expected: { idle, contended: idle },
      observed: { idle, contended },
      source: ['packages/core/src/plugin.ts:452', 'packages/core/src/plugin-activation.ts:83'],
    });
  });

  it('observes overwritten cleanup when a whenService callback synchronously changes the winner', async () => {
    const root = rootContext();
    const providerA = root.fork('provider-a');
    const providerB = root.fork('provider-b');
    const watcher = root.fork('watcher');
    const activeSubscriptions = new Set<string>();
    const trace: string[] = [];

    try {
      providerA.provide('reentrant-service', { id: 'a' }, { priority: 100 });
      providerB.provide('reentrant-service', { id: 'b' }, { priority: 10 });
      const stopWatching = watcher.whenService<{ id: string }>('reentrant-service', service => {
        activeSubscriptions.add(service.id);
        trace.push(`attach:${service.id}`);
        // Models a consumer discovering that a provider cannot meet its needs
        // and selecting the already registered alternate from its attach callback.
        if (service.id === 'a') root.preferService('reentrant-service', 'provider-b');
        return () => {
          trace.push(`cleanup:${service.id}`);
          activeSubscriptions.delete(service.id);
        };
      });
      const beforeStop = [...activeSubscriptions].sort();
      stopWatching();
      const afterStop = [...activeSubscriptions].sort();
      const observed = {
        currentWinner: root.getService<{ id: string }>('reentrant-service')?.id,
        beforeStop,
        afterStop,
        trace,
      };
      expect(observed).toEqual({
        currentWinner: 'b',
        beforeStop: ['a', 'b'],
        afterStop: ['b'],
        trace: ['attach:a', 'attach:b', 'cleanup:a'],
      });
      observations.push({
        id: 'whenservice-reentrant-provider-switch',
        contract:
          'Each returned cleanup runs once when superseded or unsubscribed, including a provider switch inside the callback.',
        contractPassed: false,
        expected: { currentWinner: 'b', beforeStop: ['b'], afterStop: [], cleanups: ['a', 'b'] },
        observed,
        source: [
          'packages/core/src/context.ts:402',
          'packages/core/src/context.ts:433',
          'docs/design/core-contract.md:19',
        ],
      });
    } finally {
      // The probe's subscriptions are just strings; removing them is cleanup of
      // the observation, not a workaround installed in the tested implementation.
      activeSubscriptions.clear();
      await root.disposeAsync();
    }
  });
});
