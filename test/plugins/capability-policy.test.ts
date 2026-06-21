import { describe, expect, it } from 'vitest';
import type { ConfigManager, Logger } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { resolveCapabilityPolicy, riskDefaults } from '../../packages/plugin-authority-api/src/index.js';
import type { StorageService } from '../../packages/plugin-storage-api/src/index.js';

// ════════════════════════════════════════════════════════════
// 能力两轴正交模型：轴 A 授权(visibility) × 轴 B 确认(confirm) + risk 糖 + 自动判危
// ════════════════════════════════════════════════════════════

function mkConfig(cfg: Record<string, unknown> = {}): ConfigManager {
  const store = { ...cfg };
  return { get: (k: string) => store[k], set: (k: string, v: unknown) => (store[k] = v) } as unknown as ConfigManager;
}
function mkLogger(): Logger {
  const l = { child: () => l, debug() {}, info() {}, warn() {}, error() {} };
  return l as unknown as Logger;
}
const storage = {
  readFile: async () => {
    throw new Error('no file');
  },
  writeFile: async () => {},
} as unknown as StorageService;
const req = (confirm?: 'session' | 'always', cap = 'tool:x', sessionId = 's') => ({
  name: 'x',
  type: 'tool' as const,
  capability: cap,
  sessionId,
  platform: 'onebot',
  confirm,
});

describe('resolveCapabilityPolicy（risk 展开 + 显式覆盖 + 默认）', () => {
  it('risk 对角线：safe/sensitive/dangerous → (visibility, confirm)', () => {
    expect(resolveCapabilityPolicy({ risk: 'safe' })).toEqual({ visibility: 'public', confirm: undefined });
    expect(resolveCapabilityPolicy({ risk: 'sensitive' })).toEqual({ visibility: 'restricted', confirm: undefined });
    expect(resolveCapabilityPolicy({ risk: 'dangerous' })).toEqual({ visibility: 'restricted', confirm: 'session' });
  });
  it('显式 visibility/confirm 覆盖 risk 推导', () => {
    expect(resolveCapabilityPolicy({ risk: 'dangerous', visibility: 'public' })).toEqual({
      visibility: 'public',
      confirm: 'session',
    });
    expect(resolveCapabilityPolicy({ risk: 'safe', confirm: 'always' })).toEqual({
      visibility: 'public',
      confirm: 'always',
    });
  });
  it('三者皆缺省 → 兜底默认：tools/commands=public，actions=restricted', () => {
    expect(resolveCapabilityPolicy({})).toEqual({ visibility: 'public', confirm: undefined });
    expect(resolveCapabilityPolicy({}, 'restricted')).toEqual({ visibility: 'restricted', confirm: undefined });
  });
  it('正交：(public × confirm) 合法——人人可用但需确认', () => {
    expect(resolveCapabilityPolicy({ visibility: 'public', confirm: 'session' })).toEqual({
      visibility: 'public',
      confirm: 'session',
    });
  });
  it('riskDefaults：无 risk 返回空对象（保留「未声明=继承」语义）', () => {
    expect(riskDefaults(undefined)).toEqual({});
    expect(riskDefaults('dangerous')).toEqual({ visibility: 'restricted', confirm: 'session' });
  });
});

describe('requestAccess：confirm 语义 + "*" 通配 fallback', () => {
  it('精确平台 handler 优先于 "*" fallback', async () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    m.setConfirmHandler('webui', async () => true);
    m.setConfirmHandler('*', async () => false);
    expect(await m.requestAccess({ ...req('session'), platform: 'webui' })).toBe(true); // 精确
    expect(await m.requestAccess({ ...req('session'), platform: 'onebot' })).toBe(false); // fallback
  });

  it('confirm="session"：首次问、之后本会话内记住（不再问）', async () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    let calls = 0;
    m.setConfirmHandler('*', async () => {
      calls++;
      return { allowed: true, grant: { scope: 'session', durationSeconds: 600 } };
    });
    expect(await m.requestAccess(req('session'))).toBe(true);
    expect(await m.requestAccess(req('session'))).toBe(true);
    expect(calls).toBe(1); // 第二次走会话临时授予，不再回调
  });

  it('confirm="always"：每次都问，不接受会话记忆', async () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    let calls = 0;
    m.setConfirmHandler('*', async () => {
      calls++;
      return { allowed: true, grant: { scope: 'session', durationSeconds: 600 } };
    });
    expect(await m.requestAccess(req('always'))).toBe(true);
    expect(await m.requestAccess(req('always'))).toBe(true);
    expect(calls).toBe(2); // always 跳过临时授予 + 不建会话授予 → 每次回调
  });

  it('无任何 handler → 拒（fail-closed）', async () => {
    const m = new AuthorityManager(mkConfig(), mkLogger(), storage);
    expect(await m.requestAccess(req('session'))).toBe(false);
  });
});
