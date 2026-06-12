import type { ConfigManager, Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/index.js';

/** AuthorityManager 第三参（StorageService）的构造签名类型——测试只需要 read/write 两针 */
type StorageParam = ConstructorParameters<typeof AuthorityManager>[2];

// ════════════════════════════════════════════════════════════
// authority — capability 统一闸（图为唯一裁决：deny > grant > 角色链）
//
// 模型：数字等级是内置角色链的命名（level-1 ⊂ … ⊂ owner）；
// capability 归属角色包由 max(declaredAuthority, requiredAuthorityFor) 决定；
// 用户可被单独 grant（无视等级解锁单个 capability）或 deny（最优先拒绝）。
// ════════════════════════════════════════════════════════════

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeManager(cfg: Record<string, unknown> = {}, storage: Partial<StorageParam> = {}): AuthorityManager {
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigManager;
  return new AuthorityManager(config, makeLogger(), storage as StorageParam);
}

const USERS_JSON_WRITE = 'storage:path:data:/users.json:write';

describe('authorize — 角色链等级门槛', () => {
  it('空 capabilities 退化为纯等级检查', () => {
    const m = makeManager();
    m.setAuthority('qq', 'alice', 3);
    expect(m.authorize({ platform: 'qq', userId: 'alice' }, { capabilities: [], declaredAuthority: 3 })).toBeNull();
    expect(m.authorize({ platform: 'qq', userId: 'alice' }, { capabilities: [], declaredAuthority: 4 })).toMatch(
      /权限不足/,
    );
  });

  it('per-capability 门槛 = max(declared, capability 归属角色等级)', () => {
    const m = makeManager({ ownerAuthority: 5 });
    m.setAuthority('qq', 'alice', 3);
    // 普通写：declared 3 已够
    expect(
      m.authorize(
        { platform: 'qq', userId: 'alice' },
        { capabilities: ['tool:file.write', 'storage:write'], declaredAuthority: 3 },
      ),
    ).toBeNull();
    // 敏感路径 capability 把这一项抬到 owner 级，其他项不受影响但整体被拒
    const denied = m.authorize(
      { platform: 'qq', userId: 'alice' },
      { capabilities: ['tool:file.write', USERS_JSON_WRITE], declaredAuthority: 3 },
    );
    expect(denied).toMatch(/storage:path:data:\/users\.json:write/);
  });

  it('未知用户回退 defaultAuthority', () => {
    const m = makeManager({ defaultAuthority: 1 });
    expect(
      m.authorize({ platform: 'qq', userId: 'nobody' }, { capabilities: ['tool:x'], declaredAuthority: 2 }),
    ).toMatch(/权限不足/);
  });
});

describe('authorize — per-user grant（个别授予解锁，不降低其他门槛）', () => {
  it('grant 命中的 capability 无视等级，其余仍按角色链', () => {
    const m = makeManager({ ownerAuthority: 5 });
    m.setAuthority('qq', 'alice', 3);
    m.setUserCapabilities('qq', 'alice', { grants: [USERS_JSON_WRITE] });
    // 路径 cap 被 grant 放行，tool/storage cap 由等级 3 覆盖 → 整体放行
    expect(
      m.authorize(
        { platform: 'qq', userId: 'alice' },
        { capabilities: ['tool:file.write', 'storage:write', USERS_JSON_WRITE], declaredAuthority: 3 },
      ),
    ).toBeNull();
    // 同请求换一个没有 grant 的同级用户 → 拒绝
    m.setAuthority('qq', 'bob', 3);
    expect(
      m.authorize(
        { platform: 'qq', userId: 'bob' },
        { capabilities: ['tool:file.write', 'storage:write', USERS_JSON_WRITE], declaredAuthority: 3 },
      ),
    ).toMatch(/权限不足/);
  });

  it('grant 是 glob 模式', () => {
    const m = makeManager();
    m.setUserCapabilities('qq', 'alice', { grants: ['tool:file.*'] });
    expect(
      m.authorize({ platform: 'qq', userId: 'alice' }, { capabilities: ['tool:file.read'], declaredAuthority: 4 }),
    ).toBeNull();
    expect(
      m.authorize({ platform: 'qq', userId: 'alice' }, { capabilities: ['tool:shell.exec'], declaredAuthority: 4 }),
    ).toMatch(/权限不足/);
  });

  it('grant 不能越过同操作中未授予的 capability（不整体降门槛）', () => {
    const m = makeManager({ ownerAuthority: 5 });
    m.setAuthority('qq', 'alice', 1);
    m.setUserCapabilities('qq', 'alice', { grants: [USERS_JSON_WRITE] });
    // declared 3 的 tool cap 没被 grant，等级 1 不够 → 拒
    expect(
      m.authorize(
        { platform: 'qq', userId: 'alice' },
        { capabilities: ['tool:file.write', USERS_JSON_WRITE], declaredAuthority: 3 },
      ),
    ).toMatch(/tool:file\.write/);
  });
});

describe('authorize — deny 最优先', () => {
  it('deny 压过等级（等级足够也拒绝）', () => {
    const m = makeManager();
    m.setAuthority('qq', 'alice', 5);
    m.setUserCapabilities('qq', 'alice', { denies: ['tool:shell.*'] });
    expect(
      m.authorize({ platform: 'qq', userId: 'alice' }, { capabilities: ['tool:shell.exec'], declaredAuthority: 1 }),
    ).toMatch(/已被禁止/);
  });

  it('deny 压过 grant（同一 capability 同时命中两表时拒绝）', () => {
    const m = makeManager();
    m.setUserCapabilities('qq', 'alice', { grants: ['tool:x'], denies: ['tool:x'] });
    expect(
      m.authorize({ platform: 'qq', userId: 'alice' }, { capabilities: ['tool:x'], declaredAuthority: 0 }),
    ).toMatch(/已被禁止/);
  });

  it('全局 permissionPolicy 先于用户 grant 生效', () => {
    const m = makeManager({ permissionPolicy: { deny: ['tool:x'] } });
    m.setUserCapabilities('qq', 'alice', { grants: ['tool:x'] });
    expect(
      m.authorize({ platform: 'qq', userId: 'alice' }, { capabilities: ['tool:x'], declaredAuthority: 0 }),
    ).toMatch(/权限策略拒绝/);
  });
});

describe('用户记录管理（v2）', () => {
  it('setUserCapabilities 去重去空；listUsers 返回 grants/denies', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setUserCapabilities('qq', 'alice', { grants: ['tool:a', 'tool:a', '  ', 'tool:b'] });
    const entry = m.listUsers().find(u => u.userId === 'alice');
    expect(entry?.grants).toEqual(['tool:a', 'tool:b']);
    expect(entry?.authority).toBe(1); // 无显式等级时回退 defaultAuthority
  });

  it('grants/denies 清空且无等级时记录被删除', () => {
    const m = makeManager();
    m.setUserCapabilities('qq', 'alice', { grants: ['tool:a'] });
    m.setUserCapabilities('qq', 'alice', { grants: [] });
    expect(m.listUsers()).toEqual([]);
  });

  it('removeUser 删除整条记录（等级 + 授予）', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('qq', 'alice', 4);
    m.setUserCapabilities('qq', 'alice', { grants: ['tool:a'] });
    m.removeUser('qq', 'alice');
    expect(m.listUsers()).toEqual([]);
    expect(m.getAuthority('qq', 'alice')).toBe(1);
  });
});

