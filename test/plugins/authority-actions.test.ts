import { afterEach, describe, expect, it } from 'vitest';
import { type AuthorityService, authority, type UserIdentity } from '../../packages/api-authority/src/index.js';
import {
  type CommandBuilder,
  type CommandHandler,
  type CommandService,
  commands,
} from '../../packages/api-commands/src/index.js';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { type StorageRootInfo, storage } from '../../packages/api-storage/src/index.js';
import { type ToolService, tools } from '../../packages/api-tools/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import { type App, provide, services } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// authority 页面动作 — WebUI surface（数字等级单轴）
//
// 动作是 apply 里的闭包，经 webui-server 登记；测试装上真插件、用桩 webui 截下登记表，
// 按名调用。动作缺席（没登记上去）会在 call() 处直接抛错——管理面整体消失这条回归不会被静默吞掉。
//
// 关键安全性：权限管理（setUserLevel/setAuthorityOverride/setConfirmOverride）仅 owner 可达（防自我提权）。
// ════════════════════════════════════════════════════════════

/** getOverview 读 commands/tools 服务拿操作清单；两半各给一份同形桩 */
interface OpNode {
  name: string;
  pluginName: string;
  visibility?: 'public' | 'restricted';
  risk?: 'safe' | 'sensitive' | 'dangerous';
}

function fakeCommandService(nodes: OpNode[], handlers: Map<string, CommandHandler>): CommandService {
  return {
    prefix: '/',
    // 每条指令一个 builder：按指令名（DSL 首段）截下处理器，供测试直接调用
    command: (spec: string) => {
      const builder = {} as CommandBuilder;
      Object.assign(builder, {
        alias: () => builder,
        option: () => builder,
        action: (handler: CommandHandler) => {
          handlers.set(spec.split(' ')[0], handler);
          return builder;
        },
        usage: () => builder,
        example: () => builder,
      });
      return builder;
    },
    unregister: () => {},
    getAll: () => nodes,
    setExecutionGuard: () => {},
  } as unknown as CommandService;
}

function fakeToolService(nodes: OpNode[]): ToolService {
  return {
    register: () => () => {},
    registerGroup: () => () => {},
    getAll: () => nodes,
    setExecutionGuard: () => {},
  } as unknown as ToolService;
}

const running: App[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
});

interface BootOptions {
  /** 宿主配置的起始值（owners / deniedCapabilities…） */
  config?: Record<string, unknown>;
  /** 给出即提供 commands / tools 桩，getAll 返回这份清单 */
  operations?: OpNode[];
  /** 给出即作为 users.json 原文；缺省按文件不存在处理 */
  usersJson?: string;
}

const DATA_ROOT: StorageRootInfo = {
  name: 'data',
  label: 'data',
  kind: 'data',
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
};

async function boot(opts: BootOptions = {}) {
  const { app } = hostedApp(opts.config);
  running.push(app);
  const host = app.bind({ provide, services, hostConfig });
  const registered = new Map<string, WebuiActionHandler>();
  const handlers = new Map<string, CommandHandler>();
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction: (method: string, handler: WebuiActionHandler) => {
      registered.set(method, handler);
      return () => void registered.delete(method);
    },
  } as never);
  // 等级表落盘用；多数用例不验持久化，读到「无文件」即空表
  host.provide(storage, {
    listRoots: () => [DATA_ROOT],
    readFile: async () => {
      if (opts.usersJson === undefined) throw new Error('不存在');
      return opts.usersJson;
    },
    writeFile: async () => undefined,
  } as never);
  if (opts.operations) {
    host.provide(commands, fakeCommandService(opts.operations, handlers) as never);
    host.provide(tools, fakeToolService(opts.operations) as never);
  }

  await app.plugins.register(authorityPlugin, {});
  await app.plugins.idle();

  const manager = host.services.get(authority);
  if (!manager) throw new Error('authority 服务未注册 —— 插件没起来');
  const call = async (method: string, args: Record<string, unknown> = {}, caller?: UserIdentity): Promise<unknown> => {
    const handler = registered.get(method);
    if (!handler) throw new Error(`页面动作 "${method}" 未登记 —— 管理面缺失`);
    return handler(args, caller);
  };
  /** 以 owner（webui:console）身份直接调指令处理器（不经解析与守卫） */
  const runCommand = async (name: string, ...positionals: unknown[]): Promise<unknown> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`指令 "${name}" 未登记`);
    const session = { sessionId: 's1', platform: 'webui', userId: 'console', raw: `/${name}` };
    return handler({ session, options: {} }, ...positionals);
  };
  return { app, manager, call, runCommand, config: host.hostConfig.require() };
}

const canRestricted = (m: AuthorityService, platform: string, userId: string, cap: string) =>
  m.authorize({ platform, userId }, { capability: cap, visibility: 'restricted' }) === null;

