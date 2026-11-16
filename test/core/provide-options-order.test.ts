import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  optional,
  type Provide,
  provide,
  services,
} from '../../packages/core/src/index.js';

// provide 先把选项读完，再判定这次激活是否已关闭，随后写入容器：选项上的 getter 在读的时候执行，重复登记与撞名的
// 两条告警（宿主的日志器）在写入之后才发。判定与写入之间不执行外来代码。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

/** 一个应用、一个已激活的插件 p（交出它的 provide 能力）；onWarn 在宿主日志器收到 warn 时调用 */
async function world(onWarn: (line: string) => void = () => {}) {
  const lines: string[] = [];
  const tag =
    (level: string) =>
    (...args: unknown[]) => {
      const line = `${level}|${args.map(String).join(' ')}`;
      lines.push(line);
      if (level === 'warn') onWarn(line);
    };
  const logger: Logger = {
    debug: tag('debug'),
    info: tag('info'),
    warn: tag('warn'),
    error: tag('error'),
    child: () => logger,
  };
  const app = new App({ logLevel: 'debug', logger });
  apps.push(app);
  const host = app.bind({ services });
  let cap!: Provide;
  await app.plugin(
    definePlugin({
      name: 'p',
      uses: { provide },
      apply: ({ provide }) => {
        cap = provide.use;
      },
    }),
  );
  await app.plugins.idle();
  lines.length = 0;
  return { app, host, cap, lines };
}

describe('provide 先读完选项，再判定与写入', () => {
  it('选项的 getter 里卸载这个插件：这次登记被拒收，容器里没有这一条', async () => {
    const svc = defineService<object>('po:unload');
    const { app, host, cap, lines } = await world();
    const off = cap(
      svc,
      {},
      {
        get entryId() {
          void app.plugins.unload('p');
          return 'late';
        },
      },
    );
    expect(host.services.use.inspect(svc)).toEqual([]);
    expect(lines.filter(line => line.includes('po:unload'))).toEqual([
      'warn|激活 "p" 已关闭，忽略 provide("po:unload")',
    ]);
    expect(() => off()).not.toThrow();
  });

  it('选项的 getter 里停机：这次登记被拒收，不记「服务已注册」', async () => {
    const svc = defineService<object>('po:stop');
    const { app, cap, lines } = await world();
    let stopping: Promise<void> | undefined;
    cap(
      svc,
      {},
      {
        get label() {
          stopping ??= app.stop();
          return 'x';
        },
      },
    );
    expect(lines.filter(line => line.includes('po:stop'))).toEqual(['warn|激活 "p" 已关闭，忽略 provide("po:stop")']);
    await stopping;
  });

  it('选项上的每个 getter 只执行一次', async () => {
    const svc = defineService<object>('po:once');
    const { host, cap } = await world();
    const reads: string[] = [];
    cap(
      svc,
      {},
      {
        get entryId() {
          reads.push('entryId');
          return 'one';
        },
        get priority() {
          reads.push('priority');
          return 3;
        },
      },
    );
    expect(reads).toEqual(['entryId', 'priority']);
    expect(host.services.use.inspect(svc).map(info => [info.contextId, info.priority])).toEqual([['one', 3]]);
  });

  it('entryId 按普通读取取值：原型上的访问器照样读到，各条以各自的 id 登记', async () => {
    const svc = defineService<object>('po:proto');
    const { host, cap, lines } = await world();
    class ModelEntry {
      constructor(readonly model: string) {}
      get entryId() {
        return `model-${this.model}`;
      }
    }
    cap(svc, {}, new ModelEntry('a'));
    cap(svc, {}, new ModelEntry('b'));
    expect(host.services.use.inspect(svc).map(info => info.contextId)).toEqual(['model-a', 'model-b']);
    expect(lines.filter(line => line.startsWith('warn|'))).toEqual([]);
  });

  it('重复登记与撞名的告警发出时，这一条已经登记好', async () => {
    const svc = defineService<object>('po:warned');
    const twin = defineService<object>('po:warned');
    const seen: Array<[string, number]> = [];
    const { host, cap } = await world(line => {
      const kind = line.includes('provide 过一次') ? '重复' : line.includes('两个不同的描述符对象') ? '撞名' : line;
      seen.push([kind, host.services.use.inspect(svc).length]);
    });
    cap(svc, {});
    cap(twin, {});
    expect(seen).toEqual([
      ['重复', 2],
      ['撞名', 2],
    ]);
  });

  it('告警发出时，跟随这项服务的一方已经换到新登记的这一条', async () => {
    const svc = defineService<{ n: number }>('po:notified');
    const events: string[] = [];
    const { app, cap } = await world(() => void events.push('warn'));
    app.bind({ svc: optional(svc) }).svc.follow(handle => void events.push(`follow ${handle.n}`));
    cap(svc, { n: 1 });
    cap(svc, { n: 2 }, { priority: 1 });
    expect(events).toEqual(['follow 1', 'follow 2', 'warn']);
  });

  it('登记没成（独占冲突）时不发这两条告警', async () => {
    const svc = defineService<object>('po:exclusive');
    const twin = defineService<object>('po:exclusive');
    const { host, cap, lines } = await world();
    cap(svc, {}, { exclusive: true });
    expect(() => cap(twin, {})).toThrow(/独占登记/);
    expect(lines.filter(line => line.startsWith('warn|'))).toEqual([]);
    expect(host.services.use.inspect(svc)).toHaveLength(1);
  });
});
