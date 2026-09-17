import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// saveConfig 此前返回 void：ConfigManager.save 把异步 provider 的 promise 吞掉，App 照记
// 「配置已保存」。异步 provider 的失败无人知晓，「返回时已落盘」不成立。
// 现在返回 Promise：完成即落盘、失败即拒绝。并发保存的先后与外部编辑合并不在此契约内。
// ════════════════════════════════════════════════════════════

describe('App.saveConfig 完成确认', () => {
  it('异步 provider：等到真正落盘才返回', async () => {
    let persisted = false;
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      configProvider: {
        save: async () => {
          await new Promise(r => setTimeout(r, 20));
          persisted = true;
        },
      },
    });
    await app.saveConfig();
    expect(persisted, '返回时持久化必须已完成').toBe(true);
  });

  it('provider 拒绝 → saveConfig 拒绝，不再静默吞掉', async () => {
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      configProvider: {
        save: async () => {
          throw new Error('disk full');
        },
      },
    });
    await expect(app.saveConfig()).rejects.toThrow('disk full');
  });

  it('无 provider（内存模式）→ 立即完成', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await expect(app.saveConfig()).resolves.toBeUndefined();
  });

  // 0.13.0 之前发布的插件裸调 `app.saveConfig()`（当时返回 void）。同步 provider 的抛错此前同步冒给
  // 调用方；现在是拒绝——没人接就是未处理拒绝，@aalis/runtime 与 Node 默认都按致命错误退出进程。
  it('不 await 也不 catch 的调用：失败只记 error，不产生未处理拒绝', async () => {
    const errors: unknown[][] = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error: (...args: unknown[]) => errors.push(args),
      child: () => logger,
    };
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      logger,
      configProvider: {
        save: () => {
          throw new Error('EACCES');
        },
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      void app.saveConfig();
      // unhandledRejection 在微任务排空后的下一轮才触发，等两轮宏任务
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled, '裸调的失败不得逃成未处理拒绝').toEqual([]);
    expect(
      errors.map(args => String(args[1])),
      '失败必须出声',
    ).toEqual(['Error: EACCES']);
  });

  it('上报器自身抛错也不产生未处理拒绝；await 的调用方仍拿到原始拒绝', async () => {
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error: () => {
        throw new Error('sink broken');
      },
      child: () => logger,
    };
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      logger,
      configProvider: { save: () => Promise.reject(new Error('disk full')) },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(app.saveConfig()).rejects.toThrow('disk full');
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
