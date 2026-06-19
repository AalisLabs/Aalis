import { describe, expect, it } from 'vitest';
import type { ConfigManager, Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import type { StorageService } from '../../packages/plugin-storage-api/src/index.js';

// ════════════════════════════════════════════════════════════
// AuthorityManager —— 纯能力委托模型（authorize + 委托子集 + owner）
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
// 无文件存储（load 抛错→空表；save no-op）。测试用 setUserCapabilities 直接喂内存。
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

describe('authorize（deny > owner > public > granted）', () => {
  it('public 操作放行；restricted 未授予拒绝', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).toBeNull();
    expect(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' })).toContain('需授予');
  });

  it('授予 restricted 后放行；owner 直接放行', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    m.setUserCapabilities(null, onebot('1'), { grant: ['tool:shutdown'] });
    expect(m.authorize(onebot('1'), { capability: 'tool:shutdown', visibility: 'restricted' })).toBeNull();
    expect(m.authorize(onebot('boss'), { capability: 'tool:shutdown', visibility: 'restricted' })).toBeNull();
  });

  it('deny 最高优先：压过 public / owner / granted', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    m.setUserCapabilities(null, onebot('boss'), { deny: ['tool:nuke'] });
    expect(m.authorize(onebot('boss'), { capability: 'tool:nuke', visibility: 'restricted' })).not.toBeNull();
    m.setUserCapabilities(null, onebot('1'), { deny: ['tool:weather'] });
    expect(m.authorize(onebot('1'), { capability: 'tool:weather', visibility: 'public' })).not.toBeNull();
  });

  it('资源能力受限由 restrictedCapabilities 判定', () => {
    const m = new AuthorityManager(mkConfig({ restrictedCapabilities: ['storage:secret:*'] }), mkLogger(), storage);
    // public 主能力 + 受限资源能力，未授予 → 拒
    expect(
      m.authorize(onebot('1'), {
        capability: 'tool:save',
        visibility: 'public',
        resourceCapabilities: ['storage:secret:write'],
      }),
    ).not.toBeNull();
    // 授予后放行
    m.setUserCapabilities(null, onebot('1'), { grant: ['storage:secret:write'] });
    expect(
      m.authorize(onebot('1'), {
        capability: 'tool:save',
        visibility: 'public',
        resourceCapabilities: ['storage:secret:write'],
      }),
    ).toBeNull();
  });

  it('内置受限：写 users.json 默认禁、仅 owner/被授予', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    const cap = 'storage:path:data:/users.json:write';
    expect(
      m.authorize(onebot('1'), { capability: 'tool:fw', visibility: 'public', resourceCapabilities: [cap] }),
    ).not.toBeNull();
    expect(
      m.authorize(onebot('boss'), { capability: 'tool:fw', visibility: 'public', resourceCapabilities: [cap] }),
    ).toBeNull();
  });

  it('内置受限：读 users.json/scheduler-jobs/源码根 默认禁（T1 防裸读凭据表）、owner 放行', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    for (const cap of [
      'storage:path:data:/users.json:read',
      'storage:path:data:/scheduler-jobs.json:read',
      'storage:aalis:read',
    ]) {
      // 非 owner 经 public 的 file_read 触达这些资源能力 → 拒
      expect(
        m.authorize(onebot('1'), { capability: 'tool:file_read', visibility: 'public', resourceCapabilities: [cap] }),
      ).not.toBeNull();
      // owner 放行
      expect(
        m.authorize(onebot('boss'), {
          capability: 'tool:file_read',
          visibility: 'public',
          resourceCapabilities: [cap],
        }),
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

describe('setUserCapabilities 委托子集约束', () => {
  it('owner 可委托一切', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    expect(() =>
      m.setUserCapabilities(onebot('boss'), onebot('sub'), { grant: ['tool:*', 'storage:secret:write'] }),
    ).not.toThrow();
  });

  it('非 owner 只能委托自己持有的；越权抛错', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    // 系统/owner 上下文先给 granter 授 tool:foo
    m.setUserCapabilities(null, onebot('granter'), { grant: ['tool:foo'] });
    // granter 委托 tool:foo 给 sub → ok
    expect(() => m.setUserCapabilities(onebot('granter'), onebot('sub'), { grant: ['tool:foo'] })).not.toThrow();
    // granter 想放大成 tool:* → 越权抛错
    expect(() => m.setUserCapabilities(onebot('granter'), onebot('sub2'), { grant: ['tool:*'] })).toThrow(/越权/);
    expect(() => m.setUserCapabilities(onebot('granter'), onebot('sub2'), { grant: ['storage:x:write'] })).toThrow(
      /越权/,
    );
  });

  it('A1: 非 owner 不能修改 owner 的能力（防 deny>owner 锁死 owner）', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    m.setUserCapabilities(null, onebot('attacker'), { grant: ['tool:foo'] });
    expect(() => m.setUserCapabilities(onebot('attacker'), onebot('boss'), { deny: ['*'] })).toThrow(/不能修改 owner/);
    // owner / 系统上下文仍可改（跳过约束）
    expect(() => m.setUserCapabilities(null, onebot('boss'), { deny: ['tool:x'] })).not.toThrow();
  });

  it('A1: deny 也受子集约束（非 owner 只能 deny 自己持有的）', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserCapabilities(null, onebot('granter'), { grant: ['tool:foo'] });
    m.setUserCapabilities(onebot('granter'), onebot('sub'), { grant: ['tool:foo'] });
    expect(() => m.setUserCapabilities(onebot('granter'), onebot('sub'), { deny: ['tool:foo'] })).not.toThrow();
    expect(() => m.setUserCapabilities(onebot('granter'), onebot('sub'), { deny: ['tool:bar'] })).toThrow(/越权/);
  });

  it('A1: 非 owner 只能管理自己委托的下层（不能改他人/系统建的记录）', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setUserCapabilities(null, onebot('granter'), { grant: ['tool:foo'] });
    m.setUserCapabilities(null, onebot('other'), { grant: ['tool:foo'] }); // 系统建、grantedBy 未设
    expect(() => m.setUserCapabilities(onebot('granter'), onebot('other'), { grant: ['tool:foo'] })).toThrow(
      /只能管理你自己委托的下层/,
    );
    expect(() => m.setUserCapabilities(onebot('granter'), onebot('mine'), { grant: ['tool:foo'] })).not.toThrow();
    expect(() => m.setUserCapabilities(onebot('granter'), onebot('mine'), { deny: ['tool:foo'] })).not.toThrow();
  });

  it('grantedBy 记录委托父，listDelegatees 可展开', () => {
    const m = new AuthorityManager(mkConfig({ owners: [{ platform: 'onebot', userId: 'boss' }] }), mkLogger(), storage);
    m.setUserCapabilities(onebot('boss'), onebot('child'), { grant: ['tool:foo'] });
    const kids = m.listDelegatees(onebot('boss'));
    expect(kids.some(u => u.userId === 'child' && u.grantedBy === 'onebot:boss')).toBe(true);
  });
});

