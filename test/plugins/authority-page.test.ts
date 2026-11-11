import { afterEach, describe, expect, it } from 'vitest';
import { type AuthorityService, authority } from '../../packages/api-authority/src/index.js';
import {
  type CommandBuilder,
  type CommandHandler,
  type CommandService,
  commands,
} from '../../packages/api-commands/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { type SessionFieldEntry, sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { type StorageRootInfo, storage } from '../../packages/api-storage/src/index.js';
import { type ToolService, tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type App, provide, services } from '../../packages/core/src/index.js';
import type { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 权限的设置页：用户等级、权限组、owner、操作门槛（含整组设门槛）、禁用与免确认，都用「动作带输入」。
// 装上真插件，webui-server 的真实登记表下发页面、经闸门调动作：输入按声明的字段校验，调用者只有 owner。
// 确认覆盖不在页上（随工作会话的模式另定），配置里的 confirmOverrides 照旧生效。
// ════════════════════════════════════════════════════════════

/** 操作门槛读 commands / tools 服务拿操作清单；两半各给一份同形桩 */
interface OpNode {
  name: string;
  pluginName: string;
  visibility?: 'public' | 'restricted';
  risk?: 'safe' | 'sensitive' | 'dangerous';
  confirm?: 'session' | 'always';
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

function fakeToolService(nodes: OpNode[], groups: string[]): ToolService {
  return {
    register: () => () => {},
    registerGroup: () => () => {},
    getGroups: () => groups.map(name => ({ name, label: name, pluginName: 'zz-a' })),
    getAll: () => nodes,
    setExecutionGuard: () => {},
  } as unknown as ToolService;
}

const running: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of running.splice(0)) {
    await app.stop();
    pages.dispose();
  }
});

interface BootOptions {
  /** 宿主配置的起始值（owners / deniedCapabilities…） */
  config?: Record<string, unknown>;
  /** 给出即提供 commands / tools 桩，getAll 返回这份清单 */
  operations?: OpNode[];
  /** 工具服务桩登记着的工具分组 */
  toolGroups?: string[];
  /** 给出即作为 users.json 原文；缺省按文件不存在处理 */
  usersJson?: string;
  /** 给出即替换 users.json 的写入；缺省照写即成功 */
  writeFile?: () => Promise<void>;
  /** 给出即替换 users.json 的读取（优先于 usersJson） */
  readFile?: () => Promise<string>;
  /** 给出即提供会话设置的桩，getAll 返回这份已登记的设置项 */
  settings?: SessionFieldEntry[];
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
  const pages = pageHost();
  running.push({ app, pages });
  // 可选项来源经贡献点 webui:options 交付
  await registerHubs(app);
  const host = app.bind({ provide, services, hostConfig, contributions });
  const handlers = new Map<string, CommandHandler>();
  host.provide.use(webuiServer, pages.service);
  // 等级表落盘用；多数用例不验持久化，读到「无文件」即空表
  host.provide.use(storage, {
    listRoots: () => [DATA_ROOT],
    readFile:
      opts.readFile ??
      (async () => {
        if (opts.usersJson === undefined) throw new Error('不存在');
        return opts.usersJson;
      }),
    writeFile: opts.writeFile ?? (async () => undefined),
  } as never);
  host.provide.use(commands, fakeCommandService(opts.operations ?? [], handlers) as never);
  host.provide.use(tools, fakeToolService(opts.operations ?? [], opts.toolGroups ?? []) as never);
  const settings = opts.settings;
  if (settings) host.provide.use(sessionSettings, { getAll: () => settings } as never);

  await app.plugins.register(authorityPlugin, {});
  await app.plugins.idle();

