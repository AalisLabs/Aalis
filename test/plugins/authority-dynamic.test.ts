import type { ConfigManager, Logger } from '@aalis/core';
import type { AccessRequest } from '@aalis/plugin-authority-api';
import { describe, expect, it, vi } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';

// ════════════════════════════════════════════════════════════
// authority — 临时能力委托（restricted 能力的时限/限次放行）
//
// 新模型用「临时委托」替代旧的"危险操作确认"：用户触达未授予的 restricted 能力时，
// 过 requestAccess —— ① restrictedPolicy 白名单（可限时）② 会话内临时授予复用
// ③ 确认回调（owner 批准，可带 session 范围）。
// ════════════════════════════════════════════════════════════

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeManager(cfg: Record<string, unknown> = {}): AuthorityManager {
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigManager;
  const storage = {} as ConstructorParameters<typeof AuthorityManager>[2];
  return new AuthorityManager(config, makeLogger(), storage);
}

const req = (over: Partial<AccessRequest> = {}): AccessRequest => ({
  name: 'shell.exec',
  type: 'tool',
  capability: 'tool:shell.exec',
  sessionId: 's1',
  platform: 'onebot',
  ...over,
});

describe('restrictedPolicy 白名单（可限时）', () => {
  it('无策略 / 空 allow → 不放行；* 全放行；精确/glob 命中', async () => {
    expect(await makeManager().requestAccess(req())).toBe(false);
    expect(await makeManager({ restrictedPolicy: { allow: [] } }).requestAccess(req())).toBe(false);
    expect(await makeManager({ restrictedPolicy: { allow: ['*'] } }).requestAccess(req())).toBe(true);
    expect(await makeManager({ restrictedPolicy: { allow: ['tool:shell.*'] } }).requestAccess(req())).toBe(true);
    expect(await makeManager({ restrictedPolicy: { allow: ['tool:other'] } }).requestAccess(req())).toBe(false);
  });

  it('限时策略：未 markPolicyEnabled 不放行；启用后过期失效', async () => {
    vi.useFakeTimers();
    try {
      const m = makeManager({ restrictedPolicy: { allow: ['*'], duration: 60 } });
      expect(await m.requestAccess(req())).toBe(false); // 未启用
      m.markPolicyEnabled();
      expect(await m.requestAccess(req())).toBe(true);
      vi.advanceTimersByTime(61_000);
      expect(await m.requestAccess(req())).toBe(false); // 过期
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('确认回调 + 会话临时授予', () => {
  it('无 handler → 拒绝；handler 抛错 → 拒绝（吞掉不外抛）', async () => {
    const m = makeManager();
    expect(await m.requestAccess(req())).toBe(false);
    m.setConfirmHandler('onebot', async () => {
      throw new Error('boom');
    });
    expect(await m.requestAccess(req())).toBe(false);
  });

  it('handler 返回 boolean / 对象', async () => {
    const m = makeManager();
    m.setConfirmHandler('onebot', async () => true);
    expect(await m.requestAccess(req())).toBe(true);
    m.setConfirmHandler('onebot', async () => ({ allowed: false }));
    expect(await m.requestAccess(req())).toBe(false);
  });

  it('会话授予：创建 → 同会话同能力复用 → maxUses 用尽失效', async () => {
    const m = makeManager();
    let calls = 0;
    m.setConfirmHandler('onebot', async () => {
      calls++;
      return { allowed: true, grant: { scope: 'session', durationSeconds: 600, maxUses: 2 } };
    });
    expect(await m.requestAccess(req())).toBe(true); // [1] 创建 grant（used=0 不消费）
    expect(m.listTemporaryGrants()).toHaveLength(1);
    expect(await m.requestAccess(req())).toBe(true); // [2] 复用 used→1
    expect(m.listTemporaryGrants()[0].used).toBe(1);
    expect(await m.requestAccess(req())).toBe(true); // [3] 复用 used→2（>=maxUses 删）
    expect(calls).toBe(1); // handler 始终只调一次
    expect(m.listTemporaryGrants()).toHaveLength(0);
  });

  it('revokeTemporaryGrant 生效', async () => {
    const m = makeManager();
    m.setConfirmHandler('onebot', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 600 } }));
    await m.requestAccess(req());
    const id = m.listTemporaryGrants()[0].id;
    expect(m.revokeTemporaryGrant(id)).toBe(true);
    expect(m.listTemporaryGrants()).toHaveLength(0);
    expect(m.revokeTemporaryGrant(id)).toBe(false);
  });

  it('授予不跨会话/跨能力复用', async () => {
    const m = makeManager();
    let calls = 0;
    m.setConfirmHandler('onebot', async () => {
      calls++;
      return { allowed: true, grant: { scope: 'session', durationSeconds: 600 } };
    });
    await m.requestAccess(req({ sessionId: 's1', capability: 'tool:a' }));
    await m.requestAccess(req({ sessionId: 's2', capability: 'tool:a' })); // 不同会话 → 重新确认
    await m.requestAccess(req({ sessionId: 's1', capability: 'tool:b' })); // 不同能力 → 重新确认
    expect(calls).toBe(3);
  });

  it('会话授予过期后不再命中（fake timers）', async () => {
    vi.useFakeTimers();
    try {
      const m = makeManager();
      m.setConfirmHandler('onebot', async () => ({ allowed: true, grant: { scope: 'session', durationSeconds: 1 } }));
      expect(await m.requestAccess(req())).toBe(true);
      vi.advanceTimersByTime(2_000);
      expect(m.listTemporaryGrants()).toHaveLength(0); // 过期被剪
    } finally {
      vi.useRealTimers();
    }
  });
});