describe('账户凭据（密码哈希）', () => {
  it('setPassword / verifyPassword 往返；错误密码与未知账户为 false', async () => {
    const m = makeManager();
    await m.setPassword('webui', 'alice', 'hunter2-secret');
    expect(await m.verifyPassword('webui', 'alice', 'hunter2-secret')).toBe(true);
    expect(await m.verifyPassword('webui', 'alice', 'wrong')).toBe(false);
    expect(await m.verifyPassword('webui', 'nobody', 'hunter2-secret')).toBe(false);
    expect(await m.verifyPassword('webui', 'alice', '')).toBe(false);
  });

  it('空密码抛错', async () => {
    const m = makeManager();
    await expect(m.setPassword('webui', 'alice', '')).rejects.toThrow(/密码不能为空/);
  });

  it('listUsers 只暴露 hasPassword 标志，凭据本身永不返回', async () => {
    const m = makeManager({ defaultAuthority: 1 });
    await m.setPassword('webui', 'alice', 'hunter2-secret');
    const entry = m.listUsers().find(u => u.userId === 'alice');
    expect(entry?.hasPassword).toBe(true);
    expect(JSON.stringify(entry)).not.toContain('pbkdf2');
    expect(m.hasPassword('webui', 'alice')).toBe(true);
    expect(m.hasPassword('webui', 'bob')).toBe(false);
  });

  it('setUserCapabilities 清空授予不丢凭据', async () => {
    const m = makeManager();
    await m.setPassword('webui', 'alice', 'hunter2-secret');
    m.setUserCapabilities('webui', 'alice', { grants: ['tool:a'] });
    m.setUserCapabilities('webui', 'alice', { grants: [] });
    expect(await m.verifyPassword('webui', 'alice', 'hunter2-secret')).toBe(true);
  });

  it('凭据经 save/init 往返存活', async () => {
    let written = '';
    const m = makeManager({}, {
      writeFile: async (_uri: string, payload: string | Uint8Array) => {
        written = payload as string;
      },
    } as Partial<StorageParam>);
    await m.setPassword('webui', 'alice', 'hunter2-secret');
    m.save();
    await new Promise(r => setTimeout(r, 0));
    const m2 = makeManager({}, { readFile: async () => written } as Partial<StorageParam>);
    await m2.init();
    expect(await m2.verifyPassword('webui', 'alice', 'hunter2-secret')).toBe(true);
  });
});