describe('持久化（v3 save/load 往返；非 v3 净化丢弃）', () => {
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

  it('能力委托经 save/init 往返存活，且写出 version:3', async () => {
    const s = memStorage();
    const m = new AuthorityManager(mkConfig(), mkLogger(), s.svc);
    m.setUserCapabilities(null, { platform: 'onebot', userId: 'a' }, { grant: ['tool:x'], deny: ['tool:y'] });
    m.save();
    await new Promise(r => setTimeout(r, 0));
    expect(JSON.parse(s.written()).version).toBe(3);

    const m2 = new AuthorityManager(mkConfig(), mkLogger(), s.svc);
    await m2.init();
    expect(m2.authorize(onebot('a'), { capability: 'tool:x', visibility: 'restricted' })).toBeNull();
    expect(m2.authorize(onebot('a'), { capability: 'tool:y', visibility: 'public' })).not.toBeNull(); // deny 存活
  });

  it('非 v3（旧版本）文件按净化策略丢弃', async () => {
    const legacy = {
      readFile: async () => JSON.stringify({ version: 2, users: { 'onebot:a': { level: 5, grants: ['tool:x'] } } }),
      writeFile: async () => {},
    } as unknown as StorageService;
    const m = new AuthorityManager(mkConfig(), mkLogger(), legacy);
    await m.init();
    expect(m.listUsers()).toEqual([]); // v2 数据被丢弃
  });
});
