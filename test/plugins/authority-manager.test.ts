import { describe, expect, it } from 'vitest';
import type { AccessRequest } from '../../packages/api-authority/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { ConfigManager, Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';

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

describe('硬化：未授权不可自我提权 / deny 绝对 / 群内不跨用户白嫖', () => {
  const req = (over: Partial<AccessRequest> = {}): AccessRequest => ({
    name: 'shell.exec',
    type: 'tool',
    capability: 'tool:shell.exec',
    sessionId: 'group:1',
    platform: 'onebot',
    userId: '1',
    ...over,
  });

  it('#1 未授权操作无 owner 预放行 → isPreApproved=false（守卫据此硬拒，不弹自我确认）', () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    expect(m.isPreApproved(req({ capability: 'command:shutdown', type: 'command', name: 'shutdown' }))).toBe(false);
  });

  it('#2 deny 绝对：deniedCapabilities 压过 restrictedPolicy.allow:["*"]', () => {
    // ⚠️ 本用例原先用的是**非 owner** 身份（userId '1'，mkConfig 未配 owners）却断言白名单
    // 放行 —— 那正是「白名单不带身份判据」这个漏洞被写成了预期行为。现在白名单限 owner，
    // 故这里显式给 owner 身份，才测得到「硬禁压过白名单」这个本意。
    const m = new AuthorityManager(
      mkConfig({
        owners: [{ platform: 'onebot', userId: '1' }],
        deniedCapabilities: ['tool:shell'],
        restrictedPolicy: { allow: ['*'] },
      }),
      mkLogger(),
      storage,
    );
    expect(m.isPreApproved(req({ capability: 'tool:shell' }))).toBe(false); // 硬禁压过白名单
    expect(m.isPreApproved(req({ capability: 'tool:weather' }))).toBe(true); // 未禁 + owner 白名单 → 放行
  });

  it('#3 群内临时授予绑 userId：A 批准不让同会话 B 白嫖', async () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setConfirmHandler('*', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
    const rA = req({ userId: 'A' });
    expect(await m.requestAccess(rA)).toBe(true); // A 回 YS → 生成绑 A 的会话授予
    expect(m.isPreApproved(rA)).toBe(true); // A 本人：命中
    expect(m.isPreApproved(req({ userId: 'B' }))).toBe(false); // 同会话同能力的 B：userId 不匹配 → 不白嫖
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

describe('restrictedPolicy 白名单：只救 owner 自己', () => {
  // 本方法被守卫的「未授权」分支当作救援闸（plugin-authority 的 guard 里
  // `return authority.isPreApproved(accessBase) ? null : denied`），所以一条不带身份判据的
  // 白名单等于把「免确认」偷偷变成「免授权」。实测 owner 配 allow:['tool:*'] 之后，
  // 任何用户（含被封禁到 -5 的）都能过。同一函数下半截的会话授予本就带 userId 匹配。
  const mk = (extra: Record<string, unknown> = {}) => {
    const data: Record<string, unknown> = {
      owners: [{ platform: 'onebot', userId: 'boss' }],
      restrictedPolicy: { allow: ['tool:*'] },
      ...extra,
    };
    const config = {
      get: (k: string) => data[k],
      set: (k: string, v: unknown) => {
        data[k] = v;
      },
    } as unknown as ConfigManager;
    return new AuthorityManager(config, mkLogger(), {
      writeFile: async () => undefined,
    } as unknown as StorageService);
  };
  const req = (platform: string, userId: string) => ({
    name: 'shell.exec',
    type: 'tool' as const,
    capability: 'tool:shell.exec',
    sessionId: 's',
    platform,
    userId,
  });

  it('owner 本人仍被白名单放行（自动化免确认不受影响）', () => {
    expect(mk().isPreApproved(req('onebot', 'boss'))).toBe(true);
  });

  it('普通用户不被白名单放行', () => {
    expect(mk().isPreApproved(req('onebot', 'someone'))).toBe(false);
  });

  it('**被封禁的用户**尤其不得被白名单救回', () => {
    const m = mk();
    m.setUserLevel({ platform: 'onebot', userId: 'banned' }, -5);
    expect(
      m.authorize(
        { platform: 'onebot', userId: 'banned' },
        { capability: 'tool:shell.exec', visibility: 'restricted' },
      ),
    ).not.toBeNull();
    expect(m.isPreApproved(req('onebot', 'banned')), '白名单不带身份判据时这里会是 true').toBe(false);
  });

  it('硬禁压过白名单（含 owner）', () => {
    const m = mk({ deniedCapabilities: ['tool:shell.*'] });
    expect(m.isPreApproved(req('onebot', 'boss'))).toBe(false);
  });
});
