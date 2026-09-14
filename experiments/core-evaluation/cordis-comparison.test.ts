/**
 * Runs the actual DSH-vendored Cordis source, selected by the comparison config.
 * Pinned DSH revision: c291e7961a515f6d7af9304e7fd1d257929aef26.
 *
 * These are observed contracts, not an assertion that every different contract
 * is a defect. In particular, Cordis selects services by explicit isolation
 * labels and rejects duplicate providers within a label; it does not arbitrate
 * competing providers in one scope by priority.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Context as AalisContext,
  ConfigManager,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '@aalis/core';
import { Context, FiberState, Service } from '@deepseek-ai/cordis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

declare module '@deepseek-ai/cordis' {
  interface Events {
    'core-evaluation/ping': (value: string) => void;
  }
}

declare module '@aalis/core' {
  interface AalisEvents {
    'core-evaluation/ping': [value: string];
  }
}

const roots: Context[] = [];
const aalisRoots: AalisContext[] = [];
type Observation = {
  case: string;
  engine: 'cordis' | 'aalis';
  observed: Record<string, unknown>;
  desiredScenario: string;
  interpretation: string;
};
const observations: Observation[] = [];

function observe(
  caseId: string,
  engine: Observation['engine'],
  observed: Observation['observed'],
  desiredScenario: string,
  interpretation: string,
) {
  observations.push({ case: caseId, engine, observed, desiredScenario, interpretation });
}

function rootContext(): Context {
  const root = new Context();
  roots.push(root);
  return root;
}

function aalisRoot(): AalisContext {
  const root = new AalisContext({
    id: 'evaluation-root',
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger: new DefaultLogger('core-evaluation', 'error'),
    config: new ConfigManager({ name: 'Core evaluation', logLevel: 'error', plugins: {} }),
  });
  aalisRoots.push(root);
  return root;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(fulfill => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  for (const root of aalisRoots.splice(0)) await root.disposeAsync();
});

afterAll(async () => {
  const directory = resolve(import.meta.dirname, 'results');
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'cordis-comparison.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'observed semantic comparison; passing tests do not imply universal capability parity',
        dshRevision: 'c291e7961a515f6d7af9304e7fd1d257929aef26',
        dshSourceDirectory: process.env.DSH_SOURCE_DIR,
        node: process.version,
        scope: 'Cordis kernel versus Aalis Context; Aalis whenService is not a PluginManager activation test',
        observations,
      },
      null,
      2,
    )}\n`,
  );
});

describe('DSH Cordis: service resolution and scope contracts', () => {
  it('C1: rejects a second provider in the same service scope', () => {
    const root = rootContext();
    root.provide('evaluationValue', { name: 'first' });

    expect(() => root.provide('evaluationValue', { name: 'second' })).toThrow(/has been registered/);
    expect(root.get('evaluationValue').name).toBe('first');
    observe(
      'C1',
      'cordis',
      { duplicateAccepted: false, winner: root.get('evaluationValue').name },
      'Several implementations compete for a default within one service scope',
      'Intentional contract: one provider per isolation label; use explicit scopes for multiple implementations.',
    );
  });

  it('C2: explicitly isolated child providers coexist without changing parent or sibling', () => {
    const root = rootContext();
    root.provide('evaluationValue', { name: 'root' });
    const ordinaryChild = root.extend();
    const left = root.isolate('evaluationValue');
    const right = root.isolate('evaluationValue');

    // extend() inherits a service scope. isolate() creates an empty replacement
    // scope; an unprovided isolated service does not fall back to the parent.
    expect(ordinaryChild.get('evaluationValue').name).toBe('root');
    expect(left.get('evaluationValue')).toBeUndefined();
    expect(right.get('evaluationValue')).toBeUndefined();

    left.provide('evaluationValue', { name: 'left' });
    right.provide('evaluationValue', { name: 'right' });
    expect(root.get('evaluationValue').name).toBe('root');
    expect(ordinaryChild.get('evaluationValue').name).toBe('root');
    expect(left.get('evaluationValue').name).toBe('left');
    expect(left.extend().get('evaluationValue').name).toBe('left');
    expect(right.get('evaluationValue').name).toBe('right');
    observe(
      'C2',
      'cordis',
      {
        parent: root.get('evaluationValue').name,
        left: left.get('evaluationValue').name,
        right: right.get('evaluationValue').name,
      },
      'Override one branch without affecting the parent or sibling',
      'Achieved by explicit isolate(); extend() alone inherits, and empty isolated services do not fall back.',
    );
  });

  it('C3: sharing an isolation label deliberately joins service scopes', () => {
    const root = rootContext();
    const label = Symbol('shared evaluation scope');
    const left = root.isolate('evaluationValue', label);
    const right = root.isolate('evaluationValue', label);
    left.provide('evaluationValue', { name: 'shared' });

    expect(left.get('evaluationValue')).toBe(right.get('evaluationValue'));
    expect(root.get('evaluationValue')).toBeUndefined();
    expect(() => right.provide('evaluationValue', { name: 'duplicate' })).toThrow(/has been registered/);
    observe(
      'C3',
      'cordis',
      {
        sharedIdentity: left.get('evaluationValue') === right.get('evaluationValue'),
        visibleAtRoot: root.get('evaluationValue') !== undefined,
      },
      'Join selected service scopes without exposing the service at the root',
      'Achieved by reusing the same isolation label.',
    );
  });

  it('C4: missing, removed, and replaced dependencies gate and restart the consumer', async () => {
    const root = rootContext();
    const observations: string[] = [];
    const consumer = await root.inject(['evaluationValue'], ctx => {
      const name = ctx.get('evaluationValue').name;
      observations.push(`start:${name}`);
      return () => {
        observations.push(`stop:${name}`);
      };
    });
    expect(consumer.state).toBe(FiberState.PENDING);
    expect(observations).toEqual([]);

    const first = await root.plugin(ctx => {
      ctx.provide('evaluationValue', { name: 'first' });
    });
    await consumer.await();
    expect(observations).toEqual(['start:first']);

    await first.dispose();
    expect(consumer.state).toBe(FiberState.PENDING);
    expect(observations).toEqual(['start:first', 'stop:first']);

    await root.plugin(ctx => {
      ctx.provide('evaluationValue', { name: 'second' });
    });
    await consumer.await();
    expect(consumer.state).toBe(FiberState.ACTIVE);
    expect(observations).toEqual(['start:first', 'stop:first', 'start:second']);
    observe(
      'C4',
      'cordis',
      { transitions: [...observations], active: consumer.state === FiberState.ACTIVE },
      'Wait for a service and cleanly attach to its replacement',
      'inject() gates the entire dependent Fiber and restarts it when the provider changes.',
    );
  });
});

describe('DSH Cordis: ownership, disposal, and event routing', () => {
  it('C5: unloading a parent removes its service, child listener, and child resource', async () => {
    const root = rootContext();
    const observations: string[] = [];
    let liveResources = 0;
    const parent = await root.plugin(async ctx => {
      ctx.provide('evaluationValue', { name: 'owned' });
      await ctx.plugin(child => {
        child.on('core-evaluation/ping', value => observations.push(value));
        child.effect(() => {
          liveResources += 1;
          return () => {
            liveResources -= 1;
          };
        });
      });
    });

    root.emit('core-evaluation/ping', 'before');
    expect(root.get('evaluationValue').name).toBe('owned');
    expect(liveResources).toBe(1);
    expect(observations).toEqual(['before']);

    await parent.dispose();
    root.emit('core-evaluation/ping', 'after');
    expect(root.get('evaluationValue')).toBeUndefined();
    expect(liveResources).toBe(0);
    expect(observations).toEqual(['before']);
    expect(root.registry.size).toBe(0);
    observe(
      'C5',
      'cordis',
      {
        liveResources,
        eventCalls: [...observations],
        serviceVisible: root.get('evaluationValue') !== undefined,
        livePluginRuntimes: root.registry.size,
      },
      'Parent unload removes nested registrations and resources',
      'Achieved for resources registered through effects and child fibers.',
    );
  });

  it('C6: disposal waits until an asynchronous resource cleanup actually completes', async () => {
    const root = rootContext();
    const started = deferred();
    const release = deferred();
    let cleaned = false;
    let settled = false;
    const fiber = await root.plugin(ctx => {
      ctx.effect(() => async () => {
        started.resolve();
        await release.promise;
        cleaned = true;
      });
    });

    const disposal = fiber.dispose().then(() => {
      settled = true;
    });
    try {
      await started.promise;
      expect(cleaned).toBe(false);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await disposal;
    }
    expect(cleaned).toBe(true);
    expect(settled).toBe(true);
    observe(
      'C6',
      'cordis',
      { cleanedAtResolution: cleaned, disposalResolved: settled },
      'Await disposal until asynchronous cleanup completes',
      'Fiber.dispose() waits for registered asynchronous effects.',
    );
  });

  it.each([
    false,
    true,
  ])('C7: service-created resources belong to the calling plugin (await before effect: %s)', async crossAwait => {
    const root = rootContext();
    const leases = new Set<string>();

    class LeaseService extends Service {
      constructor(ctx: Context) {
        super(ctx, 'evaluationLeases');
      }

      async acquire(name: string) {
        if (crossAwait) await Promise.resolve();
        this.ctx.effect(() => {
          leases.add(name);
          return () => {
            leases.delete(name);
          };
        });
      }
    }

    const provider = await root.plugin(LeaseService);
    const first = await root.inject(['evaluationLeases'], async ctx => {
      await (ctx.get('evaluationLeases') as LeaseService).acquire('first');
    });
    const second = await root.inject(['evaluationLeases'], async ctx => {
      await (ctx.get('evaluationLeases') as LeaseService).acquire('second');
    });
    expect([...leases]).toEqual(['first', 'second']);

    await first.dispose();
    expect([...leases]).toEqual(['second']);
    const afterFirstDispose = [...leases];
    expect(provider.state).toBe(FiberState.ACTIVE);
    expect(second.state).toBe(FiberState.ACTIVE);

    await second.dispose();
    expect(leases.size).toBe(0);
    expect(provider.state).toBe(FiberState.ACTIVE);
    observe(
      `C7-${crossAwait ? 'async' : 'sync'}`,
      'cordis',
      {
        afterFirstDispose,
        afterBothDispose: [...leases],
        providerStillActive: provider.state === FiberState.ACTIVE,
      },
      'Resources created through a shared service follow the caller lifetime',
      'Traceable Service proxies transfer effect ownership to the calling Fiber, including across an await.',
    );
  });

  it('C8: an explicit filtered event receiver routes locally; global listeners opt out', () => {
    const root = rootContext();
    const left = root.extend({ evaluationBranch: 'left' });
    const right = root.extend({ evaluationBranch: 'right' });
    const observations: string[] = [];
    left.on('core-evaluation/ping', () => observations.push('left'));
    right.on('core-evaluation/ping', () => observations.push('right'));
    right.on('core-evaluation/ping', () => observations.push('global'), { global: true });
    const receiver = {
      [Context.filter](ctx: Context) {
        return Reflect.get(ctx, 'evaluationBranch') === 'left';
      },
    };

    root.emit(receiver, 'core-evaluation/ping', 'filtered');
    expect(observations).toEqual(['left', 'global']);
    observe(
      'C8',
      'cordis',
      { recipients: [...observations] },
      'Route an event to one logical branch',
      'Explicit Context.filter receiver selects the branch; global listeners intentionally bypass filtering.',
    );
  });

  it.each([
    false,
    true,
  ])('C9: provider-resource shutdown order depends on explicit effect composition (grouped: %s)', async grouped => {
    const root = rootContext();
    const seen: string[] = [];
    const resource = { closed: false };
    const close = () => {
      resource.closed = true;
      seen.push('provider:close');
    };
    const provider = await root.plugin(ctx => {
      if (grouped) {
        // Within one effect, yielded disposers unwind in reverse order.
        // Withdraw the service and await its consumers before closing it.
        ctx.effect(function* () {
          yield close;
          yield ctx.provide('evaluationValue', resource);
        });
      } else {
        // These are distinct top-level effects. Cordis drains them in
        // parallel, so the provider may close before consumers finish.
        ctx.provide('evaluationValue', resource);
        ctx.effect(() => close);
      }
    });
    const consumer = await root.inject(['evaluationValue'], ctx => {
      const current = ctx.get('evaluationValue') as typeof resource;
      return async () => {
        await Promise.resolve();
        seen.push(`consumer:saw-${current.closed ? 'closed' : 'open'}`);
      };
    });

    await provider.dispose();
    expect(consumer.state).toBe(FiberState.PENDING);
    expect(seen).toEqual(grouped ? ['consumer:saw-open', 'provider:close'] : ['provider:close', 'consumer:saw-closed']);
    observe(
      `C9-${grouped ? 'grouped' : 'independent'}`,
      'cordis',
      { shutdownOrder: [...seen], consumerSawOpenProvider: seen.includes('consumer:saw-open') },
      'Keep a provider resource usable until dependent cleanup has completed',
      grouped
        ? 'Achieved with an explicit composite effect that unregisters the service before closing its resource.'
        : 'Not automatic across independent top-level effects: unload runs them concurrently. This contract needs deliberate resource composition.',
    );
  });
});

describe('Aalis: matching scenarios with its native Context contracts', () => {
  it('C1: keeps multiple providers and chooses by preference, priority, then registration order', async () => {
    const root = aalisRoot();
    const first = root.fork('first-provider');
    const second = root.fork('second-provider');
    first.provide('evaluationValue', { name: 'first' }, { priority: 10 });
    second.provide('evaluationValue', { name: 'second' }, { priority: 20 });
    const winner = () => root.getService<{ name: string }>('evaluationValue')?.name;
    const selected = [winner()];
    root.preferService('evaluationValue', first.id);
    selected.push(winner());
    root.unpreferService('evaluationValue');
    selected.push(winner());
    await second.disposeAsync();
    selected.push(winner());
    expect(selected).toEqual(['second', 'first', 'second', 'first']);

    const equal = root.fork('equal-provider');
    equal.provide('evaluationValue', { name: 'equal' }, { priority: 10 });
    expect(winner()).toBe('first');
    expect(root.getAllServices('evaluationValue')).toHaveLength(2);
    observe(
      'C1',
      'aalis',
      {
        duplicateAccepted: true,
        winnerTransitions: selected,
        samePriorityWinner: winner(),
        liveProviders: root.getAllServices('evaluationValue').length,
      },
      'Several implementations compete for a default within one service scope',
      'Achieved through shared-container arbitration and explicit preference.',
    );
  });

  it('C2/C3: fork owns lifetime but shares service resolution with root and siblings', async () => {
    const root = aalisRoot();
    root.provide('evaluationValue', { name: 'root' });
    const left = root.fork('left');
    const right = root.fork('right');
    left.provide('evaluationValue', { name: 'left' }, { priority: 10 });
    right.provide('evaluationValue', { name: 'right' }, { priority: 20 });
    const names = [root, left, right].map(ctx => ctx.getService<{ name: string }>('evaluationValue')?.name);
    expect(names).toEqual(['right', 'right', 'right']);
    await right.disposeAsync();
    const after = [root, left].map(ctx => ctx.getService<{ name: string }>('evaluationValue')?.name);
    expect(after).toEqual(['left', 'left']);
    observe(
      'C2',
      'aalis',
      { winnersBeforeDispose: names, winnersAfterRightDispose: after },
      'Override one branch without affecting the parent or sibling',
      'Not obtained from fork(): descendants intentionally share the same ServiceContainer. This is a different scope contract, not a failed cleanup.',
    );
    observe(
      'C3',
      'aalis',
      { rootAndChildShareContainer: root.serviceContainer === left.serviceContainer },
      'Join selected service scopes without exposing the service at the root',
      'fork() shares the entire container; it is not a per-service isolation-label mechanism.',
    );
  });

  it('C4: whenService follows the selected provider and runs callback cleanup on replacement', async () => {
    const root = aalisRoot();
    const consumer = root.fork('consumer');
    const seen: string[] = [];
    consumer.whenService<{ name: string }>('evaluationValue', value => {
      seen.push(`start:${value.name}`);
      return () => {
        seen.push(`stop:${value.name}`);
      };
    });
    expect(seen).toEqual([]);
    const first = root.fork('first');
    first.provide('evaluationValue', { name: 'first' });
    expect(seen).toEqual(['start:first']);
    await first.disposeAsync();
    expect(seen).toEqual(['start:first', 'stop:first']);
    const second = root.fork('second');
    second.provide('evaluationValue', { name: 'second' });
    expect(seen).toEqual(['start:first', 'stop:first', 'start:second']);
    observe(
      'C4',
      'aalis',
      { transitions: [...seen], consumerDisposed: consumer.disposed },
      'Wait for a service and cleanly attach to its replacement',
      'whenService() reattaches the callback and cleans its returned disposer; this test does not measure PluginManager dependency gating.',
    );
  });

  it('C5: parent disposal removes nested service, listener, and explicitly owned resource', async () => {
    const root = aalisRoot();
    const parent = root.fork('parent');
    const child = parent.fork('child');
    const seen: string[] = [];
    let liveResources = 1;
    parent.provide('evaluationValue', { name: 'owned' });
    child.on('core-evaluation/ping', value => {
      seen.push(value);
    });
    child.onDispose(() => {
      liveResources -= 1;
    });
    await root.emit('core-evaluation/ping', 'before');
    expect(seen).toEqual(['before']);
    await parent.disposeAsync();
    await root.emit('core-evaluation/ping', 'after');
    expect(root.getService('evaluationValue')).toBeUndefined();
    expect(liveResources).toBe(0);
    expect(seen).toEqual(['before']);
    expect(child.disposed).toBe(true);
    observe(
      'C5',
      'aalis',
      {
        liveResources,
        eventCalls: [...seen],
        serviceVisible: root.getService('evaluationValue') !== undefined,
        childDisposed: child.disposed,
      },
      'Parent unload removes nested registrations and resources',
      'Achieved for Context registrations and resources explicitly registered with onDispose().',
    );
  });

  it('C6: disposeAsync waits until a resource cleanup actually completes', async () => {
    const root = aalisRoot();
    const child = root.fork('async-cleanup');
    const started = deferred();
    const release = deferred();
    let cleaned = false;
    let settled = false;
    child.onDispose(async () => {
      started.resolve();
      await release.promise;
      cleaned = true;
    });
    const disposal = child.disposeAsync().then(() => {
      settled = true;
    });
    try {
      await started.promise;
      expect(cleaned).toBe(false);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await disposal;
    }
    expect(cleaned).toBe(true);
    expect(settled).toBe(true);
    observe(
      'C6',
      'aalis',
      { cleanedAtResolution: cleaned, disposalResolved: settled },
      'Await disposal until asynchronous cleanup completes',
      'Achieved with disposeAsync(); the separate synchronous dispose() API intentionally does not wait.',
    );
  });

  it.each([
    false,
    true,
  ])('C7: a bare shared service keeps its captured provider context (await before resource: %s)', async crossAwait => {
    const root = aalisRoot();
    const provider = root.fork('lease-provider');
    const leases = new Set<string>();
    const service = {
      async acquire(name: string) {
        if (crossAwait) await Promise.resolve();
        leases.add(name);
        provider.onDispose(() => {
          leases.delete(name);
        });
      },
    };
    provider.provide('evaluationLeases', service);
    const first = root.fork('first');
    const second = root.fork('second');
    const fromFirst = first.getService<typeof service>('evaluationLeases');
    expect(fromFirst).toBe(service);
    await fromFirst?.acquire('first');
    await second.getService<typeof service>('evaluationLeases')?.acquire('second');
    await first.disposeAsync();
    await second.disposeAsync();
    expect([...leases]).toEqual(['first', 'second']);
    const retained = [...leases];
    expect(provider.disposed).toBe(false);
    await provider.disposeAsync();
    expect(leases.size).toBe(0);
    observe(
      `C7-${crossAwait ? 'async' : 'sync'}`,
      'aalis',
      {
        remainingLeasesAfterBothConsumersDispose: retained,
        remainingAfterProviderDispose: [...leases],
        returnedBareInstance: fromFirst === service,
      },
      'Resources created through a shared service follow the caller lifetime',
      'Not automatic for a service that captures the provider Context. Aalis returns the bare instance; explicitly pass the caller or register a caller cleanup.',
    );
  });

  it('C7-explicit: explicit caller ownership gives Aalis the same consumer cleanup outcome', async () => {
    const root = aalisRoot();
    const provider = root.fork('provider');
    const caller = root.fork('caller');
    const leases = new Set<string>();
    const service = {
      acquire(name: string, owner: AalisContext) {
        leases.add(name);
        owner.onDispose(() => {
          leases.delete(name);
        });
      },
    };
    provider.provide('evaluationLeases', service);
    caller.getService<typeof service>('evaluationLeases')?.acquire('explicit', caller);
    expect(leases.size).toBe(1);
    await caller.disposeAsync();
    expect(leases.size).toBe(0);
    expect(provider.disposed).toBe(false);
    observe(
      'C7-explicit',
      'aalis',
      { remainingLeasesAfterCallerDispose: [...leases], providerStillActive: !provider.disposed },
      'Resources created through a shared service follow the caller lifetime',
      'Achieved with an explicit owner argument; the difference from Cordis is automatic context rebinding, not whether cleanup can be implemented.',
    );
  });

  it('C8: forked contexts share event delivery unless handlers filter the payload', async () => {
    const root = aalisRoot();
    const left = root.fork('left');
    const right = root.fork('right');
    const seen: string[] = [];
    left.on('core-evaluation/ping', () => {
      seen.push('left');
    });
    right.on('core-evaluation/ping', () => {
      seen.push('right');
    });
    await left.emit('core-evaluation/ping', 'from-left');
    expect(seen).toEqual(['left', 'right']);
    observe(
      'C8',
      'aalis',
      { recipients: [...seen] },
      'Route an event to one logical branch',
      'fork() uses a shared EventBus. Branch selection requires application-level routing/filtering rather than Context event scope.',
    );
  });
});
