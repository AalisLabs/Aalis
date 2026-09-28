import { describe, expect, it, vi } from 'vitest';
import cursorPlugin from '../../packages/plugin-remote-agent-cursor/src/index.js';
import type { ConfigSchema } from '../../packages/schema-config/src/index.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';

describe('Cursor 配置契约', () => {
  it('无效出网值回落 unknown，低于实测超时下限回落安全默认值', () => {
    const warn = vi.fn();
    const cfg = parseConfig(
      cursorPlugin.configSchema as ConfigSchema,
      {
        apiKey: 'test-only-key',
        egressMode: 'wide-open',
        createTimeoutSeconds: 1,
        requestTimeoutSeconds: 1,
        streamIdleSeconds: 1,
        model: { params: { context: 256 } },
      },
      { warn },
    );
    expect(cfg.egressMode).toBe('unknown');
    expect(cfg.createTimeoutSeconds).toBe(30);
    expect(cfg.requestTimeoutSeconds).toBe(30);
    expect(cfg.streamIdleSeconds).toBe(60);
    expect((cfg.model as { params: Record<string, string> }).params).toEqual({ context: '256' });
    expect(warn).toHaveBeenCalled();
  });

  it('未加引号的布尔模型参数拒绝激活，不静默改用远端默认档位', () => {
    expect(() =>
      parseConfig(cursorPlugin.configSchema as ConfigSchema, {
        apiKey: 'test-only-key',
        model: { params: { fast: false } },
      }),
    ).toThrow(/model\.params 期望 string 值/);
  });
});