  const manager = host.services.use.get(authority) as AuthorityManager | undefined;
  if (!manager) throw new Error('authority 服务未注册 —— 插件未启动');
  /** 调一个动作，成功时回那句结果（原文），失败时把状态码与原因抛出来 */
  const act = async (action: string, body: Record<string, unknown> = {}): Promise<string> => {
    const reply = await pages.act('authority', action, body);
    if (reply.status !== 200) {
      throw new Error(`${reply.status} ${toSource((reply.body as { error: string | TextRef }).error)}`);
    }
    return toSource((reply.body as { message: string | TextRef }).message);
  };
  /** 以 platform:userId 的身份直接调指令处理器（不经解析与守卫），回复取原文 */
  const runAs = async (who: string, name: string, ...positionals: unknown[]): Promise<unknown> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`指令 "${name}" 未登记`);
    const [platform, userId] = who.split(':');
    const session = { sessionId: 's1', platform, userId, raw: `/${name}` };
    return toSource(await handler({ session, options: {} }, ...positionals));
  };
  /** 以 owner（webui:console）身份调指令处理器 */
  const runCommand = (name: string, ...positionals: unknown[]) => runAs('webui:console', name, ...positionals);
  /** 可选项来源 webui:options 里 id 的那一家给出的可选项 */
  const options = async (id: string) => {
    const source = host.contributions.use.collect('webui:options').find(({ spec }) => spec.id === id);
    if (!source) throw new Error(`没有可选项来源 ${id}`);
    return toSource(await source.spec.list());
  };
  return { app, pages, manager, act, runAs, runCommand, options, config: host.hostConfig.use };
}

const canRestricted = (m: AuthorityService, platform: string, userId: string, cap: string) =>
  m.authorize({ platform, userId }, { capability: cap, visibility: 'restricted' }) === null;

describe('权限页的登记', () => {
  it('过登记门槛，放在设置里，五个标签', async () => {
    const { pages } = await boot();
    expect(pages.logs).toEqual([]);
    const view = pages.view('authority');
    expect(toSource(view)).toMatchObject({ title: '权限', placement: 'settings', icon: 'shield' });
    expect('tabs' in view.content && toSource(view.content.tabs.map(tab => tab.title))).toEqual([
      '用户',
      '权限组',
      'Owner',
      '操作门槛',
      '禁用与免确认',
    ]);
  });
});

describe('用户', () => {
  it('表格列出登记的用户（owner 不列）；设等级后达标可过受限操作，并推 invalidate', async () => {
    const { pages, manager, act } = await boot({ config: { owners: [{ platform: 'onebot', userId: 'boss' }] } });
    manager.setUserLevel({ platform: 'onebot', userId: '123' }, 1);
    manager.setUserLevel({ platform: 'onebot', userId: 'boss' }, 3);
    expect(toSource(await pages.data('authority', 'users'))).toEqual([
      { identity: 'onebot:123', level: 1, memberOf: '', groups: [], note: '' },
    ]);
    const before = pages.invalidations.length;
    expect(await act('setUserLevel', { rowKey: 'onebot:123', input: { level: 2 } })).toBe('onebot:123 的等级已设为 2');
    expect(canRestricted(manager, 'onebot', '123', 'tool:shell.exec')).toBe(true);
    expect(pages.invalidations.slice(before)).toContainEqual({
      instance: '@aalis/plugin-authority',
      pageKey: 'authority',
    });
  });

  it('加用户：平台、用户 ID 与等级都要填，等级要是整数', async () => {
    const { manager, act } = await boot();
    expect(await act('addUser', { input: { platform: 'onebot', userId: 'a', level: -1 } })).toBe(
      'onebot:a 的等级已设为 -1',
    );
    expect(manager.listUsers().find(u => u.userId === 'a')?.level).toBe(-1);
    await expect(act('addUser', { input: { platform: 'onebot', userId: 'b', level: 1.5 } })).rejects.toThrow(/^400/);
    await expect(act('addUser', { input: { platform: 'onebot', level: 1 } })).rejects.toThrow(/^400/);
  });

  it('删除记录：整条记录删掉', async () => {
    const { manager, act } = await boot();
    manager.setUserLevel({ platform: 'onebot', userId: 'x' }, -5);
    expect(await act('deleteUser', { rowKey: 'onebot:x' })).toBe('onebot:x 的记录已删除');
    expect(manager.listUsers().find(u => u.userId === 'x')).toBeUndefined();
  });
});

