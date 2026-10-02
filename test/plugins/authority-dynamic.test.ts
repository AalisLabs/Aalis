import type { Logger } from '@aalis/core';
import { describe, expect, it, vi } from 'vitest';
import type { HostConfig } from '../../packages/api-host-config/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';

// ════════════════════════════════════════════════════════════
// authority — restrictedPolicy 免确认白名单（可限时）
//
// 已授权但声明了 confirm（session 档）的操作，命中白名单即免确认；always 档与授权轴由执行守卫另管。
// ════════════════════════════════════════════════════════════

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeManager(cfg: Record<string, unknown> = {}): AuthorityManager {
  const config = { get: (k: string) => cfg[k] } as unknown as HostConfig;
  const storage = {} as ConstructorParameters<typeof AuthorityManager>[2];
  return new AuthorityManager(config, makeLogger(), storage);
}

const CAP = 'tool:shell.exec';

describe('restrictedPolicy 白名单（可限时）', () => {
  it('无策略 / 空 allow → 不免；* 全免；精确/glob 命中', () => {
    expect(makeManager().waivesConfirm(CAP)).toBe(false);
    expect(makeManager({ restrictedPolicy: { allow: [] } }).waivesConfirm(CAP)).toBe(false);
    expect(makeManager({ restrictedPolicy: { allow: ['*'] } }).waivesConfirm(CAP)).toBe(true);
    expect(makeManager({ restrictedPolicy: { allow: ['tool:shell.*'] } }).waivesConfirm(CAP)).toBe(true);
    expect(makeManager({ restrictedPolicy: { allow: ['tool:other'] } }).waivesConfirm(CAP)).toBe(false);
  });

  it('限时策略：未 markPolicyEnabled 不免；启用后过期失效', () => {
    vi.useFakeTimers();
    try {
      const m = makeManager({ restrictedPolicy: { allow: ['*'], duration: 60 } });
      expect(m.waivesConfirm(CAP)).toBe(false); // 未启用
      m.markPolicyEnabled();
      expect(m.waivesConfirm(CAP)).toBe(true);
      vi.advanceTimersByTime(61_000);
      expect(m.waivesConfirm(CAP)).toBe(false); // 过期
    } finally {
      vi.useRealTimers();
    }
  });
});
