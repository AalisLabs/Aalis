import { describe, expect, it } from 'vitest';
import { defineService, provide } from '../../packages/core/src/index.js';
import { createActivationFixture } from '../helpers/activation.js';

// 回调返回 then 会抛错的怪值：判定是不是 thenable 本身不能抛，按普通返回值处理。follow 交给 attach 的句柄照常在
// 换人、清理落定之后退役，不再打到已撤下的旧实例。

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const weird = () =>
  Object.defineProperty({}, 'then', {
    get() {
      throw new Error('then getter boom');
    },
  });

function twoProviders(name: string) {
  const world = createActivationFixture();
  const svc = defineService<{ who(): string }>(name);
  const a = world.host.create('a');
  const b = world.host.create('b');
  world.host.bind(a, { provide }).provide.use(svc, { who: () => 'A' }, { priority: 2 });
  world.host.bind(b, { provide }).provide.use(svc, { who: () => 'B' }, { priority: 1 });
  const selection = world.host.bind(world.host.create('c'), { svc }).svc;
  return { a, selection };
}

const call = (handle: { who(): string }): string => {
  try {
    return handle.who();
  } catch (err) {
    return (err as Error).name;
  }
};

describe('怪值返回下 follow 钉住的句柄照常退役', () => {
  it('attach 返回 then 会抛错的对象', async () => {
    const { a, selection } = twoProviders('zz-weird-attach');
    let pinned: { who(): string } | undefined;
    selection.follow(handle => {
      pinned ??= handle;
      return weird() as never;
    });
    expect(pinned!.who()).toBe('A');
    await a.disposeAsync();
    await tick();
    expect(call(pinned!)).toBe('ServiceUnavailableError');
  });

  it('清理返回 then 会抛错的对象', async () => {
    const { a, selection } = twoProviders('zz-weird-cleanup');
    let pinned: { who(): string } | undefined;
    let cleaned = 0;
    selection.follow(handle => {
      pinned ??= handle;
      return () => {
        cleaned++;
        return weird() as never;
      };
    });
    await a.disposeAsync();
    await tick();
    expect(cleaned).toBe(1);
    expect(call(pinned!)).toBe('ServiceUnavailableError');
  });
});