describe('权限组', () => {
  const GROUPS = { authorityGroups: { search: ['tool:web_*'], ops: ['command:restart', 'tool-group:system'] } };
  const tab = (pages: PageHost) => {
    const view = pages.view('authority');
    return 'tabs' in view.content ? view.content.tabs.find(item => item.key === 'permissionGroups') : undefined;
  };

  it('表格列出组名、放行条目与成员数；说明写明组只加放行与本地效果', async () => {
    const { pages, manager } = await boot({ config: GROUPS });
    manager.setUserGroups({ platform: 'onebot', userId: '1' }, ['search', 'ops']);
    manager.setUserGroups({ platform: 'onebot', userId: '2' }, ['ops']);
    expect(await pages.data('authority', 'permissionGroups')).toEqual([
      { name: 'search', entries: ['tool:web_*'], members: 1 },
      { name: 'ops', entries: ['command:restart', 'tool-group:system'], members: 2 },
    ]);
    const description = toSource(tab(pages)?.content[0].description) ?? '';
    for (const part of ['组只加放行', '不开工具分组闸', '需要确认的工具', 'file_read', 'tool-group:']) {
      expect(description).toContain(part);
    }
  });

  it('建组：写进 authorityGroups；坏组名、坏条目与重名当场报错', async () => {
    const { act, config } = await boot({ config: GROUPS });
    expect(await act('createGroup', { input: { name: '群友', entries: ['tool:draw', 'tool-group:search'] } })).toBe(
      '已建权限组 群友',
    );
    expect(config.get('authorityGroups')).toEqual({
      ...GROUPS.authorityGroups,
      群友: ['tool:draw', 'tool-group:search'],
    });
    await expect(act('createGroup', { input: { name: 'a b', entries: ['tool:x'] } })).rejects.toThrow(
      '500 组名只收字母、数字、连字符、下划线与中文，不以连字符开头：a b',
    );
    await expect(act('createGroup', { input: { name: '-ops', entries: ['tool:x'] } })).rejects.toThrow(
      '500 组名只收字母、数字、连字符、下划线与中文，不以连字符开头：-ops',
    );
    await expect(act('createGroup', { input: { name: 'constructor', entries: ['tool:x'] } })).rejects.toThrow(
      '500 constructor 是保留名，不能作组名',
    );
    await expect(
      act('createGroup', { input: { name: 'x', entries: ['tool:x', '*', 'storage:data'] } }),
    ).rejects.toThrow(
      '500 这些放行条目写法不对：*、storage:data；要写成 tool:<工具名>、command:<指令名>（都可用 * 通配）或 tool-group:<工具分组名>',
    );
    await expect(act('createGroup', { input: { name: 'ops', entries: ['tool:x'] } })).rejects.toThrow(
      '500 已经有权限组 ops',
    );
    expect(Object.keys(config.get('authorityGroups') ?? {})).toEqual(['search', 'ops', '群友']);
  });

  it('改条目：整组替换，坏条目报错；没有的组报错', async () => {
    const { act, config } = await boot({ config: GROUPS });
    expect(await act('editGroup', { rowKey: 'search', input: { entries: ['tool:web_search', 'command:*'] } })).toBe(
      '已改权限组 search 的放行条目',
    );
    expect(config.get('authorityGroups')?.search).toEqual(['tool:web_search', 'command:*']);
    await expect(act('editGroup', { rowKey: 'search', input: { entries: ['tool-group:*'] } })).rejects.toThrow(
      '500 这些放行条目写法不对：tool-group:*',
    );
    await expect(act('editGroup', { rowKey: 'none', input: { entries: ['tool:x'] } })).rejects.toThrow(
      '500 没有权限组 none',
    );
  });

  it('删组：成员记录不动、不再放行，用户表标出未定义的组；重建同名组即恢复', async () => {
    const { pages, manager, act, config } = await boot({ config: GROUPS });
    manager.setUserGroups({ platform: 'onebot', userId: '1' }, ['search', 'ops']);
    const canSearch = () =>
      manager.authorize(
        { platform: 'onebot', userId: '1' },
        { capability: 'tool:web_fetch', visibility: 'restricted' },
      );
    expect(canSearch()).toBeNull();
    expect(toSource(pages.view('authority').actions?.deleteGroup.confirm)).toBe(
      '删除这个组？成员记录里的组名保留但不再放行；之后建同名组会恢复这些成员。',
    );
    expect(await act('deleteGroup', { rowKey: 'search' })).toBe('已删除权限组 search');
    expect(config.get('authorityGroups')).toEqual({ ops: GROUPS.authorityGroups.ops });
    expect(manager.listUsers().find(u => u.userId === '1')?.groups).toEqual(['search', 'ops']);
    expect(canSearch()).not.toBeNull();
    expect(toSource(await pages.data('authority', 'users'))).toEqual([
      { identity: 'onebot:1', level: 0, memberOf: 'search（未定义）、ops', groups: ['search', 'ops'], note: '' },
    ]);
    await act('createGroup', { input: { name: 'search', entries: ['tool:web_*'] } });
    expect(canSearch()).toBeNull();
    await expect(act('deleteGroup', { rowKey: 'search2' })).rejects.toThrow('500 没有权限组 search2');
  });

  it('设权限组：覆盖式，不选即清空，未定义的组报错并列出已有的组；删除记录的确认语写明组一并清掉', async () => {
    const { pages, manager, act } = await boot({ config: GROUPS });
    manager.setUserLevel({ platform: 'onebot', userId: '1' }, 1);
    expect(await act('setUserGroups', { rowKey: 'onebot:1', input: { groups: ['ops'] } })).toBe(
      '已设 onebot:1 的权限组：ops',
    );
    expect(manager.listUsers().find(u => u.userId === '1')).toMatchObject({ level: 1, groups: ['ops'] });
    expect(await act('setUserGroups', { rowKey: 'onebot:1', input: {} })).toBe('已清空 onebot:1 的权限组');
    expect(manager.listUsers().find(u => u.userId === '1')?.groups).toEqual([]);
    await expect(act('setUserGroups', { rowKey: 'onebot:1', input: { groups: ['zz'] } })).rejects.toThrow(
      '500 没有这些权限组：zz；已有的组：search、ops',
    );
    expect(toSource(pages.view('authority').actions?.deleteUser.confirm)).toBe(
      '删除这条记录？封禁的用户删掉记录就等于解封，所属权限组一并清掉。',
    );
  });

  it('设权限组：原有的组被删掉之后按预填原样保存照收，新加没定义的组报错', async () => {
    const { manager, act } = await boot({ config: GROUPS });
    manager.setUserGroups({ platform: 'onebot', userId: '1' }, ['search', 'ops']);
    await act('deleteGroup', { rowKey: 'search' });
    expect(await act('setUserGroups', { rowKey: 'onebot:1', input: { groups: ['search', 'ops'] } })).toBe(
      '已设 onebot:1 的权限组：search、ops',
    );
    expect(manager.listUsers().find(u => u.userId === '1')?.groups).toEqual(['search', 'ops']);
    await expect(act('setUserGroups', { rowKey: 'onebot:2', input: { groups: ['search'] } })).rejects.toThrow(
      '500 没有这些权限组：search；已有的组：ops',
    );
  });

  it('改条目与设权限组打开即带已有值：行里带与输入项同名的数组，表单按它预填', async () => {
    const { pages, manager } = await boot({ config: GROUPS });
    manager.setUserGroups({ platform: 'onebot', userId: '1' }, ['ops', 'search']);
    const { actions } = pages.view('authority');
    /** 行动作的表单拿到的预填：这一行里与输入项同名的字段 */
    const prefill = async (action: string, table: string) => {
      const keys = Object.keys(actions?.[action].input ?? {});
      const rows = await pages.data<Array<Record<string, unknown>>>('authority', table);
      return rows.map(row => Object.fromEntries(keys.map(key => [key, row[key]])));
    };
    expect(await prefill('editGroup', 'permissionGroups')).toEqual([
      { entries: ['tool:web_*'] },
      { entries: ['command:restart', 'tool-group:system'] },
    ]);
    expect(await prefill('setUserGroups', 'users')).toEqual([{ groups: ['ops', 'search'] }]);
  });

  it('可选项来源：authority-operations 列全部指令与工具的能力键与已登记的工具分组，authority-groups 列组名', async () => {
    const { options } = await boot({
      config: GROUPS,
      operations: [{ name: 'draw', pluginName: 'zz-a' }],
      toolGroups: ['system', 'search'],
    });
    expect(await options('authority-operations')).toEqual([
      { value: 'command:draw', label: 'command:draw' },
      { value: 'tool:draw', label: 'tool:draw' },
      { value: 'tool-group:system', label: 'tool-group:system' },
      { value: 'tool-group:search', label: 'tool-group:search' },
    ]);
    expect(await options('authority-groups')).toEqual([
      { value: 'search', label: 'search' },
      { value: 'ops', label: 'ops' },
    ]);
  });

  it('可选项来源 authority-groups：成员记录里指向的、已删掉的组也列出来，标「（未定义）」', async () => {
    const { manager, act, options } = await boot({ config: GROUPS });
    manager.setUserGroups({ platform: 'onebot', userId: '1' }, ['search', 'ops']);
    manager.setUserGroups({ platform: 'onebot', userId: '2' }, ['search']);
    await act('deleteGroup', { rowKey: 'search' });
    expect(await options('authority-groups')).toEqual([
      { value: 'ops', label: 'ops' },
      { value: 'search', label: 'search（未定义）' },
    ]);
  });
});

