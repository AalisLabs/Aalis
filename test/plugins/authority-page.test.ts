import { afterEach, describe, expect, it } from 'vitest';
import { type AuthorityService, authority } from '../../packages/api-authority/src/index.js';
import {
  type CommandBuilder,
  type CommandHandler,
  type CommandService,
  commands,
} from '../../packages/api-commands/src/index.js';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { type StorageRootInfo, storage } from '../../packages/api-storage/src/index.js';
import { type ToolService, tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type App, provide, services } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 权限的设置页（数字等级单轴）：用户等级、owner、操作门槛（含整组设门槛）、禁用与免确认，都用「动作带输入」。
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

function fakeToolService(nodes: OpNode[]): ToolService {
  return {
    register: () => () => {},
    registerGroup: () => () => {},
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
  /** 给出即作为 users.json 原文；缺省按文件不存在处理 */
  usersJson?: string;
  /** 给出即替换 users.json 的写入；缺省照写即成功 */
  writeFile?: () => Promise<void>;
  /** 给出即替换 users.json 的读取（优先于 usersJson） */
  readFile?: () => Promise<string>;
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
  const host = app.bind({ provide, services, hostConfig });
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
  host.provide.use(tools, fakeToolService(opts.operations ?? []) as never);

  await app.plugins.register(authorityPlugin, {});
  await app.plugins.idle();

  const manager = host.services.use.get(authority);
  if (!manager) throw new Error('authority 服务未注册 —— 插件没起来');
  /** 调一个动作，成功时回那句结果，失败时把状态码与原因抛出来 */
  const act = async (action: string, body: Record<string, unknown> = {}): Promise<string> => {
    const reply = await pages.act('authority', action, body);
    if (reply.status !== 200) throw new Error(`${reply.status} ${(reply.body as { error: string }).error}`);
    return (reply.body as { message: string }).message;
  };
  /** 以 owner（webui:console）身份直接调指令处理器（不经解析与守卫） */
  const runCommand = async (name: string, ...positionals: unknown[]): Promise<unknown> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`指令 "${name}" 未登记`);
    const session = { sessionId: 's1', platform: 'webui', userId: 'console', raw: `/${name}` };
    return handler({ session, options: {} }, ...positionals);
  };
  return { app, pages, manager, act, runCommand, config: host.hostConfig.use };
}

const canRestricted = (m: AuthorityService, platform: string, userId: string, cap: string) =>
  m.authorize({ platform, userId }, { capability: cap, visibility: 'restricted' }) === null;

describe('权限页的登记', () => {
  it('过登记门槛，放在设置里，四个标签', async () => {
    const { pages } = await boot();
    expect(pages.logs).toEqual([]);
    const view = pages.view('authority');
    expect(view).toMatchObject({ title: '权限', placement: 'settings', icon: 'shield' });
    expect('tabs' in view.content && view.content.tabs.map(tab => tab.title)).toEqual([
      '用户',
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
    expect(await pages.data('authority', 'users')).toEqual([{ identity: 'onebot:123', level: 1, note: '' }]);
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
    { name: 'pub', pluginName: 'zz-a' },
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
    expect(zzA.find(row => row.capability === 'tool:pub')).toMatchObject({
      display: 'pub',
      kind: '工具',
      defaultLevel: 0,
      effectiveLevel: 4,
      level: 4,
    });
    expect(zzA.find(row => row.capability === 'command:res')).toMatchObject({ display: '/res', confirm: '每次' });
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

describe('禁用与免确认', () => {
  it('规则表列出两种规则；禁用写进 deniedCapabilities，免确认写进白名单并保留生效时长，重复加被拒', async () => {
    const { pages, act, config } = await boot({
      config: { deniedCapabilities: ['tool:shell.exec'], restrictedPolicy: { allow: ['tool:a'], duration: 60 } },
    });
    expect(await pages.data('authority', 'rules')).toEqual([
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
    expect(await runCommand('level', 'onebot:777', -3)).toBe('已设 onebot:777 等级: -3');
  });

  it('users.json 正常：回执不带该附注', async () => {
    const { act, runCommand } = await boot();

    expect(await runCommand('level', 'onebot:777', -1)).toBe('已设 onebot:777 等级: -1');
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
      '修好家目录里的 state/users.json 后重启：要能读取，是 version 5 的完好 JSON；旧版本不迁移，不要里面的记录就把它移走再重启。' +
      '修好之前改的等级只在本次运行生效。原因：不是有效的 v5 结构（version: 4）',
  };

  it('发 error 提示写明修法；/level 回执写明怎么修；换上读得出的 storage、重读成功后提示撤回', async () => {
    const legacy = JSON.stringify({ version: 4, users: { 'onebot:777': { tier: 'blocked' } } });
    const { app, pages, runCommand } = await boot({ usersJson: legacy });

    expect(pages.notices()).toEqual([NOTICE]);
    expect(await runCommand('level', 'onebot:777', -1)).toBe(
      '已设 onebot:777 等级: -1；仅本次运行生效，未写入 users.json：它读不出来，修好家目录里的 state/users.json 后重启',
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
    [
      '读不出来',
      { readFile: () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) },
      /^EACCES: permission denied$/,
    ],
  ])('%s：提示末尾带出原因', async (_label, opts, reason) => {
    const { pages } = await boot(opts);
    const [notice] = pages.notices();
    expect(notice?.detail?.split('原因：')[1]).toMatch(reason);
  });

  it('users.json 正常或不存在：不发提示', async () => {
    const { pages } = await boot();
    expect(pages.notices()).toEqual([]);
  });
});
