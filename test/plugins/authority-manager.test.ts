import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { resolveText, type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import { mkConfig, noFileStorage, noSessions, silentLogger } from '../fixtures/authority.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 数字等级加权限组（authorize: deny>owner>封禁>level>=minLevel>所属组覆盖；owner 管理 setUserLevel 与 setUserGroups）
// ════════════════════════════════════════════════════════════

const onebot = (id: string) => ({ platform: 'onebot', userId: id });

describe('isOwner', () => {
  it('console + owners 配置命中；其余否', () => {
    const m = new AuthorityManager(
      mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }),
      silentLogger(),
      noFileStorage,
      noSessions,
    );
    expect(m.isOwner('cli', 'console')).toBe(true);
    expect(m.isOwner('webui', 'console')).toBe(true);
    expect(m.isOwner('onebot', 'boss')).toBe(true);
    expect(m.isOwner('onebot', 'rando')).toBe(false);
    expect(m.isOwner('onebot')).toBe(false);
  });
});

describe('authorize（deny > owner > level>=minLevel）', () => {
  it('默认等级(0)：public 放行、restricted 拒', () => {
    const m = new AuthorityManager(mkConfig(), silentLogger(), noFileStorage, noSessions);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).toBeNull();
    expect(toSource(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' }))).toContain(
      '权限不足',
    );
  });

  it('设等级达标放行；owner 直接放行；任意整数等级', () => {
    const m = new AuthorityManager(
      mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }),
      silentLogger(),
      noFileStorage,
      noSessions,
    );
    m.setUserLevel(onebot('1'), 2); // restricted 兜底门槛 = 2
    expect(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' })).toBeNull();
    expect(m.authorize(onebot('boss'), { capability: 'tool:shutdown', visibility: 'restricted' })).toBeNull();
    // owner 永不被有限门槛锁出（即便门槛设到很高）
    m.setUserLevel(onebot('2'), 5);
    expect(m.authorize(onebot('2'), { capability: 'tool:x', visibility: 'public', risk: undefined })).toBeNull();
  });

  it('等级 1 + risk:sensitive(门槛1) 放行；dangerous(门槛2) 拒', () => {
    const m = new AuthorityManager(mkConfig(), silentLogger(), noFileStorage, noSessions);
    m.setUserLevel(onebot('1'), 1);
    expect(m.authorize(onebot('1'), { capability: 'tool:x', visibility: 'restricted', risk: 'sensitive' })).toBeNull();
    expect(
      m.authorize(onebot('1'), { capability: 'tool:y', visibility: 'restricted', risk: 'dangerous' }),
    ).not.toBeNull();
  });

  it('封禁(-1) 压过 public/safe', () => {
    const m = new AuthorityManager(mkConfig(), silentLogger(), noFileStorage, noSessions);
    m.setUserLevel(onebot('1'), -1);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).not.toBeNull();
  });

  it('authorityOverrides 调单操作门槛为任意整数', () => {
    const m = new AuthorityManager(
      mkConfig({ authorityOverrides: { 'tool:weather': 5 } }),
      silentLogger(),
      noFileStorage,
      noSessions,
    );
    // weather 默认 public(0)，被调到 5：等级 4 拒、5 放行
    m.setUserLevel(onebot('1'), 4);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).not.toBeNull();
    m.setUserLevel(onebot('1'), 5);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).toBeNull();
  });

  it('authorityOverrides 写成 Infinity：拒绝语点名能力、写只限 owner，不写 Infinity，不露出原文模板的花括号', () => {
    const m = new AuthorityManager(
      mkConfig({ authorityOverrides: { 'tool:weather': Number.POSITIVE_INFINITY } }),
      silentLogger(),
      noFileStorage,
      noSessions,
    );
    const denied = m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' }) as TextRef;
    expect(denied.source).toBe('权限不足: "tool:weather" 只限 owner');
    expect(resolveText(denied, ['en'])).toBe('Insufficient permission: "tool:weather" is owner-only');
  });

  it('全局 deniedCapabilities 连 owner 都压过', () => {
    const m = new AuthorityManager(
      mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }], deniedCapabilities: ['tool:forbidden'] }),
      silentLogger(),
      noFileStorage,
      noSessions,
    );
    expect(toSource(m.authorize(onebot('boss'), { capability: 'tool:forbidden', visibility: 'public' }))).toContain(
      '系统禁用',
    );
  });
});