describe('/perm 与 /authority', () => {
  const GROUPS = { authorityGroups: { search: ['tool:web_*'], ops: ['command:restart'] } };

  it('/perm 只有 owner 能用；覆盖式设组，不给组名即清空；没定义的组回原因并列出已有的组', async () => {
    const { manager, runAs, runCommand } = await boot({ config: GROUPS });
    expect(await runAs('onebot:1', 'perm', 'onebot:2', 'ops')).toBe('只有 owner 可管理权限');
    expect(manager.listUsers()).toEqual([]);
    expect(await runCommand('perm', 'onebot:2', 'ops  search')).toBe('已设 onebot:2 的权限组：ops、search');
    expect(manager.listUsers().find(u => u.userId === '2')?.groups).toEqual(['ops', 'search']);
    expect(await runCommand('perm', 'onebot:2')).toBe('已清空 onebot:2 的权限组');
    // 0 级、没有备注也没有组的记录清掉
    expect(manager.listUsers().find(u => u.userId === '2')).toBeUndefined();
    expect(await runCommand('perm', 'onebot:2', '<x>')).toBe('没有这些权限组：<x>；已有的组：search、ops');
    expect(await runCommand('perm', 'onebot:2', 'ops zz')).toBe('没有这些权限组：zz；已有的组：search、ops');
    expect(await runCommand('perm', 'nobody', 'ops')).toBe('目标格式：<platform:userId>');
  });

  it('/authority 的输出带上所属组，未定义的组标出来；没有组的不多这一行', async () => {
    const { manager, config, runAs, runCommand } = await boot({ config: GROUPS });
    manager.setUserGroups({ platform: 'onebot', userId: '1' }, ['ops', 'search']);
    manager.setUserLevel({ platform: 'onebot', userId: '2' }, 1);
    config.set('authorityGroups', { ops: GROUPS.authorityGroups.ops });
    expect(await runAs('onebot:1', 'authority')).toBe('您的等级：0\n所属权限组：ops、search（未定义）');
    expect(await runCommand('authority', 'onebot:1')).toBe('onebot:1 的等级：0\n所属权限组：ops、search（未定义）');
    expect(await runCommand('authority', 'onebot:2')).toBe('onebot:2 的等级：1');
  });
});

