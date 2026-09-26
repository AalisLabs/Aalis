import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { LifecycleCap, Logger } from '../../packages/core/src/index.js';
import { openAndProvide } from '../../packages/plugin-memory-mongodb/src/index.js';

// ════════════════════════════════════════════════════════════
// memory-mongodb 的 apply 等连接与建索引（serverSelection 超时默认 5 秒，建索引没有超时）。接上 lifecycle.signal 后，
// abort 即 client.close()，让在途的操作以错误返回，apply 随之落定、不发布服务。mongodb+srv 在 SRV 解析期间
// close 不生效，连接会在 abort 之后照常建成：连接后、建索引后各查一次 signal 兜住。
//
// 客户端用替身直接调用 openAndProvide，不经 apply：apply 会构造真实驱动去连 mongod，
// test 下 mock mongodb 也拦不住插件目录里解析到的驱动。
// ════════════════════════════════════════════════════════════

type Stage = 'connect' | 'createIndex';
type Client = Parameters<typeof openAndProvide>[0];
type Caps = Parameters<typeof openAndProvide>[2];

/**
 * 客户端替身：hangOn 那一步挂起。closeInterrupts 为真时 close 让挂起的操作以错误返回（真实驱动关拓扑时如此），
 * 为假时 close 不生效，挂起的操作要等 release 才照常完成（SRV 解析期间的 close，或操作恰在 close 前完成）。
 * 只挂起该步的第一次调用。
 */
function fakeClient(hangOn: Stage | undefined, closeInterrupts: boolean) {
  const state = { closes: 0, indexes: 0, release: () => {} };
  let interrupt: ((err: Error) => void) | undefined;
  let hung = false;
  const step = (stage: Stage): Promise<void> => {
    if (stage !== hangOn || hung) return Promise.resolve();
    hung = true;
    return new Promise((resolve, reject) => {
      state.release = resolve;
      interrupt = reject;
    });
  };
  const client = {
    connect: () => step('connect'),
    db: () => ({
      collection: () => ({
        createIndex: async () => {
          state.indexes++;
          await step('createIndex');
        },
      }),
    }),
    close: async () => {
      state.closes++;
      if (closeInterrupts) interrupt?.(new Error('topology closed'));
    },
  };
  return { client: client as unknown as Client, state };
}

function harness() {
  const abort = new AbortController();
  const lines: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => void lines.push(`warn ${args.join(' ')}`),
    error: (...args: unknown[]) => void lines.push(`error ${args.join(' ')}`),
    child: () => logger,
  };
  const lifecycle: LifecycleCap = {
    id: '@aalis/plugin-memory-mongodb',
    signal: abort.signal,
    onDrain: () => () => {},
    onDispose: () => () => {},
  };
  const provided: unknown[] = [];
  const provide = ((_descriptor: unknown, service: unknown) => {
    provided.push(service);
    return () => {};
  }) as Caps['provide'];
  return { abort, lines, provided, caps: { logger, lifecycle, provide } };
}

const CONFIG = { uri: 'mongodb://fake.invalid', database: 'aalis', collection: 'messages' };

/** 在 ms 内落定则交回结果（拒绝也算落定），否则抛错 */
async function settle(promise: Promise<unknown>, ms = 500): Promise<{ error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({}),
        error => ({ error }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${ms}ms 内未落定`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

describe('plugin-memory-mongodb 连接段随 lifecycle.signal 中止', () => {
  it('未中止：发布服务，signal 上不留监听', async () => {
    const { client, state } = fakeClient(undefined, true);
    const h = harness();
    await openAndProvide(client, CONFIG, h.caps);
    expect(h.provided).toHaveLength(1);
    expect(state.indexes).toBe(4);
    expect(getEventListeners(h.abort.signal, 'abort')).toHaveLength(0);
  });

  it.each(['connect', 'createIndex'] as const)('%s 挂起时 abort：close 中断它，apply 落定、不发布服务', async stage => {
    const { client, state } = fakeClient(stage, true);
    const h = harness();
    const opening = openAndProvide(client, CONFIG, h.caps);
    await tick();
    h.abort.abort();
    const { error } = await settle(opening);
    expect(error).toBeInstanceOf(Error);
    expect(h.provided).toEqual([]);
    expect(state.closes).toBeGreaterThanOrEqual(1);
    expect(h.lines).toEqual([]);
  });

  it.each([
    'connect',
    'createIndex',
  ] as const)('%s 在 abort 之后照常完成（close 未生效）：不再往下走，关闭客户端、不发布服务', async stage => {
    const { client, state } = fakeClient(stage, false);
    const h = harness();
    const opening = openAndProvide(client, CONFIG, h.caps);
    await tick();
    h.abort.abort();
    state.release();
    const { error } = await settle(opening);
    expect(error).toBeInstanceOf(Error);
    expect(h.provided).toEqual([]);
    expect(state.indexes, '连接后即停，不建索引').toBe(stage === 'connect' ? 0 : 4);
    expect(state.closes, 'abort 时关一次，抛出后 catch 再关一次').toBe(2);
    expect(h.lines).toEqual([]);
  });
});

describe('plugin-memory-mongodb 连接失败的包装错误', () => {
  it('保留驱动原错误作 cause，消息不变', async () => {
    const original = new Error('connect ECONNREFUSED 127.0.0.1:1');
    const client = {
      connect: () => Promise.reject(original),
      close: async () => {},
    } as unknown as Client;
    const { error } = await settle(openAndProvide(client, CONFIG, harness().caps));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('MongoDB 连接失败: connect ECONNREFUSED 127.0.0.1:1');
    expect((error as Error).cause).toBe(original);
  });
});
