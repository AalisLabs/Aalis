import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, type Logger, optional, provide } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// follow 统一错误政策：attach 抛错 = warn + 订阅保持，首挂与重挂同一策略。
// 半注册态（抛错逃出 follow 调用、无人持有退订）会让胜者变更再也唤不醒回调。
// ════════════════════════════════════════════════════════════

const svc = defineService<{ v: number }>('__t:ws-err');
const flush = () => new Promise(r => setTimeout(r, 0));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function makeWorld() {
  const lines: string[] = [];
  const logger: Logger = {
    warn: (m, e?) => {
      lines.push(`warn|${String(m)} ${e instanceof Error ? e.message : ''}`);
    },
    debug: () => {},
    info: () => {},
    error: () => {},
    child: () => logger,
  };
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger });
  apps.push(app);
  return { app, host: app.bind({ provide }), lines };
}

describe('follow 统一错误政策', () => {
  it('首挂抛错：不逃逸出注册调用、返回可用 disposer、warn 点名、订阅保持', async () => {
    const { app, host, lines } = makeWorld();
    const offP = host.provide(svc, { v: 1 }, { entryId: 'p1' });

    let calls = 0;
    let off!: () => void;
    await app.plugin(
      definePlugin({
        name: 'watcher',
        uses: { x: optional(svc) },
        apply({ x }) {
          expect(() => {
            off = x.follow(() => {
              calls++;
              if (calls === 1) throw new Error('首挂爆炸');
            });
          }).not.toThrow();
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('watcher')?.state).toBe('active');
    expect(off).toBeTypeOf('function');
    expect(lines.find(l => l.includes('跟随回调抛错'))).toMatch(/^warn\|/);

    offP();
    host.provide(svc, { v: 2 }, { entryId: 'p2' });
    await flush();
    expect(calls).toBe(2);

    expect(() => off()).not.toThrow();
  });

  it('重挂抛错：与首挂同一条 warn 文案，订阅保持', async () => {
    const { app, host, lines } = makeWorld();
    let calls = 0;
    await app.plugin(
      definePlugin({
        name: 'watcher',
        uses: { x: optional(svc) },
        apply({ x }) {
          x.follow(() => {
            calls++;
            throw new Error('重挂爆炸');
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('watcher')?.state).toBe('active');
    expect(calls).toBe(0);

    host.provide(svc, { v: 1 });
    await flush();
    expect(calls).toBe(1);
    expect(lines.filter(l => l.includes('跟随回调抛错'))).toHaveLength(1);
  });

  it('成功路径回归：cleanup 在关闭时照常执行', async () => {
    const { app, host } = makeWorld();
    host.provide(svc, { v: 1 });
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'watcher',
        uses: { x: optional(svc) },
        apply({ x }) {
          x.follow(provider => {
            seen.push(`attach:${provider.v}`);
            return () => {
              seen.push('cleanup');
            };
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('watcher')?.state).toBe('active');
    expect(seen).toEqual(['attach:1']);
    await app.plugins.unload('watcher');
    expect(seen).toEqual(['attach:1', 'cleanup']);
  });
});