describe('Owner', () => {
  it('列出配置里的 owner；加 owner 写进配置，重复加被拒；移除后它不再是 owner', async () => {
    const { pages, manager, act, config } = await boot({
      config: { owners: [{ platform: 'onebot', userId: 'boss' }] },
    });
    expect(await pages.data('authority', 'owners')).toEqual([{ identity: 'onebot:boss' }]);
    expect(await act('addOwner', { input: { platform: 'onebot', userId: 'vice' } })).toBe(
      '已把 onebot:vice 加为 owner',
    );
    expect(config.get('owners')).toEqual([
      { platform: 'onebot', userId: 'boss' },
      { platform: 'onebot', userId: 'vice' },
    ]);
    await expect(act('addOwner', { input: { platform: 'onebot', userId: 'vice' } })).rejects.toThrow(
      '500 onebot:vice 已经是 owner',
    );
    expect(await act('removeOwner', { rowKey: 'onebot:boss' })).toBe('已移除 owner onebot:boss');
    expect(manager.isOwner('onebot', 'boss')).toBe(false);
    await expect(act('removeOwner', { rowKey: 'onebot:boss' })).rejects.toThrow('500 onebot:boss 不是 owner');
  });
});

describe('操作门槛', () => {
  const OPS: OpNode[] = [
    { name: 'pub', pluginName: 'zz-a', confirm: 'session' },
    { name: 'res', pluginName: 'zz-a', visibility: 'restricted', confirm: 'always' },
    { name: 'sen', pluginName: 'zz-b', risk: 'sensitive' },
    // 关键格：risk 是非联合成员的真值串。三个 === 都不中 → 落 visibility 兜底 = 2，不能当成「所有人可用」
    { name: 'odd', pluginName: 'zz-b', visibility: 'restricted', risk: 'CRITICAL' as never },
  ];

  it('按插件分组；详情里每项带后端派生的默认门槛与生效门槛，指令与工具两半都有', async () => {
    const { pages } = await boot({ operations: OPS, config: { authorityOverrides: { 'tool:pub': 4 } } });
    expect(await pages.data('authority', 'groups')).toEqual([
      { plugin: 'zz-a', count: 4, overridden: 1 },
      { plugin: 'zz-b', count: 4, overridden: 0 },
    ]);
    const rows = await pages.data<Array<Record<string, unknown>>>('authority', 'operations', { rowKey: 'zz-b' });
    expect(rows.map(row => [row.capability, row.defaultLevel, row.effectiveLevel])).toEqual([
      ['command:sen', 1, 1],
      ['command:odd', 2, 2],
      ['tool:sen', 1, 1],
      ['tool:odd', 2, 2],
    ]);
    const zzA = await pages.data<Array<Record<string, unknown>>>('authority', 'operations', { rowKey: 'zz-a' });
    expect(toSource(zzA.find(row => row.capability === 'tool:pub'))).toMatchObject({
      display: 'pub',
      kind: '工具',
      defaultLevel: 0,
      effectiveLevel: 4,
      level: 4,
    });
    // 两种「免」都只对 owner，说明在「禁用与免确认」
    expect(toSource(zzA.find(row => row.capability === 'tool:pub'))).toMatchObject({ confirm: '每次（白名单可免）' });
    expect(toSource(zzA.find(row => row.capability === 'command:res'))).toMatchObject({
      display: '/res',
      confirm: '每次（只有确认覆盖设为 off 能免）',
    });
  });

  it('设门槛写进 authorityOverrides，留空恢复默认；不认识的操作回错误', async () => {
    const { act, config } = await boot({ operations: OPS });
    expect(await act('setOperationLevel', { rowKey: 'tool:pub', input: { level: 5 } })).toBe('tool:pub 的门槛已设为 5');
    expect(config.get('authorityOverrides')).toEqual({ 'tool:pub': 5 });
    expect(await act('setOperationLevel', { rowKey: 'tool:pub', input: {} })).toBe('tool:pub 已恢复默认门槛');
    expect(config.get('authorityOverrides')).toEqual({});
    await expect(act('setOperationLevel', { rowKey: 'tool:none', input: { level: 1 } })).rejects.toThrow(
      '500 没有操作 tool:none',
    );
  });

  it('整组设门槛：这一组的每项都写入，别的组不动；留空清掉这一组的覆盖', async () => {
    const { act, config } = await boot({ operations: OPS, config: { authorityOverrides: { 'tool:sen': 1 } } });
    expect(await act('setGroupLevel', { rowKey: 'zz-a', input: { level: 3 } })).toBe('zz-a 的 4 项操作门槛已设为 3');
    expect(config.get('authorityOverrides')).toEqual({
      'tool:sen': 1,
      'command:pub': 3,
      'command:res': 3,
      'tool:pub': 3,
      'tool:res': 3,
    });
    expect(await act('setGroupLevel', { rowKey: 'zz-a', input: {} })).toBe('zz-a 的 4 项操作已恢复默认门槛');
    expect(config.get('authorityOverrides')).toEqual({ 'tool:sen': 1 });
  });
});

