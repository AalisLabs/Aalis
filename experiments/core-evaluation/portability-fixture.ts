import { type Context, createApp, LogHub, type PluginModule } from '@aalis/core';

declare module '@aalis/core' {
  interface ServiceTypeMap {
    'portability:counter': { increment(): number };
  }
  interface AalisEvents {
    'portability:tick': [value: number];
  }
  interface HookContextMap {
    'portability:transform': { value: number };
  }
  interface ContributionPointMap {
    'portability:items': { id: string; value: number };
  }
  interface AalisConfig {
    portabilityLabel?: string;
  }
  interface PluginModule {
    portabilityMetadata?: { browser: boolean };
  }
}

// These negative checks must remain errors even in a clean external consumer.
function checkDeclarationInference(ctx: Context): void {
  const count: number | undefined = ctx.getService('portability:counter')?.increment();
  const label: string | undefined = ctx.config.get('portabilityLabel');
  void count;
  void label;
  // @ts-expect-error augmented service result must not degrade to any
  const wrong: string | undefined = ctx.getService('portability:counter')?.increment();
  // @ts-expect-error augmented hook payload is checked
  void ctx.runHook('portability:transform', { value: 'wrong' });
  // @ts-expect-error augmented contribution payload is checked
  ctx.contribute('portability:items', { id: 'wrong', value: 'wrong' });
  // @ts-expect-error augmented configuration field is checked
  ctx.config.set('portabilityLabel', 42);
  void wrong;
}
void checkDeclarationInference;

export async function probe(): Promise<Record<string, unknown>> {
  const checks: string[] = [];
  const check = (condition: boolean, name: string): void => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const app = createApp({
    config: { name: 'portability', logLevel: 'error', plugins: {}, portabilityLabel: 'embedded' },
    devMode: true,
    logHub: new LogHub(),
    now: () => new Date(0),
  });
  let disposed = false;
  let observed = 0;
  let count = 0;
  const plugin: PluginModule = {
    name: 'portability-plugin',
    portabilityMetadata: { browser: true },
    apply(ctx) {
      ctx.provide('portability:counter', { increment: () => ++count });
      ctx.on('portability:tick', value => {
        observed = value;
      });
      ctx.middleware('portability:transform', async (data, next) => {
        data.value *= 2;
        await next();
      });
      ctx.contribute('portability:items', { id: 'one', value: 7 });
      ctx.onDispose(async () => {
        await Promise.resolve();
        disposed = true;
      });
    },
  };
  await app.plugin(plugin);
  await app.plugins.idle();
  await app.start();
  check(app.ctx.getService('portability:counter')?.increment() === 1, 'service registration and resolution');
  await app.ctx.emit('portability:tick', 3);
  check(observed === 3, 'event delivery');
  const payload = { value: 4 };
  await app.ctx.runHook('portability:transform', payload);
  check(payload.value === 8, 'middleware execution');
  check(app.ctx.collect('portability:items')[0]?.spec.value === 7, 'contribution enumeration');
  check(app.ctx.config.get('portabilityLabel') === 'embedded', 'in-memory host configuration');
  await app.stop();
  check(disposed, 'asynchronous disposal awaited');
  check(app.ctx.getService('portability:counter') === undefined, 'service removed at disposal');
  check(app.ctx.collect('portability:items').length === 0, 'contribution removed at disposal');
  return {
    checks,
    globals: {
      process: typeof (globalThis as Record<string, unknown>).process,
      require: typeof (globalThis as Record<string, unknown>).require,
      Buffer: typeof (globalThis as Record<string, unknown>).Buffer,
      document: typeof (globalThis as Record<string, unknown>).document,
      importScripts: typeof (globalThis as Record<string, unknown>).importScripts,
    },
  };
}