describe('users.json 持久化与 v1 迁移', () => {
  it('v1 平面格式自动迁移，save 写出 v2', async () => {
    let written = '';
    const m = makeManager({}, {
      readFile: async () => JSON.stringify({ 'qq:alice': 3, 'onebot:42': 2 }),
      writeFile: async (_uri: string, payload: string | Uint8Array) => {
        written = payload as string;
      },
    } as Partial<StorageParam>);
    await m.init();
    expect(m.getAuthority('qq', 'alice')).toBe(3);
    expect(m.getAuthority('onebot', '42')).toBe(2);
    // v1 迁移标记 dirty，save 应立即写出 v2
    m.save();
    await new Promise(r => setTimeout(r, 0));
    const parsed = JSON.parse(written);
    expect(parsed.version).toBe(2);
    expect(parsed.users['qq:alice']).toEqual({ level: 3 });
  });

  it('v2 格式读写往返（含 grants/denies）', async () => {
    let written = '';
    const storage: Partial<StorageParam> = {
      readFile: async () =>
        JSON.stringify({ version: 2, users: { 'qq:alice': { level: 2, grants: ['tool:file.*'] } } }),
      writeFile: async (_uri: string, payload: string | Uint8Array) => {
        written = payload as string;
      },
    };
    const m = makeManager({}, storage);
    await m.init();
    expect(m.getAuthority('qq', 'alice')).toBe(2);
    expect(
      m.authorize({ platform: 'qq', userId: 'alice' }, { capabilities: ['tool:file.read'], declaredAuthority: 4 }),
    ).toBeNull();
    m.setUserCapabilities('qq', 'alice', { grants: ['tool:file.*'], denies: ['tool:file.delete'] });
    m.save();
    await new Promise(r => setTimeout(r, 0));
    expect(JSON.parse(written).users['qq:alice'].denies).toEqual(['tool:file.delete']);
  });
});
