import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, type Logger, optional, provide } from '../../packages/core/src/index.js';

// BindingPort.track：撤回链已取走之后登记的句柄就地执行（descriptors.ts 的契约）。撤回段开始之后就算，一次普通的 unload
// 里 follow 的清理随撤回段执行，清理里经 binder 的 track 登记，同样要就地执行，不能丢。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world(): { app: App; warns: string[] } {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logger });
  apps.push(app);
  return { app, warns };
}

type Holder = { hold(off: () => void): () => void };
const holderOf = (name: string) =>
  defineService<{ v: number }, Holder>(name, port => ({ hold: off => port.track(off) }));

describe('撤回链取走之后经 track 登记：就地执行', () => {
  it('卸载之后插件的迟到工作经 binder 的 track 登记', async () => {
    const { app, warns } = world();
    const holder = holderOf('zz-track-late');
    await app.plugin(
      definePlugin({
        name: 'provider',
        uses: { provide },
        provides: [holder],
        apply: ({ provide }) => void provide.use(holder, { v: 1 }),
      }),
    );
    let business: Holder | undefined;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { holder },
        apply({ holder }) {
          business = holder.use;
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('consumer');
    let released = 0;
    business!.hold(() => void released++);
    expect(released).toBe(1);
    expect(warns.filter(line => line.includes('撤回抛错'))).toEqual([]);
  });

  it('撤回段里 follow 的清理经 binder 的 track 登记：一次普通 unload', async () => {
    const { app, warns } = world();
    const holder = holderOf('zz-track-withdraw');
    const other = defineService<{ v: number }>('zz-track-other');
    await app.plugin(
      definePlugin({
        name: 'provider',
        uses: { provide },
        provides: [holder, other],
        apply({ provide }) {
          provide.use(holder, { v: 1 });
          provide.use(other, { v: 2 });
        },
      }),
    );
    let released = 0;
    let cleanupRan = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { holder, other },
        apply({ holder, other }) {
          other.follow(() => () => {
            cleanupRan++;
            holder.use.hold(() => void released++);
          });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('consumer');
    expect({ cleanupRan, released }).toEqual({ cleanupRan: 1, released: 1 });
    expect(warns.filter(line => line.includes('撤回抛错'))).toEqual([]);
  });
});

describe('钉住的句柄经 binder 的 track 登记的清理', () => {
  it('提供者撤下、跟随的清理落定后，这项清理当场执行，不等消费者关闭', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    type Holder = { hold(off: () => void): () => void };
    const holder = defineService<{ v: number }, Holder>('zz-pin-track', port => ({ hold: off => port.track(off) }));
    let withdraw: (() => void) | undefined;
    await app.plugin(
      definePlugin({
        name: 'provider',
        uses: { provide },
        provides: [holder],
        apply({ provide }) {
          withdraw = provide.use(holder, { v: 1 });
        },
      }),
    );
    let released = 0;
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { holder: optional(holder) },
        apply: ({ holder }) =>
          void holder.follow(pinned => {
            pinned.hold(() => void released++);
            return () => {};
          }),
      }),
    );
    await app.plugins.idle();
    expect(released).toBe(0);
    withdraw?.();
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    expect(released).toBe(1);
  });
});
