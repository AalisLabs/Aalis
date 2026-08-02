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
    });
    manager.setUserLevel({ platform: 'onebot', userId: 'a' }, 1);
    const ov = (await actions.getOverview(ctx, {})) as {
      users: Array<{ userId: string; level: number }>;
      owners: unknown[];
      commands: unknown[];
      tools: unknown[];
    };
    expect(ov.users.find(u => u.userId === 'a')?.level).toBe(1);
    expect(ov.owners).toEqual([{ platform: 'webui', userId: 'boss' }]);
    expect(Array.isArray(ov.commands)).toBe(true);
    expect(Array.isArray(ov.tools)).toBe(true);
  });

  // 定级收在权限服务这一侧：前端不再自算，只渲染 + 叠 override。所以 payload 里必须真的
  // 带上算好的 minLevel——漏了前端只会显示 `默认undefined`，而 payload 形状没有任何类型
  // 或测试守着（actions 返回的是 Record<string, unknown>）。
  it('每条 operation 都带后端算好的 minLevel（前端据此渲染，不得自算）', async () => {
    const { ctx } = makeCtx();
    const cmds = [
      { name: 'pub', pluginName: 'p', visibility: undefined, risk: undefined, expect: 0 },
      { name: 'res', pluginName: 'p', visibility: 'restricted' as const, risk: undefined, expect: 2 },
      { name: 'sen', pluginName: 'p', visibility: undefined, risk: 'sensitive' as const, expect: 1 },
      // 关键格：risk 是非联合成员的真值串。后端三个 === 都不中 → 落 visibility 兜底 = 2；
      // 前端那份旧实现只要 risk 为真就吐 0（fail-open 的显示），正是这条要防的分歧。
      { name: 'odd', pluginName: 'p', visibility: 'restricted' as const, risk: 'CRITICAL' as never, expect: 2 },
    ];
    // commands 与 tools 两半都要验：payload 是两个独立的 map，只补一半的话同一个病换到
    // tools 上照样上线（前端对 tools 同样会显示「默认undefined」）。
    const shape = (c: (typeof cmds)[number]) => ({
      name: c.name,
      pluginName: c.pluginName,
      visibility: c.visibility,
      risk: c.risk,
    });
    const withBoth = {
      ...ctx,
      getService: (n: string) =>
        n === 'commands' || n === 'tools'
          ? { getAll: () => cmds.map(shape) }
          : (ctx as unknown as { getService(n: string): unknown }).getService(n),
    } as unknown as Context;
    const ov = (await actions.getOverview(withBoth, {})) as {
      commands: Array<{ name: string; minLevel?: number }>;
      tools: Array<{ name: string; minLevel?: number }>;
    };
    for (const c of cmds) {
      expect(ov.commands.find(x => x.name === c.name)?.minLevel, `command ${c.name}`).toBe(c.expect);
      expect(ov.tools.find(x => x.name === c.name)?.minLevel, `tool ${c.name}`).toBe(c.expect);
    }
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

describe('setAutoConfirm — owner 切 auto 确认模式', () => {
  it('-1 写一直；0 写关；N 写未来截止', async () => {
    const { ctx } = makeCtx();
    await actions.setAutoConfirm(ctx, { minutes: -1 });
    expect(ctx.config.get('autoConfirmUntil')).toBe(-1);
    await actions.setAutoConfirm(ctx, { minutes: 0 });
    expect(ctx.config.get('autoConfirmUntil')).toBe(0);
    await actions.setAutoConfirm(ctx, { minutes: 30 });
    expect(ctx.config.get('autoConfirmUntil') as number).toBeGreaterThan(Date.now());
  });
  it('非 owner 调用被拒', async () => {
    const { ctx } = makeCtx();
    await expect(actions.setAutoConfirm(ctx, { minutes: 30 }, { platform: 'onebot', userId: 'bob' })).rejects.toThrow(
      /只有 owner/,
    );
  });
});