describe('操作门槛里的设置项', () => {
  const SETTINGS: SessionFieldEntry[] = [
    { plugin: 'zz-agent', key: 'llm', label: '模型', minLevel: 1 },
    { plugin: 'zz-agent', key: 'groups', label: '工具分组' },
  ];

  it('按实例分组列出，种类为设置项、显示称呼；默认门槛按声明，没写的写「只有 owner」；改过的按改过的', async () => {
    const { pages } = await boot({
      settings: SETTINGS,
      config: { authorityOverrides: { 'setting:zz-agent/groups': 2 } },
    });
    expect(await pages.data('authority', 'groups')).toEqual([{ plugin: 'zz-agent', count: 2, overridden: 1 }]);
    const rows = toSource(
      await pages.data<Array<Record<string, unknown>>>('authority', 'operations', { rowKey: 'zz-agent' }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        capability: 'setting:zz-agent/llm',
        display: '模型',
        kind: '设置项',
        defaultLevel: 1,
        effectiveLevel: 1,
      }),
      expect.objectContaining({
        capability: 'setting:zz-agent/groups',
        display: '工具分组',
        kind: '设置项',
        defaultLevel: '只有 owner',
        effectiveLevel: 2,
        level: 2,
      }),
    ]);
  });

  it('设门槛写进 authorityOverrides；设置项不进权限组的放行条目可选项；会话设置不在时这一类为空', async () => {
    const { act, config, options } = await boot({ settings: SETTINGS });
    expect(await act('setOperationLevel', { rowKey: 'setting:zz-agent/groups', input: { level: 1 } })).toBe(
      'setting:zz-agent/groups 的门槛已设为 1',
    );
    expect(config.get('authorityOverrides')).toEqual({ 'setting:zz-agent/groups': 1 });
    expect((await options('authority-operations')).map(o => o.value)).not.toContain('setting:zz-agent/groups');
    const { pages } = await boot();
    expect(await pages.data('authority', 'groups')).toEqual([]);
  });
});