describe('权限组（成员存 users.json，组定义存宿主配置 authorityGroups）', () => {
  const GROUPS = { authorityGroups: { search: ['tool:web_search'], ops: ['command:restart', 'tool-group:system'] } };
  const shell = { capability: 'tool:shell_exec', visibility: 'restricted' as const, toolGroups: ['system'] };

  it('成员指向未定义的组不放行；删组不动成员记录', () => {
    const config = mkConfig(GROUPS);
    const m = new AuthorityManager(config, silentLogger(), noFileStorage, noSessions);
    const search = { capability: 'tool:web_search', visibility: 'restricted' as const };
    m.setUserGroups(onebot('1'), ['search']);
    expect(m.authorize(onebot('1'), search)).toBeNull();
    config.set('authorityGroups', { ops: GROUPS.authorityGroups.ops });
    expect(m.authorize(onebot('1'), search)).not.toBeNull();
    expect(m.listUsers().find(u => u.userId === '1')?.groups).toEqual(['search']);
    // 重建同名组即恢复
    config.set('authorityGroups', GROUPS.authorityGroups);
    expect(m.authorize(onebot('1'), search)).toBeNull();
  });

  it('两个组合起来，各放行一样', () => {
    const m = new AuthorityManager(mkConfig(GROUPS), silentLogger(), noFileStorage, noSessions);
    m.setUserGroups(onebot('1'), ['search', 'ops']);
    expect(m.authorize(onebot('1'), { capability: 'tool:web_search', visibility: 'restricted' })).toBeNull();
    expect(m.authorize(onebot('1'), { capability: 'command:restart', visibility: 'restricted' })).toBeNull();
    expect(m.authorize(onebot('1'), shell)).toBeNull();
    expect(m.authorize(onebot('1'), { ...shell, toolGroups: undefined })).not.toBeNull();
    expect(m.authorize(onebot('2'), shell), '不在组里的人照旧按等级').not.toBeNull();
  });

  it('setUserGroups 拒收未定义的组并列出已有的组；去重', () => {
    const m = new AuthorityManager(mkConfig(GROUPS), silentLogger(), noFileStorage, noSessions);
    expect(() => m.setUserGroups(onebot('1'), ['search', 'nope'])).toThrow(
      '没有这些权限组：nope；已有的组：search、ops',
    );
    expect(
      m.listUsers().find(u => u.userId === '1'),
      '拒收时不改记录',
    ).toBeUndefined();
    m.setUserGroups(onebot('1'), ['ops', 'search', 'ops']);
    expect(m.listUsers().find(u => u.userId === '1')?.groups).toEqual(['ops', 'search']);
  });

  it('setUserGroups 只拒这次新加的未定义的组：原有的组被删掉之后原样保存照收', () => {
    const config = mkConfig(GROUPS);
    const m = new AuthorityManager(config, silentLogger(), noFileStorage, noSessions);
    m.setUserGroups(onebot('1'), ['search', 'ops']);
    config.set('authorityGroups', { ops: GROUPS.authorityGroups.ops });
    m.setUserGroups(onebot('1'), ['search', 'ops']);
    expect(m.listUsers().find(u => u.userId === '1')?.groups).toEqual(['search', 'ops']);
    expect(() => m.setUserGroups(onebot('2'), ['ops', 'search'])).toThrow('没有这些权限组：search；已有的组：ops');
    m.setUserGroups(onebot('1'), ['ops']);
    expect(() => m.setUserGroups(onebot('1'), ['ops', 'search']), '去掉之后再加回来算新加').toThrow(
      '没有这些权限组：search；已有的组：ops',
    );
    expect(m.listUsers().find(u => u.userId === '1')?.groups).toEqual(['ops']);
  });

  it('0 级有组的记录降级不删；组也清空之后才删', async () => {
    const m = new AuthorityManager(mkConfig(GROUPS), silentLogger(), noFileStorage, noSessions);
    await m.init(); // 首次读取落定之后才按「什么都没有」清记录
    m.setUserLevel(onebot('1'), 3);
    m.setUserGroups(onebot('1'), ['search']);
    m.setUserLevel(onebot('1'), 0);
    expect(m.listUsers().find(u => u.userId === '1')).toMatchObject({ level: 0, groups: ['search'] });
    m.setUserGroups(onebot('1'), []);
    expect(m.listUsers().find(u => u.userId === '1')).toBeUndefined();
  });
});

