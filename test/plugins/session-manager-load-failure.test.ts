import { App, type Logger, provide } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// 读不到会话表时（连接抖动、后端不可用），先按 1s、3s、10s 的间隔有限重试，其间仍用原来的会话表与落盘目标；
// 用尽仍失败时，空表不能当作权威表和落盘目标：否则之后 ensureSession 新建的空白记录会覆盖后端里的原记录，
// 会话名、标题、父子关系与会话级配置全部丢失。冷启动与运行中换胜者两种形态都要守住；换胜者时落盘目标不能留在
// 上一个后端，否则空表会写进旧后端。重试等待可被停机中止，不能把停机拖过宽限。用尽记 error；被停机或换后端
// 中止不是读表故障，只记一行 info。
// 定时器用假时钟推进，重试间隔不花真实时间。

const original = {
  id: 'old-1',
  name: '上次运行的会话',
  title: '原标题',
  status: 'completed',
  children: ['old-1::child'],
  config: { llm: { provider: 'p', model: 'm' } },
  createdAt: 1,
  updatedAt: 1,
};

/** 三次重试间隔之和：推进这么久，重试一定用尽 */
const ALL_RETRIES_MS = 1000 + 3000 + 10_000;

const LOAD_FAILED = '加载会话数据失败，在这个后端上的会话改动不落盘（以免覆盖原有记录）:';
const LOAD_ABORTED = '已中止加载会话数据（停用、停机或换后端）';

/** 前 failures 次读表失败（Infinity 为始终失败），state.calls 记读表次数 */
function failing(store: ReturnType<typeof fakeMemory>, failures: number) {
  const list = store.listMetadata;
  const state = { calls: 0 };
  store.listMetadata = async () => {
    if (state.calls++ < failures) throw new Error('network blip');
    return list();
  };
  return Object.assign(store, { state });
}

type RecordingLogger = Logger & { infos: unknown[][]; warns: unknown[][]; errors: unknown[][] };

function recordingLogger(): RecordingLogger {
  const infos: unknown[][] = [];
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  const logger = {
    infos,
    warns,
    errors,
    debug: () => {},
    info: (...args: unknown[]) => void infos.push(args),
    warn: (...args: unknown[]) => void warns.push(args),
    error: (...args: unknown[]) => void errors.push(args),
    child: () => logger,
  };
  return logger as unknown as RecordingLogger;
}