describe('禁用与免确认', () => {
  it('规则表列出两种规则；禁用写进 deniedCapabilities，免确认写进白名单并保留生效时长，重复加被拒', async () => {
    const { pages, act, config } = await boot({
      config: { deniedCapabilities: ['tool:shell.exec'], restrictedPolicy: { allow: ['tool:a'], duration: 60 } },
    });
    const view = pages.view('authority');
    const rulesTab = 'tabs' in view.content ? view.content.tabs.find(tab => tab.key === 'rules') : undefined;
    expect(toSource(rulesTab?.content[0])).toMatchObject({
      description:
        '禁用压过一切，连 owner 也拒。免确认只对以 owner 身份做的事生效，不放宽等级；别人发起或参与的照旧要 owner 批准，' +
        '无法发起审批的直接拒绝。可写通配，如 tool:*。',
    });
    expect(toSource(view.actions?.waiveConfirm.input?.pattern.description)).toBe(
      '能力键或通配，如 tool:shell_exec、command:level、tool:*。只免以 owner 身份做的事的确认，别人发起或参与的照旧要 owner 批准',
    );
    expect(toSource(await pages.data('authority', 'rules'))).toEqual([
      { key: 'deny:tool:shell.exec', rule: 'tool:shell.exec', kind: '禁用（连 owner 也拒）' },
      { key: 'waive:tool:a', rule: 'tool:a', kind: '免确认' },
    ]);
    expect(await act('denyCapability', { input: { pattern: 'tool:*' } })).toBe(
      '已把 tool:* 加进禁用（连 owner 也拒）清单',
    );
    expect(config.get('deniedCapabilities')).toEqual(['tool:shell.exec', 'tool:*']);
    expect(await act('waiveConfirm', { input: { pattern: ' tool:b ' } })).toBe('已把 tool:b 加进免确认清单');
    expect(config.get('restrictedPolicy')).toEqual({ allow: ['tool:a', 'tool:b'], duration: 60 });
    await expect(act('waiveConfirm', { input: { pattern: 'tool:b' } })).rejects.toThrow(
      '500 tool:b 已经在免确认清单里',
    );
  });

  it('移除规则：从对应清单里删掉；没有这条回错误', async () => {
    const { act, config } = await boot({
      config: { deniedCapabilities: ['tool:x'], restrictedPolicy: { allow: ['tool:x'] } },
    });
    expect(await act('removeRule', { rowKey: 'waive:tool:x' })).toBe('已把 tool:x 移出免确认清单');
    expect(config.get('restrictedPolicy')).toEqual({ allow: [] });
    expect(config.get('deniedCapabilities')).toEqual(['tool:x']);
    expect(await act('removeRule', { rowKey: 'deny:tool:x' })).toBe('已把 tool:x 移出禁用（连 owner 也拒）清单');
    await expect(act('removeRule', { rowKey: 'deny:tool:x' })).rejects.toThrow('500 没有这条规则：deny:tool:x');
  });
});