describe('setUserLevel（owner 管理；覆盖式整数）', () => {
  it('设等级即时生效；改等级替换', () => {
    const m = new AuthorityManager(mkConfig(), silentLogger(), noFileStorage, noSessions);
    m.setUserLevel(onebot('1'), 5);
    expect(m.listUsers().find(u => u.userId === '1')?.level).toBe(5);
    m.setUserLevel(onebot('1'), 1);
    expect(m.listUsers().find(u => u.userId === '1')?.level).toBe(1);
  });
  it('默认等级(0)清记录', async () => {
    const m = new AuthorityManager(mkConfig(), silentLogger(), noFileStorage, noSessions);
    await m.init(); // 首次读取落定之后才按无备注清记录
    m.setUserLevel(onebot('1'), 5);
    m.setUserLevel(onebot('1'), 0);
    expect(m.listUsers().find(u => u.userId === '1')).toBeUndefined();
  });
});

describe('持久化（v5 save/load 往返）', () => {
  function memStorage() {
    let written = '';
    return {
      written: () => written,
      svc: {
        writeFile: async (_uri: string, payload: string | Uint8Array) => {
          written = payload as string;
        },
        readFile: async () => {
          if (!written) throw Object.assign(new Error('no file'), { code: 'ENOENT' });
          return written;
        },
      } as unknown as StorageService,
    };
  }

  it('等级经 save/init 往返存活，写出 version:5', async () => {
    const s = memStorage();
    const m = new AuthorityManager(mkConfig(), silentLogger(), s.svc, noSessions);
    await m.init(); // 首次读取落定之前 save 不写盘
    m.setUserLevel({ platform: 'onebot', userId: 'a' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 0));
    expect(JSON.parse(s.written()).version).toBe(5);

    const m2 = new AuthorityManager(mkConfig(), silentLogger(), s.svc, noSessions);
    await m2.init();
    expect(m2.listUsers().find(u => u.userId === 'a')?.level).toBe(3);
  });
});

describe('设置项的门槛（setting: 能力）', () => {
  const owners = [{ platform: 'onebot', userId: 'boss' }];
  const cap = 'setting:zz-agent/groups';

  it('meetsLevel：owner 恒过，封禁恒不过，其余按登记等级；门槛为 Infinity 时只有 owner', () => {
    const m = new AuthorityManager(mkConfig({ owners }), silentLogger(), noFileStorage, noSessions);
    m.setUserLevel(onebot('1'), 1);
    m.setUserLevel(onebot('2'), 2);
    m.setUserLevel(onebot('banned'), -1);
    expect(m.meetsLevel(onebot('boss'), Number.POSITIVE_INFINITY)).toBe(true);
    expect(m.meetsLevel(onebot('2'), Number.POSITIVE_INFINITY)).toBe(false);
    expect(m.meetsLevel(onebot('1'), 2)).toBe(false);
    expect(m.meetsLevel(onebot('2'), 2)).toBe(true);
    expect(m.meetsLevel(onebot('banned'), -5)).toBe(false);
    expect(m.meetsLevel(onebot('stranger'), 0)).toBe(true);
  });

  it('authorize 的门槛：authorityOverrides › 请求带的 minLevel › risk 与 visibility；只有 owner 时拒绝文字不写 Infinity', () => {
    const request = { capability: cap, visibility: 'restricted' as const, minLevel: Number.POSITIVE_INFINITY };
    const m = new AuthorityManager(mkConfig({ owners }), silentLogger(), noFileStorage, noSessions);
    m.setUserLevel(onebot('2'), 2);
    expect(m.authorize(onebot('boss'), request)).toBeNull();
    const refused = m.authorize(onebot('2'), request);
    expect(toSource(refused)).toContain('只限 owner');
    expect(toSource(refused)).not.toContain('Infinity');
    expect(m.authorize(onebot('2'), { ...request, minLevel: 1 })).toBeNull();

    const lowered = new AuthorityManager(
      mkConfig({ owners, authorityOverrides: { [cap]: 0 } }),
      silentLogger(),
      noFileStorage,
      noSessions,
    );
    expect(lowered.authorize(onebot('stranger'), request)).toBeNull();
    const denied = new AuthorityManager(
      mkConfig({ owners, deniedCapabilities: ['setting:*'] }),
      silentLogger(),
      noFileStorage,
      noSessions,
    );
    expect(denied.authorize(onebot('boss'), request)).not.toBeNull();
  });
});
