import { describe, expect, it } from 'vitest';
import type { ConfigManager, Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import type { StorageService } from '../../packages/plugin-storage-api/src/index.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 数字等级单轴（authorize: deny>owner>level>=minLevel；owner 管理 setUserLevel）
// ════════════════════════════════════════════════════════════

type Cfg = Record<string, unknown>;
function mkConfig(cfg: Cfg = {}): ConfigManager {
  const store: Cfg = { ...cfg };
  return {
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
  } as unknown as ConfigManager;
}
function mkLogger(): Logger {
  const l = { child: () => l, debug() {}, info() {}, warn() {}, error() {} };
  return l as unknown as Logger;
}
// 无文件存储（load 抛错→空表；save no-op）。测试用 setUserLevel 直接喂内存。
const storage = {
  readFile: async () => {
    throw new Error('no file');
  },
  writeFile: async () => {},
} as unknown as StorageService;

const onebot = (id: string) => ({ platform: 'onebot', userId: id });

describe('isOwner', () => {
  it('console + owners 配置命中；其余否', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    expect(m.isOwner('cli', 'console')).toBe(true);
    expect(m.isOwner('webui', 'console')).toBe(true);
    expect(m.isOwner('onebot', 'boss')).toBe(true);
    expect(m.isOwner('onebot', 'rando')).toBe(false);
    expect(m.isOwner('onebot')).toBe(false);
  });
});

describe('authorize（deny > owner > level>=minLevel）', () => {
  it('默认等级(0)：public 放行、restricted 拒', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).toBeNull();
    expect(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' })).toContain('权限不足');
  });

  it('设等级达标放行；owner 直接放行；任意整数等级', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    m.setUserLevel(onebot('1'), 2); // restricted 兜底门槛 = 2
    expect(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' })).toBeNull();
    expect(m.authorize(onebot('boss'), { capability: 'tool:shutdown', visibility: 'restricted' })).toBeNull();
    // owner 永不被有限门槛锁出（即便门槛设到很高）
    m.setUserLevel(onebot('2'), 5);
    expect(m.authorize(onebot('2'), { capability: 'tool:x', visibility: 'public', risk: undefined })).toBeNull();
  });

  it('等级 1 + risk:sensitive(门槛1) 放行；dangerous(门槛2) 拒', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserLevel(onebot('1'), 1);
    expect(m.authorize(onebot('1'), { capability: 'tool:x', visibility: 'restricted', risk: 'sensitive' })).toBeNull();
    expect(
      m.authorize(onebot('1'), { capability: 'tool:y', visibility: 'restricted', risk: 'dangerous' }),
    ).not.toBeNull();
  });

  it('封禁(-1) 压过 public/safe', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserLevel(onebot('1'), -1);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).not.toBeNull();
  });

  it('authorityOverrides 调单操作门槛为任意整数', () => {
    const m = new AuthorityManager(mkConfig({ authorityOverrides: { 'tool:weather': 5 } }), mkLogger(), storage);
    // weather 默认 public(0)，被调到 5：等级 4 拒、5 放行
    m.setUserLevel(onebot('1'), 4);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).not.toBeNull();
    m.setUserLevel(onebot('1'), 5);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).toBeNull();
  });

  it('资源能力受限(restrictedCapabilities)：默认拒、达标放行', () => {
    const m = new AuthorityManager(mkConfig({ restrictedCapabilities: ['storage:secret:*'] }), mkLogger(), storage);
    const req = (id: ReturnType<typeof onebot>) =>
      m.authorize(id, {
        capability: 'tool:save',
        visibility: 'public',
        resourceCapabilities: ['storage:secret:write'],
      });
    expect(req(onebot('1'))).not.toBeNull();
    m.setUserLevel(onebot('1'), 2);
    expect(req(onebot('1'))).toBeNull();
  });

  it('内置受限：读/写 users.json/源码根 默认禁（T1）、owner 放行', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    for (const cap of [
      'storage:path:data:/users.json:write',
      'storage:path:data:/users.json:read',
      'storage:aalis:read',
    ]) {
      expect(
        m.authorize(onebot('1'), { capability: 'tool:fw', visibility: 'public', resourceCapabilities: [cap] }),
      ).not.toBeNull();
      expect(
        m.authorize(onebot('boss'), { capability: 'tool:fw', visibility: 'public', resourceCapabilities: [cap] }),
      ).toBeNull();
    }
  });

  it('全局 deniedCapabilities 连 owner 都压过', () => {
    const m = new AuthorityManager(
      mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }], deniedCapabilities: ['tool:forbidden'] }),
      mkLogger(),
      storage,
    );
    expect(m.authorize(onebot('boss'), { capability: 'tool:forbidden', visibility: 'public' })).toContain('系统禁用');
  });
});

describe('setUserLevel（owner 管理；覆盖式整数）', () => {
  it('设等级即时生效；改等级替换', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserLevel(onebot('1'), 5);
    expect(m.listUsers().find(u => u.userId === '1')?.level).toBe(5);
    m.setUserLevel(onebot('1'), 1);
    expect(m.listUsers().find(u => u.userId === '1')?.level).toBe(1);
  });
  it('默认等级(0)清记录', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserLevel(onebot('1'), 5);
    m.setUserLevel(onebot('1'), 0);
    expect(m.listUsers().find(u => u.userId === '1')).toBeUndefined();
  });
});

describe('持久化（v5 save/load 往返；非 v5 净化丢弃）', () => {
  function memStorage() {
    let written = '';
    return {
      written: () => written,
      svc: {
        writeFile: async (_uri: string, payload: string | Uint8Array) => {
          written = payload as string;
        },
        readFile: async () => {
          if (!written) throw new Error('no file');
          return written;
        },
      } as unknown as StorageService,
    };
  }

  it('等级经 save/init 往返存活，写出 version:5', async () => {
    const s = memStorage();
    const m = new AuthorityManager(mkConfig(), mkLogger(), s.svc);
    m.setUserLevel({ platform: 'onebot', userId: 'a' }, 3);
    m.save();
    await new Promise(r => setTimeout(r, 0));
    expect(JSON.parse(s.written()).version).toBe(5);

    const m2 = new AuthorityManager(mkConfig(), mkLogger(), s.svc);
    await m2.init();
    expect(m2.listUsers().find(u => u.userId === 'a')?.level).toBe(3);
  });

  it('非 v5（旧能力/档位模型）文件按净化策略丢弃', async () => {
    const legacy = {
      readFile: async () => JSON.stringify({ version: 4, users: { 'onebot:a': { tier: 'trusted' } } }),
      writeFile: async () => {},
    } as unknown as StorageService;
    const m = new AuthorityManager(mkConfig(), mkLogger(), legacy);
    await m.init();
    expect(m.listUsers()).toEqual([]);
  });
});
