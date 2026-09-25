import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type LogEntry,
  LogHub,
  optional,
  pluginsService,
  provide,
} from '../../packages/core/src/index.js';

// 宿主与插件可见面上几处平时不走的出口：绑定口的 all()、默认 Logger 的级别、插件管理服务查不到插件时的返回。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function track(app: App): App {
  apps.push(app);
  return app;
}

describe('绑定口的 all()', () => {
  it('必需口与 optional 口都按胜者次序列出全部提供者的登记视图', async () => {
    const svc = defineService<{ id: string }>('__t:surface-all');
    const app = track(new App({ name: 'T', logLevel: 'error' }));
    const host = app.bind({ provide });
    host.provide(svc, { id: 'low' }, { entryId: 'root/low' });
    host.provide(svc, { id: 'high' }, { priority: 5, entryId: 'root/high' });
    let seen: { required: string[]; optional: string[] } | undefined;
    await app.plugin(
      definePlugin({
        name: 'lister',
        uses: { must: svc, maybe: optional(svc) },
        apply({ must, maybe }) {
          seen = {
            required: must.all().map(view => view.instance.id),
            optional: maybe.all().map(view => view.instance.id),
          };
        },
      }),
    );
    await app.plugins.idle();
    expect(seen).toEqual({ required: ['high', 'low'], optional: ['high', 'low'] });
  });
});

describe('默认 Logger', () => {
  it('不注入 logger 也不指定级别：默认级别 info，debug 不进日志通道', () => {
    const hub = new LogHub();
    const entries: LogEntry[] = [];
    hub.onEntry(entry => void entries.push(entry));
    const app = track(new App({ logHub: hub }));
    entries.length = 0;
    app.logger.debug('调试信息');
    app.logger.info('常规信息');
    expect(entries.map(entry => [entry.level, entry.message])).toEqual([['info', '常规信息']]);
  });
});

describe('provide 的登记日志', () => {
  it('同一激活登记多个条目时带上条目 id；按激活身份登记的一条保持原样', async () => {
    const hub = new LogHub();
    const registered: string[] = [];
    hub.onEntry(entry => {
      if (entry.level === 'debug' && entry.message.startsWith('服务已注册')) registered.push(entry.message);
    });
    const app = track(new App({ name: 'T', logLevel: 'debug', logHub: hub }));
    const svc = defineService<{ id: string }>('__t:surface-log');
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'multi',
          uses: { provide },
          provides: [svc],
          apply({ provide }) {
            provide(svc, { id: 'a' }, { entryId: 'multi/a' });
            provide(svc, { id: 'b' }, { entryId: 'multi/b' });
          },
        }),
      },
      {
        definition: definePlugin({
          name: 'single',
          uses: { provide },
          provides: [svc],
          apply: ({ provide }) => void provide(svc, { id: 'single' }),
        }),
      },
    ]);
    await app.plugins.idle();
    expect(registered.filter(m => m.includes('__t:surface-log'))).toEqual([
      '服务已注册: __t:surface-log（multi/a）',
      '服务已注册: __t:surface-log（multi/b）',
      '服务已注册: __t:surface-log',
    ]);
  });
});

describe('插件管理服务的快照', () => {
  it('getPlugin 查不到的实例返回 undefined，不抛', () => {
    const app = track(new App({ name: 'T', logLevel: 'error' }));
    const { plugins } = app.bind({ plugins: pluginsService });
    expect(plugins.require().getPlugin('nope')).toBeUndefined();
  });
});
