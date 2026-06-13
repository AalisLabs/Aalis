import type { ConfigManager, Logger } from '@aalis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/index.js';

// ════════════════════════════════════════════════════════════
// authority — 安全关键路径覆盖补强（审计 CRITICAL 覆盖盲区 #15/#16/#18/#20/#23）
//
// 此前 dangerous 确认/会话授权、permissionPolicy 全局裁决、参数级提权 glob、
// 密码凭据边界、用户删除级联均缺测或仅 happy-path——补足攻击/边界路径。
// ════════════════════════════════════════════════════════════

type StorageParam = ConstructorParameters<typeof AuthorityManager>[2];

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeManager(cfg: Record<string, unknown> = {}): AuthorityManager {
  const data: Record<string, unknown> = { defaultAuthority: 1, ownerAuthority: 5, ...cfg };
  const config = { get: (k: string) => data[k] } as unknown as ConfigManager;
  return new AuthorityManager(config, makeLogger(), {} as StorageParam);
}

const req = (over: Partial<Parameters<AuthorityManager['confirmDangerous']>[0]> = {}) => ({
  name: 'shell.exec',
  type: 'tool' as const,
  sessionId: 's1',
  platform: 'onebot',
  ...over,
});

describe('isDangerousAllowed（白名单 + 时效）', () => {
  it('无策略/空 allow → false；* 全放行；精确名/permission 命中', () => {
    expect(makeManager().isDangerousAllowed('shell.exec')).toBe(false);
    expect(makeManager({ dangerousPolicy: { allow: [] } }).isDangerousAllowed('shell.exec')).toBe(false);
    expect(makeManager({ dangerousPolicy: { allow: ['*'] } }).isDangerousAllowed('shell.exec')).toBe(true);
    expect(makeManager({ dangerousPolicy: { allow: ['shell.exec'] } }).isDangerousAllowed('shell.exec')).toBe(true);
    expect(makeManager({ dangerousPolicy: { allow: ['shell.exec'] } }).isDangerousAllowed('file.write')).toBe(false);
    expect(makeManager({ dangerousPolicy: { allow: ['tool:x'] } }).isDangerousAllowed('whatever', ['tool:x'])).toBe(
      true,
    );
  });

  it('限时策略：未 markDangerousEnabled 视为未启用；启用后过期失效', () => {
    vi.useFakeTimers();
    try {
      const m = makeManager({ dangerousPolicy: { allow: ['*'], duration: 60 } });
      expect(m.isDangerousAllowed('x')).toBe(false); // 未 mark → 视为未启用
      m.markDangerousEnabled();
      expect(m.isDangerousAllowed('x')).toBe(true);
      vi.advanceTimersByTime(61_000);
      expect(m.isDangerousAllowed('x')).toBe(false); // 过期
      m.clearDangerousEnabled();
      expect(m.isDangerousAllowed('x')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('confirmDangerous（确认回调 + 会话授权全流程）', () => {
  it('白名单命中直接放行，不调 handler', async () => {
    const m = makeManager({ dangerousPolicy: { allow: ['*'] } });
    const handler = vi.fn();
    m.setConfirmHandler('onebot', handler);
    expect(await m.confirmDangerous(req())).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('无 handler → 拒绝；handler 抛错 → 拒绝（吞掉不外抛）', async () => {
    const m = makeManager();
    expect(await m.confirmDangerous(req())).toBe(false);
    m.setConfirmHandler('onebot', async () => {
      throw new Error('boom');
    });
    expect(await m.confirmDangerous(req())).toBe(false);
  });

  it('handler 返回 boolean / 对象', async () => {
    const m = makeManager();
    m.setConfirmHandler('onebot', async () => true);
    expect(await m.confirmDangerous(req())).toBe(true);
    m.setConfirmHandler('onebot', async () => ({ allowed: false }));
    expect(await m.confirmDangerous(req())).toBe(false);
  });

  it('会话授权：创建 → 同会话同操作复用 → maxUses 用尽失效 → revoke', async () => {
    const m = makeManager();
    let calls = 0;
    m.setConfirmHandler('onebot', async () => {
      calls++;
      return { allowed: true, grant: { scope: 'session', durationSeconds: 600, maxUses: 2 } };
    });
    expect(await m.confirmDangerous(req())).toBe(true); // [1] 创建 grant（handler 1 次），used=0 不消费
    expect(m.listDangerousGrants()).toHaveLength(1);
    expect(await m.confirmDangerous(req())).toBe(true); // [2] 复用，used→1（<2 留）
    expect(m.listDangerousGrants()[0].used).toBe(1);
    expect(await m.confirmDangerous(req())).toBe(true); // [3] 复用，used→2（>=maxUses 删）
    expect(calls).toBe(1); // handler 始终只调一次
    expect(m.listDangerousGrants()).toHaveLength(0);
  });

  it('会话授权 revoke 生效', async () => {
    const m = makeManager();
    m.setConfirmHandler('onebot', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
    await m.confirmDangerous(req());
    const id = m.listDangerousGrants()[0].id;
    expect(m.revokeDangerousGrant(id)).toBe(true);
    expect(m.listDangerousGrants()).toHaveLength(0);
    expect(m.revokeDangerousGrant(id)).toBe(false);
  });

  it('会话授权过期后不再命中（fake timers）', async () => {
    vi.useFakeTimers();
    try {
      const m = makeManager();
      m.setConfirmHandler('onebot', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 1 } }));
      expect(await m.confirmDangerous(req())).toBe(true);
      vi.advanceTimersByTime(2_000);
      // grant 过期 + 无 handler 复用路径：再确认走 handler（仍在），但 listDangerousGrants 应已清
      expect(m.listDangerousGrants()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('授权不跨会话/跨操作复用', async () => {
    const m = makeManager();
    let calls = 0;
    m.setConfirmHandler('onebot', async () => {
      calls++;
      return { allowed: true, grant: { scope: 'session', durationSeconds: 600 } };
    });
    await m.confirmDangerous(req({ sessionId: 's1', name: 'a' }));
    await m.confirmDangerous(req({ sessionId: 's2', name: 'a' })); // 不同会话 → 重新确认
    await m.confirmDangerous(req({ sessionId: 's1', name: 'b' })); // 不同操作 → 重新确认
    expect(calls).toBe(3);
  });
});

describe('permissionPolicy（全局 allow/deny 与用户裁决交互）', () => {
  it('全局 deny 命中 → 拒绝（先于用户 grant）', () => {
    const m = makeManager({ permissionPolicy: { deny: ['tool:danger'] } });
    m.setUserCapabilities('qq', 'a', { grants: ['tool:danger'] });
    expect(m.authorize({ platform: 'qq', userId: 'a' }, { capabilities: ['tool:danger'] })).toMatch(/权限策略拒绝/);
  });

  it('全局 allow 白名单：未命中 allow 的 capability 被拒（即使等级够）', () => {
    const m = makeManager({ permissionPolicy: { allow: ['tool:safe.*'] } });
    m.setAuthority('qq', 'a', 5);
    expect(m.authorize({ platform: 'qq', userId: 'a' }, { capabilities: ['tool:safe.read'] })).toBeNull();
    expect(m.authorize({ platform: 'qq', userId: 'a' }, { capabilities: ['tool:other'] })).toMatch(/未允许/);
  });
});

describe('参数级提权 glob（permissionAuthority 自定义清单）', () => {
  it('自定义 glob 叠加内置；命中多个取最大', () => {
    const m = makeManager({ permissionAuthority: { 'storage:path:data:/secret/*:write': 4 } });
    expect(m.requiredAuthorityFor(['storage:path:data:/secret/x.txt:write'])).toBe(4);
    expect(m.requiredAuthorityFor(['storage:path:data:/public/x.txt:write'])).toBe(0);
    // 内置（users.json owner=5）仍生效；与自定义命中取最大
    expect(m.requiredAuthorityFor(['storage:path:data:/users.json:write', 'storage:path:data:/secret/y:write'])).toBe(
      5,
    );
  });

  it('同模式被配置覆盖（降低内置默认）', () => {
    const m = makeManager({ permissionAuthority: { 'storage:path:data:/users.json:write': 3 } });
    expect(m.requiredAuthorityFor(['storage:path:data:/users.json:write'])).toBe(3);
  });

  it('getEscalationMap 与 requiredAuthorityFor 同源', () => {
    const m = makeManager({ permissionAuthority: { 'x:*': 2 } });
    const map = m.getEscalationMap();
    expect(map['x:*']).toBe(2);
    expect(map['storage:path:data:/users.json:write']).toBe(5); // 内置
  });
});

describe('密码凭据边界（malformed secret）', () => {
  let m: AuthorityManager;
  beforeEach(async () => {
    m = makeManager();
    await m.setPassword('webui', 'alice', 'correct-pw');
  });

  it('正确密码通过，错误密码拒绝', async () => {
    expect(await m.verifyPassword('webui', 'alice', 'correct-pw')).toBe(true);
    expect(await m.verifyPassword('webui', 'alice', 'wrong')).toBe(false);
  });

  it('损坏的凭据格式安全失败（不抛错）', async () => {
    // 通过 setUserCapabilities 注入畸形 secret 不可行（secret 是私有），改测公开路径：
    // 未设密码的账户 verifyPassword 恒 false；空密码恒 false
    expect(await m.verifyPassword('webui', 'nobody', 'x')).toBe(false);
    expect(await m.verifyPassword('webui', 'alice', '')).toBe(false);
  });
});

describe('removeUser 级联（删主账户后绑定身份失效）', () => {
  it('删主账户：被绑身份回退自身记录（留底）', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('onebot', '42', 3);
    m.setAuthority('webui', 'boss', 5);
    const { code } = m.createBindCode('webui', 'boss');
    m.consumeBindCode(code, { platform: 'onebot', userId: '42' });
    expect(m.getAuthority('onebot', '42')).toBe(5); // 随主账户
    m.removeUser('webui', 'boss');
    expect(m.getAuthority('onebot', '42')).toBe(3); // 回退自身留底记录
    expect(m.listUsers().find(u => u.userId === 'boss')).toBeUndefined();
  });

  it('删未绑定用户：等级回退默认', () => {
    const m = makeManager({ defaultAuthority: 1 });
    m.setAuthority('qq', 'x', 4);
    m.removeUser('qq', 'x');
    expect(m.getAuthority('qq', 'x')).toBe(1);
  });
});
