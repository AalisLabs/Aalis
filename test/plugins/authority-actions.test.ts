import type { ConfigManager, Context, Logger, StorageService } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager, actions } from '../../packages/plugin-authority/src/index.js';

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeCtx(cfg: Record<string, unknown> = {}): { ctx: Context; manager: AuthorityManager } {
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigManager;
  const storage = { writeFile: async () => undefined } as unknown as StorageService;
  const manager = new AuthorityManager(config, makeLogger(), storage);
  const ctx = {
    config,
    getService: (name: string) => (name === 'authority' ? manager : undefined),
  } as unknown as Context;
  return { ctx, manager };
}

describe('authority actions — WebUI surface 防越权', () => {
  it('setUser: caller 不能把他人权限设为 >= 自身等级（与 /grant 同语义）', async () => {
    const { ctx } = makeCtx({ ownerAuthority: 5 });
    const caller = { platform: 'webui', userId: 'console' }; // owner=5
    await expect(actions.setUser(ctx, { platform: 'onebot', userId: '123', authority: 5 }, caller)).rejects.toThrow(
      /不能将权限设置为/,
    );
    await expect(actions.setUser(ctx, { platform: 'onebot', userId: '123', authority: 6 }, caller)).rejects.toThrow(
      /不能将权限设置为/,
    );
  });

  it('setUser: caller 等级内的设置正常生效', async () => {
    const { ctx, manager } = makeCtx({ ownerAuthority: 5 });
    const caller = { platform: 'webui', userId: 'console' };
    const result = await actions.setUser(ctx, { platform: 'onebot', userId: '123', authority: 3 }, caller);
    expect(result).toMatchObject({ message: expect.stringContaining('权限已设为 3') });
    expect(manager.getAuthority('onebot', '123')).toBe(3);
  });

  it('setUser: 低等级 caller 同样被防越权约束', async () => {
    const { ctx, manager } = makeCtx({ ownerAuthority: 5 });
    manager.setAuthority('webui', 'alice', 2);
    const caller = { platform: 'webui', userId: 'alice' };
    await expect(actions.setUser(ctx, { platform: 'onebot', userId: '123', authority: 2 }, caller)).rejects.toThrow(
      /不能将权限设置为/,
    );
    await actions.setUser(ctx, { platform: 'onebot', userId: '123', authority: 1 }, caller);
    expect(manager.getAuthority('onebot', '123')).toBe(1);
  });

  it('setUser: 无 caller（兼容旧调用方）时跳过防越权检查', async () => {
    const { ctx, manager } = makeCtx({ ownerAuthority: 5 });
    await actions.setUser(ctx, { platform: 'onebot', userId: '123', authority: 4 });
    expect(manager.getAuthority('onebot', '123')).toBe(4);
  });

  it('setUser: 非法入参仍然被拒', async () => {
    const { ctx } = makeCtx();
    await expect(actions.setUser(ctx, { platform: 'onebot', authority: 1 })).rejects.toThrow(/必填/);
    await expect(actions.setUser(ctx, { platform: 'onebot', userId: '1', authority: -1 })).rejects.toThrow(/>= 0/);
  });
});
