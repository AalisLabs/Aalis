import type { ConfigManager, Context, Logger, StorageService } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { actions } from '../../packages/plugin-authority/src/index.js';

// ════════════════════════════════════════════════════════════
// authority actions — WebUI surface（纯能力委托模型）
//
// 关键安全性：setUserCapabilities 经 manager 的子集约束防越权——非 owner 授予方
// 只能委托自己持有的能力。
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

describe('getDelegationGraph / getDelegationNode — 委托关系图', () => {
  it('节点含 owner/user/cap；委托/授予/拒绝 边齐全；每条边两端节点都存在', async () => {
    const { ctx, manager } = makeCtx({ owners: [{ platform: 'webui', userId: 'boss' }] });
    // boss(owner) 委托 child 授 tool:a、拒 tool:b
    manager.setUserCapabilities(
      { platform: 'webui', userId: 'boss' },
      { platform: 'onebot', userId: 'child' },
      { grant: ['tool:a'], deny: ['tool:b'] },
    );
    const g = (await actions.getDelegationGraph(ctx, {})) as {
      nodes: Array<{ data: { id: string; kind: string } }>;
      edges: Array<{ data: { id: string; source: string; target: string; kind: string } }>;
    };
    const nodeIds = new Set(g.nodes.map(n => n.data.id));
    // owner / user / cap 节点齐全
    expect(g.nodes.find(n => n.data.id === 'user:webui:boss')?.data.kind).toBe('owner');
    expect(g.nodes.find(n => n.data.id === 'user:onebot:child')?.data.kind).toBe('user');
    expect(nodeIds.has('cap:tool:a')).toBe(true);
    expect(nodeIds.has('cap:tool:b')).toBe(true);
    // 边：委托 boss→child、授予 child→tool:a、拒绝 child→tool:b
    expect(
      g.edges.some(
        e => e.data.kind === 'delegate' && e.data.source === 'user:webui:boss' && e.data.target === 'user:onebot:child',
      ),
    ).toBe(true);
    expect(g.edges.some(e => e.data.kind === 'grant' && e.data.target === 'cap:tool:a')).toBe(true);
    expect(g.edges.some(e => e.data.kind === 'deny' && e.data.target === 'cap:tool:b')).toBe(true);
    // owner → 「* 全部能力」：owner 不孤立，直观显示拥有一切
    expect(nodeIds.has('cap:*')).toBe(true);
    expect(g.edges.some(e => e.data.source === 'user:webui:boss' && e.data.target === 'cap:*')).toBe(true);
    // 不变式：每条边两端节点都在 nodes 里（cytoscape 缺端点会崩）
    for (const e of g.edges) {
      expect(nodeIds.has(e.data.source)).toBe(true);
      expect(nodeIds.has(e.data.target)).toBe(true);
    }
  });

  it('getDelegationNode：user 返回身份/授予，cap 返回授予给', async () => {
    const { ctx, manager } = makeCtx();
    manager.setUserCapabilities(null, { platform: 'onebot', userId: 'u' }, { grant: ['tool:x'] });
    const userDetail = (await actions.getDelegationNode(ctx, { nodeId: 'user:onebot:u' })) as Record<string, unknown>;
    expect(userDetail.身份).toBe('onebot:u');
    expect(userDetail.授予).toBe('tool:x');
    const capDetail = (await actions.getDelegationNode(ctx, { nodeId: 'cap:tool:x' })) as Record<string, unknown>;
    expect(capDetail.能力).toBe('tool:x');
    expect(capDetail.授予给).toBe('onebot:u');
  });

  it('焦点子图：node focusId 限定 1 跳邻域；edge focusId 回 focusEdge', async () => {
    const { ctx, manager } = makeCtx({ owners: [{ platform: 'webui', userId: 'boss' }] });
    manager.setUserCapabilities(
      { platform: 'webui', userId: 'boss' },
      { platform: 'onebot', userId: 'child' },
      { grant: ['tool:a'] },
    );
    // 另立一个互不相连的用户，确认焦点会把它排除
    manager.setUserCapabilities(null, { platform: 'onebot', userId: 'lone' }, { grant: ['tool:z'] });

    // 聚焦 child，深度 1：含 child + 其邻居（boss 委托、cap:tool:a），排除 lone/tool:z
    const sub = (await actions.getDelegationGraph(ctx, { focusId: 'user:onebot:child', maxDepth: 1 })) as {
      focusId?: string;
      nodes: Array<{ data: { id: string } }>;
      edges: Array<{ data: { source: string; target: string } }>;
    };
    const ids = new Set(sub.nodes.map(n => n.data.id));
    expect(sub.focusId).toBe('user:onebot:child');
    expect(ids.has('user:onebot:child')).toBe(true);
    expect(ids.has('user:webui:boss')).toBe(true);
    expect(ids.has('cap:tool:a')).toBe(true);
    expect(ids.has('user:onebot:lone')).toBe(false); // 不连通，被焦点排除
    // 不变式仍成立
    for (const e of sub.edges) {
      expect(ids.has(e.data.source)).toBe(true);
      expect(ids.has(e.data.target)).toBe(true);
    }

    // 聚焦一条边 → 回 focusEdge
    const onEdge = (await actions.getDelegationGraph(ctx, { focusId: 'delegate:onebot:child' })) as {
      focusEdge?: { id: string; kind: string };
    };
    expect(onEdge.focusEdge?.id).toBe('delegate:onebot:child');
    expect(onEdge.focusEdge?.kind).toBe('delegate');
  });
});

describe('deleteUser — 删除记录', () => {
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
