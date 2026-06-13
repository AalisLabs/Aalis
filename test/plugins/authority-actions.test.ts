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

describe('权限依赖图（getPermissionGraph / getPermissionNode）', () => {
  function setup() {
    const { ctx, manager } = makeCtx({
      ownerAuthority: 5,
      defaultAuthority: 1,
      owners: [{ platform: 'onebot', userId: '42' }],
    });
    manager.setAuthority('qq', 'alice', 3);
    manager.setUserCapabilities('qq', 'alice', { grants: ['tool:file.*'], denies: ['tool:shell.*'] });
    return { ctx, manager };
  }

  it('角色链节点与继承边完整；用户/owner/console 各就各位', async () => {
    const { ctx } = setup();
    const g = (await actions.getPermissionGraph(ctx, {})) as {
      nodes: Array<{ data: { id: string } }>;
      edges: Array<{ data: { id: string; source: string; target: string; label?: string } }>;
      stats: Record<string, number>;
    };
    const ids = new Set(g.nodes.map(n => n.data.id));
    for (let n = 0; n <= 5; n++) expect(ids.has(`role:${n}`)).toBe(true);
    expect(g.edges.filter(e => e.data.label === '继承')).toHaveLength(5);
    // alice → role:3；owners 配置 → role:5；console → role:5
    expect(g.edges.find(e => e.data.source === 'user:qq:alice' && e.data.target === 'role:3')).toBeTruthy();
    expect(g.edges.find(e => e.data.source === 'user:onebot:42' && e.data.target === 'role:5')).toBeTruthy();
    expect(g.edges.find(e => e.data.source === 'user:webui:console' && e.data.target === 'role:5')).toBeTruthy();
    // grant/deny 边指向 capability 节点
    expect(g.edges.find(e => e.data.label === '授予' && e.data.target === 'cap:tool:file.*')).toBeTruthy();
    expect(g.edges.find(e => e.data.label === '拒绝' && e.data.target === 'cap:tool:shell.*')).toBeTruthy();
    // 内置提权清单（6 条）产出 capability → 角色 的"需等级"边
    expect(g.edges.filter(e => e.data.label === '需等级').length).toBeGreaterThanOrEqual(6);
  });

  it('被绑身份只画绑定边（等级随主账户）', async () => {
    const { ctx, manager } = setup();
    const { code } = manager.createBindCode('webui', 'boss');
    manager.consumeBindCode(code, { platform: 'onebot', userId: '777' });
    const g = (await actions.getPermissionGraph(ctx, {})) as {
      edges: Array<{ data: { id: string; source: string; target: string; label?: string } }>;
    };
    expect(
      g.edges.find(
        e => e.data.source === 'user:onebot:777' && e.data.target === 'user:webui:boss' && e.data.label === '绑定',
      ),
    ).toBeTruthy();
    expect(g.edges.find(e => e.data.source === 'user:onebot:777' && e.data.label === '等级')).toBeUndefined();
  });

  it('节点详情：user / role / cap 各返回对应键', async () => {
    const { ctx } = setup();
    const user = (await actions.getPermissionNode(ctx, { nodeId: 'user:qq:alice' })) as Record<string, unknown>;
    expect(user.有效等级).toBe(3);
    expect(user.个别授予).toBe('tool:file.*');
    const role = (await actions.getPermissionNode(ctx, { nodeId: 'role:5' })) as Record<string, unknown>;
    expect(String(role.角色)).toContain('owner');
    const cap = (await actions.getPermissionNode(ctx, {
      nodeId: 'cap:storage:path:data:/users.json:write',
    })) as Record<string, unknown>;
    expect(cap.提权要求).toBe('等级 5');
  });
});
