import { describe, expect, it } from 'vitest';
import type { ConfigManager, Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import type { StorageService } from '../../packages/plugin-storage-api/src/index.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 档位单轴（authorize: deny>owner>rank>=minTier；owner 管理 setUserTier）
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
// 无文件存储（load 抛错→空表；save no-op）。测试用 setUserTier 直接喂内存。
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

describe('authorize（deny > owner > rank>=minTier）', () => {
  it('访客(默认)：public 放行、restricted 拒', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).toBeNull();
    expect(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' })).toContain('权限不足');
  });

  it('设信任档达标放行；owner 直接放行', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    m.setUserTier(onebot('1'), 'trusted');
    expect(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' })).toBeNull();
    expect(m.authorize(onebot('boss'), { capability: 'tool:shutdown', visibility: 'restricted' })).toBeNull();
  });

  it('朋友档 + risk:sensitive 放行；dangerous(信任门槛)拒', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserTier(onebot('1'), 'friend');
    expect(m.authorize(onebot('1'), { capability: 'tool:x', visibility: 'restricted', risk: 'sensitive' })).toBeNull();
    expect(
      m.authorize(onebot('1'), { capability: 'tool:y', visibility: 'restricted', risk: 'dangerous' }),
    ).not.toBeNull();
  });

  it('封禁(-1) 压过 public/safe', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserTier(onebot('1'), 'banned');
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).not.toBeNull();
  });

  it('tierOverrides 调单操作门槛', () => {
    const m = new AuthorityManager(mkConfig({ tierOverrides: { 'tool:weather': 2 } }), mkLogger(), storage);
    // weather 默认 public(访客)，被调到信任(2)：访客拒
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).not.toBeNull();
    m.setUserTier(onebot('1'), 'trusted');
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).toBeNull();
  });

  it('资源能力受限(restrictedCapabilities)：访客拒、信任放行', () => {
    const m = new AuthorityManager(mkConfig({ restrictedCapabilities: ['storage:secret:*'] }), mkLogger(), storage);
    const req = (id: ReturnType<typeof onebot>) =>
      m.authorize(id, {
        capability: 'tool:save',
        visibility: 'public',
        resourceCapabilities: ['storage:secret:write'],
      });
    expect(req(onebot('1'))).not.toBeNull();
    m.setUserTier(onebot('1'), 'trusted');
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

describe('setUserTier（owner 管理；覆盖式）', () => {
  it('设档即时生效；改档替换', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserTier(onebot('1'), 'trusted');
    expect(m.listUsers().find(u => u.userId === '1')?.tier).toBe('trusted');
    m.setUserTier(onebot('1'), 'friend');
    expect(m.listUsers().find(u => u.userId === '1')?.tier).toBe('friend');
  });
  it('visitor（默认档）清记录', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserTier(onebot('1'), 'trusted');
    m.setUserTier(onebot('1'), 'visitor');
    expect(m.listUsers().find(u => u.userId === '1')).toBeUndefined();
  });
});

describe('持久化（v4 save/load 往返；非 v4 净化丢弃）', () => {
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

  it('档位经 save/init 往返存活，写出 version:4', async () => {
    const s = memStorage();
    const m = new AuthorityManager(mkConfig(), mkLogger(), s.svc);
    m.setUserTier({ platform: 'onebot', userId: 'a' }, 'trusted');
    m.save();
    await new Promise(r => setTimeout(r, 0));
    expect(JSON.parse(s.written()).version).toBe(4);

    const m2 = new AuthorityManager(mkConfig(), mkLogger(), s.svc);
    await m2.init();
    expect(m2.listUsers().find(u => u.userId === 'a')?.tier).toBe('trusted');
  });

  it('非 v4（旧能力/等级模型）文件按净化策略丢弃', async () => {
    const legacy = {
      readFile: async () => JSON.stringify({ version: 3, users: { 'onebot:a': { caps: { grant: ['tool:x'] } } } }),
      writeFile: async () => {},
    } as unknown as StorageService;
    const m = new AuthorityManager(mkConfig(), mkLogger(), legacy);
    await m.init();
    expect(m.listUsers()).toEqual([]);
  });
});
