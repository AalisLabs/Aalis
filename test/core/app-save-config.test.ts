import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// saveConfig 此前返回 void：ConfigManager.save 把 provider 的 promise 吞掉，App 无条件记
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
});
