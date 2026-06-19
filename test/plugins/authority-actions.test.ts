import type { ConfigManager, Context, Logger, StorageService } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { actions } from '../../packages/plugin-authority/src/index.js';

// ════════════════════════════════════════════════════════════
// authority actions — WebUI surface（纯能力委托模型）
//
// 关键安全性：权限管理仅 owner 可达（防非 owner 自我提权）。单 owner 终态无委托树。
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

const can = (m: AuthorityManager, platform: string, userId: string, cap: string) =>
  m.authorize({ platform, userId }, { capability: cap, visibility: 'restricted' }) === null;

describe('setUserCapabilities — 仅 owner 可管理', () => {
  it('owner（console）可设置任意能力', async () => {
    const { ctx, manager } = makeCtx();
    const owner = { platform: 'webui', userId: 'console' };
    await actions.setUserCapabilities(ctx, { platform: 'onebot', userId: '123', grant: ['tool:*'] }, owner);
    expect(can(manager, 'onebot', '123', 'tool:shell.exec')).toBe(true);
  });

  it('非 owner 调用被拒（防自我提权）', async () => {
    const { ctx } = makeCtx();
    const alice = { platform: 'onebot', userId: 'alice' }; // 非 owner
    await expect(
      actions.setUserCapabilities(ctx, { platform: 'onebot', userId: 'alice', grant: ['tool:*'] }, alice),
    ).rejects.toThrow(/只有 owner/);
  });

  it('缺 platform/userId 抛错', async () => {
    const { ctx } = makeCtx();
    await expect(actions.setUserCapabilities(ctx, { platform: 'onebot' })).rejects.toThrow(/必填/);
  });
});

describe('getOverview — 总览快照', () => {
  it('返回 users / owners / 受限清单 / 命令工具可见性', async () => {
    const { ctx, manager } = makeCtx({
      owners: [{ platform: 'webui', userId: 'boss' }],
      restrictedCapabilities: ['storage:secret:*'],
    });
    manager.setUserCapabilities({ platform: 'onebot', userId: 'a' }, { grant: ['tool:x'] });
    const ov = (await actions.getOverview(ctx, {})) as {
      users: Array<{ userId: string }>;
      owners: unknown[];
      restrictedCapabilities: string[];
      commands: unknown[];
      tools: unknown[];
    };
    expect(ov.users.some(u => u.userId === 'a')).toBe(true);
    expect(ov.owners).toEqual([{ platform: 'webui', userId: 'boss' }]);
    expect(ov.restrictedCapabilities).toContain('storage:secret:*');
    expect(Array.isArray(ov.commands)).toBe(true);
    expect(Array.isArray(ov.tools)).toBe(true);
  });
});

describe('deleteUser — 删除记录', () => {
  it('deleteUser 删除整条记录', async () => {
    const { ctx, manager } = makeCtx();
    manager.setUserCapabilities({ platform: 'onebot', userId: 'x' }, { grant: ['tool:a'] });
    await actions.deleteUser(ctx, { platform: 'onebot', userId: 'x' });
    expect(manager.listUsers().find(u => u.userId === 'x')).toBeUndefined();
  });
});

describe('setVisibilityOverride — owner 调整单操作可见性', () => {
  it('写入 config.visibilityOverrides；非法值删除条目', async () => {
    const { ctx } = makeCtx();
    await actions.setVisibilityOverride(ctx, { name: 'tool:weather', visibility: 'restricted' });
    expect((ctx.config.get('visibilityOverrides') as Record<string, string>)['tool:weather']).toBe('restricted');
    await actions.setVisibilityOverride(ctx, { name: 'tool:weather', visibility: 'nonsense' });
    expect((ctx.config.get('visibilityOverrides') as Record<string, string>)['tool:weather']).toBeUndefined();
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
