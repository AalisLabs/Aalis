import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { mkConfig, noFileStorage, noSessions, silentLogger } from '../fixtures/authority.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 数字等级单轴（authorize: deny>owner>level>=minLevel；owner 管理 setUserLevel）
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
    expect(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' })).toContain('权限不足');
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

  it('全局 deniedCapabilities 连 owner 都压过', () => {
    const m = new AuthorityManager(
      mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }], deniedCapabilities: ['tool:forbidden'] }),
      silentLogger(),
      noFileStorage,
      noSessions,
    );
    expect(m.authorize(onebot('boss'), { capability: 'tool:forbidden', visibility: 'public' })).toContain('系统禁用');
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
