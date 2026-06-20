import type { ConfigManager, Context, Logger, StorageService } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { actions } from '../../packages/plugin-authority/src/index.js';

// ════════════════════════════════════════════════════════════
// authority actions — WebUI surface（数字等级单轴）
//
// 关键安全性：权限管理（setUserLevel/setAuthorityOverride/setConfirmOverride）仅 owner 可达（防自我提权）。
// ════════════════════════════════════════════════════════════

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeCtx(cfg: Record<string, unknown> = {}): { ctx: Context; manager: AuthorityManager } {
  const data: Record<string, unknown> = { ...cfg };
  const config = {
    get: (k: string) => data[k],
    set: (k: string, v: unknown) => {
      data[k] = v;
    },
  } as unknown as ConfigManager;
  const storage = { writeFile: async () => undefined } as unknown as StorageService;
  const manager = new AuthorityManager(config, makeLogger(), storage);
  const app = { saveConfig: () => undefined };
  const ctx = {
    config,
    getService: (name: string) => (name === 'authority' ? manager : name === 'app' ? app : undefined),
    getAllServices: () => [],
  } as unknown as Context;
  return { ctx, manager };
}

const canRestricted = (m: AuthorityManager, platform: string, userId: string, cap: string) =>
  m.authorize({ platform, userId }, { capability: cap, visibility: 'restricted' }) === null;

describe('setUserLevel — 仅 owner 可管理', () => {
  it('owner（console）可设等级；达标可过受限操作', async () => {
    const { ctx, manager } = makeCtx();
    const owner = { platform: 'webui', userId: 'console' };
    await actions.setUserLevel(ctx, { platform: 'onebot', userId: '123', level: 2 }, owner);
    expect(canRestricted(manager, 'onebot', '123', 'tool:shell.exec')).toBe(true);
  });

  it('非 owner 调用被拒（防自我提权）', async () => {
    const { ctx } = makeCtx();
    const alice = { platform: 'onebot', userId: 'alice' }; // 非 owner
    await expect(actions.setUserLevel(ctx, { platform: 'onebot', userId: 'alice', level: 5 }, alice)).rejects.toThrow(
      /只有 owner/,
    );
  });

  it('非整数等级 / 缺 platform 抛错', async () => {
    const { ctx } = makeCtx();
    await expect(actions.setUserLevel(ctx, { platform: 'onebot', userId: 'a', level: 1.5 })).rejects.toThrow(/level/);
    await expect(actions.setUserLevel(ctx, { platform: 'onebot', level: 1 })).rejects.toThrow(/必填/);
  });
});

describe('getOverview — 总览快照', () => {
  it('返回 users(含 level) / owners / 命令工具清单', async () => {
    const { ctx, manager } = makeCtx({
      owners: [{ platform: 'webui', userId: 'boss' }],
      restrictedCapabilities: ['storage:secret:*'],
    });
    manager.setUserLevel({ platform: 'onebot', userId: 'a' }, 1);
    const ov = (await actions.getOverview(ctx, {})) as {
      users: Array<{ userId: string; level: number }>;
      owners: unknown[];
      restrictedCapabilities: string[];
      commands: unknown[];
      tools: unknown[];
    };
    expect(ov.users.find(u => u.userId === 'a')?.level).toBe(1);
    expect(ov.owners).toEqual([{ platform: 'webui', userId: 'boss' }]);
    expect(ov.restrictedCapabilities).toContain('storage:secret:*');
    expect(Array.isArray(ov.commands)).toBe(true);
    expect(Array.isArray(ov.tools)).toBe(true);
  });
});

describe('deleteUser — 删除记录', () => {
  it('deleteUser 删除整条记录', async () => {
    const { ctx, manager } = makeCtx();
    manager.setUserLevel({ platform: 'onebot', userId: 'x' }, 2);
    await actions.deleteUser(ctx, { platform: 'onebot', userId: 'x' });
    expect(manager.listUsers().find(u => u.userId === 'x')).toBeUndefined();
  });
});

describe('setAuthorityOverride — owner 调整单操作最低等级', () => {
  it('写入 config.authorityOverrides 任意整数；非整数删除条目', async () => {
    const { ctx } = makeCtx();
    await actions.setAuthorityOverride(ctx, { name: 'tool:weather', level: 5 });
    expect((ctx.config.get('authorityOverrides') as Record<string, number>)['tool:weather']).toBe(5);
    await actions.setAuthorityOverride(ctx, { name: 'tool:weather', level: null });
    expect((ctx.config.get('authorityOverrides') as Record<string, number>)['tool:weather']).toBeUndefined();
  });

  it('非 owner 调用被拒', async () => {
    const { ctx } = makeCtx();
    await expect(
      actions.setAuthorityOverride(ctx, { name: 'tool:x', level: 2 }, { platform: 'onebot', userId: 'bob' }),
    ).rejects.toThrow(/只有 owner/);
  });
});

describe('setConfirmOverride — owner 调整单操作确认要求', () => {
  it('写入 session/always/off；非法值删除条目', async () => {
    const { ctx } = makeCtx();
    await actions.setConfirmOverride(ctx, { name: 'tool:shell.exec', confirm: 'always' });
    expect((ctx.config.get('confirmOverrides') as Record<string, string>)['tool:shell.exec']).toBe('always');
    await actions.setConfirmOverride(ctx, { name: 'tool:shell.exec', confirm: 'off' });
    expect((ctx.config.get('confirmOverrides') as Record<string, string>)['tool:shell.exec']).toBe('off');
    await actions.setConfirmOverride(ctx, { name: 'tool:shell.exec', confirm: 'nonsense' });
    expect((ctx.config.get('confirmOverrides') as Record<string, string>)['tool:shell.exec']).toBeUndefined();
  });

  it('非 owner 调用被拒', async () => {
    const { ctx } = makeCtx();
    await expect(
      actions.setConfirmOverride(ctx, { name: 'tool:x', confirm: 'always' }, { platform: 'onebot', userId: 'bob' }),
    ).rejects.toThrow(/只有 owner/);
  });
});
