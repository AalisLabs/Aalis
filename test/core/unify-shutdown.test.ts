declare module '@aalis/core' {
  interface AalisEvents {
    '__t:save': [data: string];
    '__t:saved': [data: string];
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 关停数据链：Agent 把最后的数据交给 Memory，Memory 等异步落盘，Storage 最后关。
// 排序正确与业务持久化完成分别验证：用可控 Promise 阻塞写入，证明阻塞期间下层仍可用。
// 注册顺序刻意取最不利的（消费者先注册），Agent→Memory 刻意声明为 optional——
// 旧拓扑只认 required 与首个声明提供者，这条链在旧实现里无序。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Storage {
  write(data: string): Promise<void>;
}
interface Memory {
  save(data: string): Promise<void>;
}
const storage = defineService<Storage>('zz-storage');
const memory = defineService<Memory>('zz-memory');

interface World {
  log: string[];
  persisted: string[];
  warnings: string[];
  /** 写入闸：默认放行 */
  gate: Promise<void>;
  storageClosed: boolean;
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function makeApp(w: World, disposeTimeoutMs?: number) {
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...a: unknown[]) => void w.warnings.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void w.warnings.push(a.map(String).join(' ')),
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'error', logger, disposeTimeoutMs });
  apps.push(app);
  return app;
}
const world = (): World => ({
  log: [],
  persisted: [],
  warnings: [],
  gate: Promise.resolve(),
  storageClosed: false,
});

const storagePlugin = (w: World) =>
  definePlugin({
    name: 'storage',
    uses: { provide, lifecycle },
    provides: [storage],
    apply({ provide, lifecycle }) {
      provide(storage, {
        async write(data) {
          if (w.storageClosed) throw new Error('storage 已关闭');
          await w.gate;
          if (w.storageClosed) throw new Error('storage 在写入途中被关闭');
          w.persisted.push(data);
        },
      });
      lifecycle.onDispose(() => {
        w.storageClosed = true;
        w.log.push('close:storage');
      });
    },
  });

const memoryPlugin = (w: World, name = 'memory', options?: { priority?: number }) =>
  definePlugin({
    name,
    uses: { storage, provide, lifecycle },
    provides: [memory],
    apply({ storage, provide, lifecycle }) {
      const buffer: string[] = [];
      provide(memory, { save: async data => void buffer.push(data) }, options);
      // 收尾：把缓冲落到下层并等它确认；此刻 storage 必须还活着
      lifecycle.onDrain(async () => {
        for (const data of buffer.splice(0)) await storage.require().write(`${name}:${data}`);
        w.log.push(`flushed:${name}`);
      }, `${name}:flush`);
      lifecycle.onDispose(() => void w.log.push(`close:${name}`));
    },
  });

const agentPlugin = (w: World) =>
  definePlugin({
    name: 'agent',
    uses: { memory: optional(memory), lifecycle },
    apply({ memory, lifecycle }) {
      lifecycle.onDrain(async () => {
        await memory.current?.save('last-words');
      });
      lifecycle.onDispose(() => void w.log.push('close:agent'));
    },
  });

