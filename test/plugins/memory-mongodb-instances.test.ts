import { describe, expect, it } from 'vitest';
import type { LifecycleCap, Logger } from '../../packages/core/src/index.js';
import { openAndProvide } from '../../packages/plugin-memory-mongodb/src/index.js';

// ════════════════════════════════════════════════════════════
// 多实例的库：database 留空时按实例派生（主实例 aalis，`:b` 实例 aalis-b）；同一连接串下两个实例用同一个库时，
// 后激活的那个以配置错误失败（不带 stack），消息点名占用它的实例；占用者关闭后让出。
// 客户端用替身直接调用 openAndProvide，不经 apply：apply 会构造真实驱动去连 mongod。
// ════════════════════════════════════════════════════════════

type Client = Parameters<typeof openAndProvide>[0];
type Caps = Parameters<typeof openAndProvide>[2];

const NAME = '@aalis/plugin-memory-mongodb';

function fakeClient() {
  const state = { dbs: [] as string[], connects: 0 };
  const client = {
    connect: async () => {
      state.connects++;
    },
    db: (name: string) => {
      state.dbs.push(name);
      return { collection: () => ({ createIndex: async () => {} }) };
    },
    close: async () => {},
  };
  return { client: client as unknown as Client, state };
}

/** 一次激活的替身：onDispose 登记的清理由 dispose() 统一执行 */
function activation(id: string) {
  const disposers: Array<() => void | Promise<void>> = [];
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger } as unknown as Logger;
  const lifecycle: LifecycleCap = {
    id,
    signal: new AbortController().signal,
    onDrain: () => noop,
    onDispose: fn => {
      disposers.push(fn);
      return noop;
    },
  };
  const provide = (() => noop) as unknown as Caps['provide'];
  return {
    caps: { logger, lifecycle, provide },
    dispose: async () => {
      for (const fn of disposers.splice(0).reverse()) await fn();
    },
  };
}

const config = (uri: string, database = '') => ({ uri, database, collection: 'messages' });

describe('plugin-memory-mongodb 多实例的库', () => {
  it('database 留空按实例派生：主实例 aalis，带后缀的实例 aalis-<后缀>；写明的库名照用', async () => {
    const uri = 'mongodb://derive.invalid';
    const opened: string[] = [];
    for (const [id, database] of [
      [NAME, ''],
      [`${NAME}:b`, ''],
      [`${NAME}:c`, 'custom'],
    ]) {
      const { client, state } = fakeClient();
      await openAndProvide(client, config(uri, database), activation(id).caps);
      opened.push(...state.dbs);
    }
    expect(opened).toEqual(['aalis', 'aalis-b', 'custom']);
  });

  it('同一连接串下两个实例用同一个库：后激活的以配置错误失败并点名占用者，不连接；占用者关闭后可用', async () => {
    const uri = 'mongodb://clash.invalid';
    const main = activation(NAME);
    await openAndProvide(fakeClient().client, config(uri), main.caps);

    const second = fakeClient();
    const error = await openAndProvide(second.client, config(uri, 'aalis'), activation(`${NAME}:c`).caps).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error?.name).toBe('ConfigError');
    expect(error?.stack).toBeUndefined();
    expect(error?.message).toBe(
      `MongoDB 库 aalis 已被实例 ${NAME} 使用（同一连接串），两个实例不能共用一个库：请给 ${NAME}:c 另配 database`,
    );
    expect(second.state.connects).toBe(0);

    const other = fakeClient();
    await openAndProvide(other.client, config('mongodb://other.invalid', 'aalis'), activation(`${NAME}:d`).caps);
    expect(other.state.dbs, '另一个连接串上的同名库不算撞库').toEqual(['aalis']);

    await main.dispose();
    const retry = fakeClient();
    await openAndProvide(retry.client, config(uri, 'aalis'), activation(`${NAME}:c`).caps);
    expect(retry.state.dbs).toEqual(['aalis']);
  });
});