describe('setUserLevel — 仅 owner 可管理', () => {
  it('owner（console）可设等级；达标可过受限操作', async () => {
    const { manager, call } = await boot();
    const owner = { platform: 'webui', userId: 'console' };
    await call('setUserLevel', { platform: 'onebot', userId: '123', level: 2 }, owner);
    expect(canRestricted(manager, 'onebot', '123', 'tool:shell.exec')).toBe(true);
  });

  it('非 owner 调用被拒（防自我提权）', async () => {
    const { call } = await boot();
    const alice = { platform: 'onebot', userId: 'alice' }; // 非 owner
    await expect(call('setUserLevel', { platform: 'onebot', userId: 'alice', level: 5 }, alice)).rejects.toThrow(
      /只有 owner/,
    );
  });

  it('非整数等级 / 缺 platform 抛错', async () => {
    const { call } = await boot();
    await expect(call('setUserLevel', { platform: 'onebot', userId: 'a', level: 1.5 })).rejects.toThrow(/level/);
    await expect(call('setUserLevel', { platform: 'onebot', level: 1 })).rejects.toThrow(/必填/);
  });
});

describe('getOverview — 总览快照', () => {
  it('返回 users(含 level) / owners / 命令工具清单', async () => {
    const { manager, call } = await boot({ config: { owners: [{ platform: 'webui', userId: 'boss' }] } });
    manager.setUserLevel({ platform: 'onebot', userId: 'a' }, 1);
    const ov = (await call('getOverview')) as {
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
  // 或测试守着（动作返回的是 unknown）。
  it('每条 operation 都带后端算好的 minLevel（前端据此渲染，不得自算）', async () => {
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
    const { call } = await boot({
      operations: cmds.map(c => ({
        name: c.name,
        pluginName: c.pluginName,
        visibility: c.visibility,
        risk: c.risk,
      })),
    });
    const ov = (await call('getOverview')) as {
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
    const { manager, call } = await boot();
    manager.setUserLevel({ platform: 'onebot', userId: 'x' }, 2);
    await call('deleteUser', { platform: 'onebot', userId: 'x' });
    expect(manager.listUsers().find(u => u.userId === 'x')).toBeUndefined();
  });

  it('非 owner 调用被拒（删封禁记录等于自我解封）', async () => {
    const { manager, call } = await boot();
    manager.setUserLevel({ platform: 'onebot', userId: 'bob' }, -5);
    await expect(
      call('deleteUser', { platform: 'onebot', userId: 'bob' }, { platform: 'onebot', userId: 'bob' }),
    ).rejects.toThrow(/只有 owner/);
    expect(manager.listUsers().find(u => u.userId === 'bob')?.level, '封禁记录不该被非 owner 删掉').toBe(-5);
  });
});

// 三个「改全局闸」的动作与兄弟处理器同一形状：caller 在场且非 owner 即拒。
describe('setRestrictedPolicy / revokeTemporaryGrant / setConfig — 仅 owner 可达', () => {
  it('setRestrictedPolicy：非 owner 调用被拒，策略未落配置', async () => {
    const { call, config } = await boot();
    await expect(
      call('setRestrictedPolicy', { policy: { allow: ['*'] } }, { platform: 'onebot', userId: 'bob' }),
    ).rejects.toThrow(/只有 owner/);
    expect(config.get('restrictedPolicy'), '非 owner 不该开出受限能力白名单').toBeUndefined();
  });

  it('revokeTemporaryGrant：非 owner 调用被拒', async () => {
    const { call } = await boot();
    await expect(call('revokeTemporaryGrant', { id: 'g1' }, { platform: 'onebot', userId: 'bob' })).rejects.toThrow(
      /只有 owner/,
    );
  });

  it('setConfig：非 owner 调用被拒，硬禁清单未被改写', async () => {
    const { call, config } = await boot({ config: { deniedCapabilities: ['tool:shell.exec'] } });
    await expect(call('setConfig', { deniedCapabilities: [] }, { platform: 'onebot', userId: 'bob' })).rejects.toThrow(
      /只有 owner/,
    );
    expect(config.get('deniedCapabilities'), '非 owner 不该拆掉硬禁总闸').toEqual(['tool:shell.exec']);
  });

  it('owner 调用照常放行（闸不误伤 owner）', async () => {
    const { call, config } = await boot();
    const owner = { platform: 'webui', userId: 'console' };
    await call('setRestrictedPolicy', { policy: { allow: ['tool:x'] } }, owner);
    expect((config.get('restrictedPolicy') as { allow: string[] }).allow).toEqual(['tool:x']);
    await call('setConfig', { deniedCapabilities: ['tool:y'] }, owner);
    expect(config.get('deniedCapabilities')).toEqual(['tool:y']);
    await expect(call('revokeTemporaryGrant', { id: 'nope' }, owner)).resolves.toMatchObject({ ok: false });
  });
});

describe('setAuthorityOverride — 抬门槛须撤销旧授予', () => {
  it('抬高最低等级后，该能力上的会话授予立即失效', async () => {
    const { manager, call } = await boot();
    manager.setUserLevel({ platform: 'onebot', userId: 'alice' }, 2);
    manager.setConfirmHandler('*', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
    const grantReq = {
      name: 'shell.exec',
      type: 'tool',
      capability: 'tool:shell.exec',
      sessionId: 's1',
      platform: 'onebot',
      userId: 'alice',
      visibility: 'restricted',
    } as never;
    expect(await manager.requestAccess(grantReq), '前置：授予没建起来就测不到东西').toBe(true);
    expect(manager.isPreApproved(grantReq)).toBe(true);

    // owner 在权限页把门槛抬到 5（典型处置：不封人只抬门槛）
    await call('setAuthorityOverride', { name: 'tool:shell.exec', level: 5 });

    expect(
      manager.isPreApproved(grantReq),
      'authorize 已按新门槛拒绝，救援闸却靠旧授予继续放行——且救援命中直接 return null，连 confirm 轴一并跳过',
    ).toBe(false);
  });
});

describe('setAuthorityOverride — owner 调整单操作最低等级', () => {
  it('写入 config.authorityOverrides 任意整数；非整数删除条目', async () => {
    const { call, config } = await boot();
    await call('setAuthorityOverride', { name: 'tool:weather', level: 5 });
    expect((config.get('authorityOverrides') as Record<string, number>)['tool:weather']).toBe(5);
    await call('setAuthorityOverride', { name: 'tool:weather', level: null });
    expect((config.get('authorityOverrides') as Record<string, number>)['tool:weather']).toBeUndefined();
  });

  it('非 owner 调用被拒', async () => {
    const { call } = await boot();
    await expect(
      call('setAuthorityOverride', { name: 'tool:x', level: 2 }, { platform: 'onebot', userId: 'bob' }),
    ).rejects.toThrow(/只有 owner/);
  });
});

describe('setConfirmOverride — owner 调整单操作确认要求', () => {
  it('写入 session/always/off；非法值删除条目', async () => {
    const { call, config } = await boot();
    await call('setConfirmOverride', { name: 'tool:shell.exec', confirm: 'always' });
    expect((config.get('confirmOverrides') as Record<string, string>)['tool:shell.exec']).toBe('always');
    await call('setConfirmOverride', { name: 'tool:shell.exec', confirm: 'off' });
    expect((config.get('confirmOverrides') as Record<string, string>)['tool:shell.exec']).toBe('off');
    await call('setConfirmOverride', { name: 'tool:shell.exec', confirm: 'nonsense' });
    expect((config.get('confirmOverrides') as Record<string, string>)['tool:shell.exec']).toBeUndefined();
  });

  it('非 owner 调用被拒', async () => {
    const { call } = await boot();
    await expect(
      call('setConfirmOverride', { name: 'tool:x', confirm: 'always' }, { platform: 'onebot', userId: 'bob' }),
    ).rejects.toThrow(/只有 owner/);
  });
});

describe('setAutoConfirm — owner 切 auto 确认模式', () => {
  it('-1 写一直；0 写关；N 写未来截止', async () => {
    const { call, config } = await boot();
    await call('setAutoConfirm', { minutes: -1 });
    expect(config.get('autoConfirmUntil')).toBe(-1);
    await call('setAutoConfirm', { minutes: 0 });
    expect(config.get('autoConfirmUntil')).toBe(0);
    await call('setAutoConfirm', { minutes: 30 });
    expect(config.get('autoConfirmUntil') as number).toBeGreaterThan(Date.now());
  });
  it('非 owner 调用被拒', async () => {
    const { call } = await boot();
    await expect(call('setAutoConfirm', { minutes: 30 }, { platform: 'onebot', userId: 'bob' })).rejects.toThrow(
      /只有 owner/,
    );
  });
});

// users.json 加载失败时整程拒写：等级改动只在内存生效，重启即失。三个等级管理入口的回执
// 必须如实注明，否则 owner 看到的是「成功」，封禁或提权在重启后静默消失。
describe('拒写状态下的等级管理回执', () => {
  const NOTE = '仅本次运行生效，未写入 users.json';
  const owner = { platform: 'webui', userId: 'console' };

  it('users.json 非 v5 而拒写：/level、setUserLevel、deleteUser 的回执都注明未落盘', async () => {
    const legacy = JSON.stringify({ version: 4, users: { 'onebot:777': { tier: 'blocked' } } });
    const { call, runCommand } = await boot({ operations: [], usersJson: legacy });

    expect(await runCommand('level', 'onebot:777', -1)).toContain(NOTE);
    const set = (await call('setUserLevel', { platform: 'onebot', userId: '777', level: -1 }, owner)) as {
      message: string;
    };
    expect(set.message).toContain(NOTE);
    const del = (await call('deleteUser', { platform: 'onebot', userId: '777' }, owner)) as { message: string };
    expect(del.message).toContain(NOTE);
  });

  it('users.json 正常：回执不带该附注', async () => {
    const { call, runCommand } = await boot({ operations: [] });

    expect(await runCommand('level', 'onebot:777', -1)).toBe('已设 onebot:777 等级: -1');
    const set = (await call('setUserLevel', { platform: 'onebot', userId: '777', level: -1 }, owner)) as {
      message: string;
    };
    expect(set.message).not.toContain(NOTE);
    const del = (await call('deleteUser', { platform: 'onebot', userId: '777' }, owner)) as { message: string };
    expect(del.message).not.toContain(NOTE);
  });
});