describe('关停数据链：消费者先收尾、下层后关闭', () => {
  it('写入被阻塞期间下层依赖仍可用；放行后数据落盘，关闭顺序 agent → memory → storage', async () => {
    const w = world();
    const gate = deferred();
    w.gate = gate.promise;
    const app = makeApp(w);
    await app.plugin(agentPlugin(w)); // 最不利：消费者先注册
    await app.plugin(memoryPlugin(w));
    await app.plugin(storagePlugin(w));
    await app.plugins.idle();
    const host = app.bind({ services });

    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    await sleep(20);
    expect(stopped, '停机等业务交出来的 Promise').toBe(false);
    expect(w.storageClosed, '阻塞期间 storage 未关').toBe(false);
    expect(host.services.get(storage), '阻塞期间 storage 仍经容器可用').toBeDefined();
    expect(w.log, 'agent 已完成收尾并关闭；memory 卡在落盘上').toEqual(['close:agent']);
    gate.resolve();
    await stopping;
    expect(w.persisted, 'agent 的最后一笔经 memory 落到了 storage').toEqual(['memory:last-words']);
    expect(w.log).toEqual(['close:agent', 'flushed:memory', 'close:memory', 'close:storage']);
  });

  it('落盘被拒绝：停机照常完成，失败出现在诊断里，不谎称已保存', async () => {
    const w = world();
    const gate = deferred();
    w.gate = gate.promise;
    const app = makeApp(w);
    await app.plugin(agentPlugin(w));
    await app.plugin(memoryPlugin(w));
    await app.plugin(storagePlugin(w));
    await app.plugins.idle();
    const stopping = app.stop();
    await sleep(10);
    gate.reject(new Error('磁盘已满'));
    await stopping;
    expect(w.persisted).toEqual([]);
    expect(
      w.warnings.some(x => x.includes('memory:flush') && x.includes('磁盘已满')),
      w.warnings.join('\n'),
    ).toBe(true);
    expect(w.log.at(-1)).toBe('close:storage');
  });

  it('落盘永不返回：按超时放弃该项并点名，其余照常关闭', async () => {
    const w = world();
    w.gate = new Promise<void>(() => {});
    const app = makeApp(w, 40);
    await app.plugin(agentPlugin(w));
    await app.plugin(memoryPlugin(w));
    await app.plugin(storagePlugin(w));
    await app.plugins.idle();
    await app.stop();
    expect(w.warnings.some(x => x.includes('memory:flush') && x.includes('超过 40ms'))).toBe(true);
    expect(w.persisted).toEqual([]);
    expect(w.log).toContain('close:storage');
  });

  it('提供者换过人：消费者先于它绑定过的新旧两个提供者关闭', async () => {
    const w = world();
    const app = makeApp(w);
    await app.plugin(agentPlugin(w));
    await app.plugin(storagePlugin(w));
    await app.plugin(memoryPlugin(w, 'memory-old', { priority: 1 }));
    await app.plugins.idle();
    const saved: string[] = [];
    // 让 agent 在运行期真的绑定到旧提供者，再让新提供者上线成为胜者
    await app.plugin(
      definePlugin({
        name: 'writer',
        uses: { memory, lifecycle },
        apply({ memory, lifecycle }) {
          void memory.require().save('via-old');
          lifecycle.onDrain(async () => {
            await memory.require().save('via-new');
            saved.push('writer-drained');
          });
          lifecycle.onDispose(() => void w.log.push('close:writer'));
        },
      }),
    );
    await app.plugins.idle();
    await app.plugin(memoryPlugin(w, 'memory-new', { priority: 9 }));
    await app.plugins.idle();
    await app.stop();
    const at = (x: string) => w.log.indexOf(x);
    expect(at('close:writer')).toBeLessThan(at('close:memory-old'));
    expect(at('close:writer')).toBeLessThan(at('close:memory-new'));
    expect(w.persisted.sort()).toEqual(['memory-new:last-words', 'memory-new:via-new', 'memory-old:via-old']);
  });

  it('optional 依赖成环：成员全部 drain 完再任一 close，不告警，停机不悬挂', async () => {
    const w = world();
    const app = makeApp(w);
    const ping = defineService<{ hit(): void }>('zz-ping');
    const pong = defineService<{ hit(): void }>('zz-pong');
    await app.plugin(
      definePlugin({
        name: 'a',
        uses: { pong: optional(pong), provide, lifecycle },
        apply({ pong, provide, lifecycle }) {
          provide(ping, { hit: () => void w.log.push('ping<-b') });
          lifecycle.onDrain(() => void w.log.push(`drain:a pong=${pong.current ? 'alive' : 'gone'}`));
          lifecycle.onDispose(() => void w.log.push('close:a'));
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'b',
        uses: { ping: optional(ping), provide, lifecycle },
        apply({ ping, provide, lifecycle }) {
          provide(pong, { hit() {} });
          lifecycle.onDrain(() => ping.require().hit());
          lifecycle.onDispose(() => void w.log.push('close:b'));
        },
      }),
    );
    await app.plugins.idle();
    await app.stop();
    expect(w.warnings.filter(x => x.includes('成环'))).toEqual([]);
    // 互为 optional 的双方 drain 期间彼此仍活着；任一方 close 不得插在对方 drain 之前
    expect(w.log.includes('ping<-b'), `log=${w.log.join('>')}`).toBe(true);
    expect(w.log.includes('drain:a pong=alive'), `log=${w.log.join('>')}`).toBe(true);
    expect(w.log.includes('drain:a pong=gone')).toBe(false);
    const lastHandoff = Math.max(w.log.indexOf('ping<-b'), w.log.indexOf('drain:a pong=alive'));
    expect(lastHandoff).toBeLessThan(w.log.indexOf('close:a'));
    expect(lastHandoff).toBeLessThan(w.log.indexOf('close:b'));
  });

  it('required 依赖成环（胜者换人造成）：点名告警并按确定顺序关闭，停机不悬挂', async () => {
    const w = world();
    const app = makeApp(w);
    const ping = defineService<{ hit(): void }>('zz-rping');
    const pong = defineService<{ hit(): void }>('zz-rpong');
    const closes = (name: string) => () => void w.log.push(`close:${name}`);
    await app.plugin(
      definePlugin({
        name: 'seed',
        uses: { provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide(ping, { hit() {} });
          lifecycle.onDispose(closes('seed'));
        },
      }),
    );
    await app.plugin(
      definePlugin({
        name: 'a',
        uses: { ping, provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide(pong, { hit() {} });
          lifecycle.onDispose(closes('a'));
        },
      }),
    );
    // b 要 a 的 pong，又以更高优先级顶替了 a 所依赖的 ping：a ↔ b 两条边都是 required
    await app.plugin(
      definePlugin({
        name: 'b',
        uses: { pong, provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide(ping, { hit() {} }, { priority: 10 });
          lifecycle.onDispose(closes('b'));
        },
      }),
    );
    await app.plugins.idle();
    await app.stop();
    const cycle = w.warnings.filter(x => x.includes('required 依赖成环'));
    expect(cycle).toHaveLength(1);
    expect(cycle[0]).toContain('[b, a]');
    // seed 已被顶替、无人依赖，不受环牵连：环卡住时它是唯一就绪的，先走；环内按自然次序 b、a
    expect(w.log).toEqual(['close:seed', 'close:b', 'close:a']);
  });
});

describe('收尾段：需要下层回调确认的交接', () => {
  it('onDrain 里监听还在，能等到下层的确认事件；到 onDispose 时监听已撤回，等不到', async () => {
    const w = world();
    const app = makeApp(w);
    // 下层：收到 save 后异步确认
    await app.plugin(
      definePlugin({
        name: 'lower',
        uses: { events },
        apply({ events }) {
          events.on('__t:save', async data => {
            await sleep(5);
            await events.emit('__t:saved', data);
          });
        },
      }),
    );
    const acked: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'upper',
        uses: { events, lifecycle },
        apply({ events, lifecycle }) {
          events.on('__t:saved', data => void acked.push(data));
          lifecycle.onDrain(async () => {
            await events.emit('__t:save', 'in-drain');
          });
          lifecycle.onDispose(async () => {
            await events.emit('__t:save', 'in-dispose');
          });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('upper');
    expect(acked, '收尾段收得到确认；清理段时自己的监听已撤回').toEqual(['in-drain']);
  });
});
