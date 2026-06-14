import type { ConfigManager, Context, Logger, StorageService } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { actions } from '../../packages/plugin-authority/src/index.js';

// ════════════════════════════════════════════════════════════
// authority actions — WebUI surface（纯能力委托模型）
//
// 关键安全性：setUserCapabilities 经 manager 的子集约束防越权——非 owner 授予方
// 只能委托自己持有的能力。owner / 本人才可改密码、解绑。
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

describe('setUserCapabilities — 委托子集防越权', () => {
  it('owner（console）可委托任意能力', async () => {
    const { ctx, manager } = makeCtx();
    const owner = { platform: 'webui', userId: 'console' };
    await actions.setUserCapabilities(ctx, { platform: 'onebot', userId: '123', grant: ['tool:*'] }, owner);
    expect(can(manager, 'onebot', '123', 'tool:shell.exec')).toBe(true);
  });

  it('非 owner 授予方只能委托自己持有的能力，越权抛错', async () => {
    const { ctx, manager } = makeCtx();
    // 先由 owner 给 alice 授 tool:foo
    manager.setUserCapabilities(null, { platform: 'webui', userId: 'alice' }, { grant: ['tool:foo'] });
    const alice = { platform: 'webui', userId: 'alice' };
    // alice 委托 tool:foo 给 bob → ok
    await actions.setUserCapabilities(ctx, { platform: 'onebot', userId: 'bob', grant: ['tool:foo'] }, alice);
    expect(can(manager, 'onebot', 'bob', 'tool:foo')).toBe(true);
    // alice 想放大成 tool:* → 越权
    await expect(
      actions.setUserCapabilities(ctx, { platform: 'onebot', userId: 'bob2', grant: ['tool:*'] }, alice),
    ).rejects.toThrow(/越权/);
  });

  it('记录 grantedBy；listDelegatees 可展开委托树', async () => {
    const { ctx, manager } = makeCtx({ owners: [{ platform: 'webui', userId: 'boss' }] });
    const boss = { platform: 'webui', userId: 'boss' };
    await actions.setUserCapabilities(ctx, { platform: 'onebot', userId: 'kid', grant: ['tool:a'] }, boss);
    const kids = manager.listDelegatees(boss);
    expect(kids.some(u => u.userId === 'kid' && u.grantedBy === 'webui:boss')).toBe(true);
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
    manager.setUserCapabilities(null, { platform: 'onebot', userId: 'a' }, { grant: ['tool:x'] });
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

describe('密码 / 解绑 — owner 或本人', () => {
  it('setPassword：本人可设；他人非 owner 被拒；短密码拒', async () => {
    const { ctx, manager } = makeCtx();
    const alice = { platform: 'webui', userId: 'alice' };
    await actions.setPassword(ctx, { platform: 'webui', userId: 'alice', password: 'hunter2' }, alice);
    expect(await manager.verifyPassword('webui', 'alice', 'hunter2')).toBe(true);
    // 他人（非 owner）改 alice 密码 → 拒
    await expect(
      actions.setPassword(
        ctx,
        { platform: 'webui', userId: 'alice', password: 'newpass' },
        {
          platform: 'onebot',
          userId: 'mallory',
        },
      ),
    ).rejects.toThrow(/owner 或本人/);
    // 短密码
    await expect(
      actions.setPassword(ctx, { platform: 'webui', userId: 'alice', password: '123' }, alice),
    ).rejects.toThrow(/至少 6 位/);
  });

  it('deleteUser 删除整条记录', async () => {
    const { ctx, manager } = makeCtx();
    manager.setUserCapabilities(null, { platform: 'onebot', userId: 'x' }, { grant: ['tool:a'] });
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
