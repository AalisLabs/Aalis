import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { ConfigManager, Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';

// ════════════════════════════════════════════════════════════
// users.json 的落盘从来没人等：save() 只是把写挂到 saveChain 上就同步返回，而
// DisposableChain.disposeAsync 只在回调返回 thenable 时才 await——插件注册的是
// `ctx.onDispose(() => authority.save())`，返回 void，于是整条拆卸链一个环节都不等这次写。
// CLI 子命令改完等级即退进程、bounce 热重载同理：封禁/等级静默丢失，而命令还报成功。
// 修法是给出 flushed()，让拆卸路径能真正等到写完。
// ════════════════════════════════════════════════════════════

function mkConfig(): ConfigManager {
  const store: Record<string, unknown> = { owners: [] };
  return {
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
  } as unknown as ConfigManager;
}
function mkLogger(): Logger {
  const l = { child: () => l, debug() {}, info() {}, warn() {}, error() {} };
  return l as unknown as Logger;
}

/** 慢写 storage：不等待就一定观察得到（否则可能碰巧写完） */
function slowStorage(done: { written: boolean }): StorageService {
  return {
    async writeFile() {
      await new Promise(r => setTimeout(r, 40));
      done.written = true;
    },
    async readFile() {
      throw new Error('不存在');
    },
  } as unknown as StorageService;
}

describe('authority 落盘必须可被拆卸路径等待', () => {
  it('flushed() 等到写真正完成；不等它则写还在飞', async () => {
    const done = { written: false };
    const m = new AuthorityManager(mkConfig(), mkLogger(), slowStorage(done));

    m.setUserLevel({ platform: 'onebot', userId: 'alice' }, -5); // 封禁：安全语义，丢不得
    m.save();

    expect(done.written, '前置：save() 是同步返回的，此刻写还没落').toBe(false);

    await m.flushed();
    expect(done.written, 'flushed() 必须等到写完——拆卸路径靠它，不能返回一个空 promise').toBe(true);
  });

  it('没有待写内容时 flushed() 也能正常返回', async () => {
    const done = { written: false };
    const m = new AuthorityManager(mkConfig(), mkLogger(), slowStorage(done));
    await expect(m.flushed()).resolves.toBeUndefined();
  });
});