/** 记下的 info 里读表被中止的那一行有几条 */
function abortedLines(logger: RecordingLogger): number {
  return logger.infos.filter(args => args[0] === LOAD_ABORTED).length;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** 按给定优先级提供各 memory 后登记 session-manager：apply 等读表（含重试）结束，推进 advanceMs 后再等登记返回 */
async function setup(stores: Array<[ReturnType<typeof fakeMemory>, number]>, advanceMs: number) {
  const logger = recordingLogger();
  const app = new App({ name: 'T', logger });
  await registerHubs(app);
  const host = app.bind({ provide, sessionManager });
  for (const [store, priority] of stores) host.provide(memory, store as never, { priority });
  const registered = app.plugin(sessionManagerPlugin, {});
  await vi.advanceTimersByTimeAsync(advanceMs);
  await registered;
  await app.plugins.idle();
  return { app, host, logger, sm: () => host.sessionManager.require() };
}

describe('session-manager 会话表加载失败', () => {
  it('读表失败一次后重试成功：会话表照常可用，之后的改动能落盘', async () => {
    const store = failing(fakeMemory({ 'old-1': original }), 1);
    const { app, sm } = await setup([[store, 0]], 1000);

    expect(store.state.calls).toBe(2);
    expect(sm().getSession('old-1')?.name).toBe('上次运行的会话');
    await sm().ensureSession('old-1', { config: { persona: 'x' } });
    await app.stop();

    expect(store.meta.get('old-1')).toMatchObject({ name: '上次运行的会话', config: { persona: 'x' } });
  });

  it('冷启动读表始终失败：重试用尽后，之后建档与停机都不覆盖后端原记录', async () => {
    const store = failing(fakeMemory({ 'old-1': original }), Number.POSITIVE_INFINITY);
    const { app, logger, sm } = await setup([[store, 0]], ALL_RETRIES_MS);

    expect(store.state.calls).toBe(4);
    expect(
      logger.errors.map(args => args[0]),
      '重试用尽要记 error',
    ).toEqual([LOAD_FAILED]);
    expect(abortedLines(logger), '重试用尽不是中止').toBe(0);
    expect(sm().getSession('old-1')).toBeUndefined();
    await sm().ensureSession('old-1', { config: { persona: 'x' } });
    await app.stop();

    expect(store.meta.get('old-1')).toEqual(original);
    expect([...store.meta.keys()]).toEqual(['old-1']);
  });

  it('重试间隔中停机：不等间隔走完就停下，不再读表、不写后端，也不再发布服务与登记', async () => {
    const store = failing(fakeMemory({ 'old-1': original }), Number.POSITIVE_INFINITY);
    const logger = recordingLogger();
    const app = new App({ name: 'T', logger });
    await registerHubs(app);
    app.bind({ provide }).provide(memory, store as never);
    const registered = app.plugin(sessionManagerPlugin, {});
    await vi.advanceTimersByTimeAsync(500);
    expect(store.state.calls).toBe(1);

    // 假时钟不再推进：停机能返回，说明重试等待被中止了
    await app.stop();
    await registered;

    expect(store.state.calls).toBe(1);
    expect(
      logger.warns.map(args => args[0]),
      '没有停机后的「已关闭，忽略登记」',
    ).toEqual(['加载会话数据失败，1000ms 后重试:']);
    expect(logger.errors, '停机中止读表不该记 error').toEqual([]);
    expect(abortedLines(logger)).toBe(1);
    expect(store.meta.get('old-1')).toEqual(original);
  });

  it('读表进行中停机、随后这次读表失败：不再进入重试等待，停机不被拖住', async () => {
    const store = fakeMemory({ 'old-1': original });
    let calls = 0;
    let fail!: (err: Error) => void;
    store.listMetadata = () => {
      calls++;
      return new Promise<never>((_, reject) => {
        fail = reject;
      });
    };
    const logger = recordingLogger();
    const app = new App({ name: 'T', logger });
    await registerHubs(app);
    app.bind({ provide }).provide(memory, store as never);
    const registered = app.plugin(sessionManagerPlugin, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // 停机先中止，读表随后失败。假时钟不推进：停机能返回，说明没有在已中止的信号上等重试间隔
    const stopped = app.stop();
    fail(new Error('network blip'));
    await stopped;
    await registered;

    expect(calls).toBe(1);
    expect(logger.warns, '已中止就不再预告重试').toEqual([]);
    expect(logger.errors).toEqual([]);
    expect(abortedLines(logger)).toBe(1);
    expect(store.meta.get('old-1')).toEqual(original);
  });

  it('换胜者后读新表始终失败：重试期间沿用旧表，用尽后空表既不写进新后端，也不写进上一个后端', async () => {
    const fallback = fakeMemory({ 'old-1': original });
    const preferred = failing(
      fakeMemory({ 'pref-1': { ...original, id: 'pref-1', children: [] } }),
      Number.POSITIVE_INFINITY,
    );
    const { app, host, sm } = await setup([[fallback, -100]], 0);
    expect(sm().getSession('old-1')?.name).toBe('上次运行的会话');

    host.provide(memory, preferred as never, { priority: 10 });
    await vi.advanceTimersByTimeAsync(500);
    expect(preferred.state.calls).toBe(1);
    expect(sm().getSession('old-1')?.name, '重试期间仍是旧表').toBe('上次运行的会话');

    await vi.advanceTimersByTimeAsync(ALL_RETRIES_MS);
    expect(preferred.state.calls).toBe(4);
    expect(sm().getSession('old-1')).toBeUndefined();

    await sm().ensureSession('old-1', { config: { persona: 'x' } });
    await sm().ensureSession('pref-1', { config: { persona: 'x' } });
    await app.stop();

    expect(fallback.meta.get('old-1')).toEqual(original);
    expect([...fallback.meta.keys()]).toEqual(['old-1']);
    expect(preferred.meta.get('pref-1')).toEqual({ ...original, id: 'pref-1', children: [] });
    expect([...preferred.meta.keys()]).toEqual(['pref-1']);
  });

  it('重试间隔中又换胜者：中止等待，立即改读新胜者的表，不再读上一个', async () => {
    const fallback = fakeMemory({ 'old-1': original });
    const flaky = failing(fakeMemory(), Number.POSITIVE_INFINITY);
    const next = fakeMemory({ 'next-1': { ...original, id: 'next-1', children: [] } });
    const { app, host, logger, sm } = await setup([[fallback, -100]], 0);

    host.provide(memory, flaky as never, { priority: 10 });
    await vi.advanceTimersByTimeAsync(500);
    expect(flaky.state.calls).toBe(1);

    // 假时钟不再推进：新胜者的表能读进来，说明上一个胜者的重试等待被中止了
    host.provide(memory, next as never, { priority: 20 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sm().getSession('next-1')?.name).toBe('上次运行的会话');
    expect(flaky.state.calls).toBe(1);
    expect(logger.errors, '换后端中止读表不该记 error').toEqual([]);
    expect(abortedLines(logger)).toBe(1);
    await app.stop();
  });
});