// 等级改动没写进 users.json 时，三个等级管理入口的回执必须如实注明，否则 owner 看到的是「成功」，
// 封禁或提权在重启后静默消失。加载失败时整程拒写；写盘失败时改动留在内存，等下次保存重写。
describe('未落盘时的等级管理回执', () => {
  const NOTE = '仅本次运行生效，未写入 users.json';

  it('users.json 非 v5 而拒写：/level、设等级、删除记录的回执都注明未落盘', async () => {
    const legacy = JSON.stringify({ version: 4, users: { 'onebot:777': { tier: 'blocked' } } });
    const { act, runCommand } = await boot({ usersJson: legacy });

    expect(await runCommand('level', 'onebot:777', -1)).toContain(NOTE);
    expect(await act('setUserLevel', { rowKey: 'onebot:777', input: { level: -1 } })).toContain(NOTE);
    expect(await act('deleteUser', { rowKey: 'onebot:777' })).toContain(NOTE);
  });

  it('写 users.json 失败（storage 不在线等）：三个入口的回执注明未写入，写成功后附注消失', async () => {
    const SAVE_NOTE = '未写入 users.json（写入失败，见日志）';
    let failing = true;
    const { act, runCommand } = await boot({
      writeFile: async () => {
        if (failing) throw new Error('未知存储根: data');
      },
    });

    expect(await runCommand('level', 'onebot:777', -1)).toContain(SAVE_NOTE);
    expect(await act('setUserLevel', { rowKey: 'onebot:777', input: { level: -2 } })).toContain(SAVE_NOTE);
    expect(await act('deleteUser', { rowKey: 'onebot:777' })).toContain(SAVE_NOTE);

    failing = false;
    expect(await runCommand('level', 'onebot:777', -3)).toBe('已把 onebot:777 的等级设为 -3');
  });

  it('users.json 正常：回执不带该附注', async () => {
    const { act, runCommand } = await boot();

    expect(await runCommand('level', 'onebot:777', -1)).toBe('已把 onebot:777 的等级设为 -1');
    expect(await act('setUserLevel', { rowKey: 'onebot:777', input: { level: -1 } })).not.toContain(NOTE);
    expect(await act('deleteUser', { rowKey: 'onebot:777' })).not.toContain(NOTE);
  });
});

// users.json 读不出来时拒写，文件里的封禁与等级也没载入：只记一行日志 owner 看不到，要发 error 提示写明怎么修，
// 读好之后撤回。/level 的回执同样写明怎么修
describe('users.json 读不出来时的提示', () => {
  const NOTICE = {
    instance: authorityPlugin.name,
    id: 'users-load',
    level: 'error',
    title: '用户等级表 users.json 读不出来，文件里的封禁与等级没有载入',
    detail:
      '修好数据目录里的 state/users.json 后重启：要能读取，是 version 5 的完好 JSON；旧版本不迁移，不要里面的记录就把它移走再重启。' +
      '修好之前改的等级只在本次运行生效。原因：不是有效的 v5 结构（version: 4）',
  };

  it('发 error 提示写明修法；/level 回执写明怎么修；换上读得出的 storage、重读成功后提示撤回', async () => {
    const legacy = JSON.stringify({ version: 4, users: { 'onebot:777': { tier: 'blocked' } } });
    const { app, pages, runCommand } = await boot({ usersJson: legacy });

    expect(toSource(pages.notices())).toEqual([NOTICE]);
    expect(await runCommand('level', 'onebot:777', -1)).toBe(
      '已把 onebot:777 的等级设为 -1；仅本次运行生效，未写入 users.json：它读不出来，修好数据目录里的 state/users.json 后重启',
    );

    // 排在前面的 storage 提供者上线：follow 换人即重读
    app.bind({ provide }).provide.use(
      storage,
      {
        listRoots: () => [DATA_ROOT],
        readFile: async () => JSON.stringify({ version: 5, users: {} }),
        writeFile: async () => undefined,
      } as never,
      { priority: 1 },
    );
    await expect.poll(() => pages.notices()).toEqual([]);
  });

  it.each([
    ['解析不了', { usersJson: '{"version":5,' }, /^JSON 解析失败：\S/],
    ['version 为 null', { usersJson: '{"version":null,"users":{}}' }, /^不是有效的 v5 结构（version: 未知）$/],
    [
      '读不出来',
      { readFile: () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) },
      /^EACCES: permission denied$/,
    ],
  ])('%s：提示末尾带出原因', async (_label, opts, reason) => {
    const { pages } = await boot(opts);
    const [notice] = pages.notices();
    expect(toSource(notice?.detail)?.split('原因：')[1]).toMatch(reason);
  });

  it('users.json 正常或不存在：不发提示', async () => {
    const { pages } = await boot();
    expect(pages.notices()).toEqual([]);
  });
});
