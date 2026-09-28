import { describe, expect, it } from 'vitest';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { App, events, services } from '../../packages/core/src/index.js';
import { configSchema, normalizeScopes } from '../../packages/plugin-flow-control/src/config.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import {
  createState,
  rateLimitUsedNow,
  SESSION_TTL_MS,
  sweepStaleStates,
} from '../../packages/plugin-flow-control/src/state.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

/** 与插件 apply 同一条路径：parseConfig 之后做作用域核对 */
function readConfig(raw: Record<string, unknown>) {
  const warns: string[] = [];
  const logger = { warn: (message: string) => void warns.push(message) };
  return { cfg: normalizeScopes(parseConfig(configSchema, raw, logger), logger), warns };
}

describe('flow-control config', () => {
  it('缺省字段取 schema 默认值', () => {
    const { cfg, warns } = readConfig({});
    expect(cfg).toEqual({
      scopes: ['*:group'],
      overrides: [],
      cooldownSeconds: 10,
      rateLimitWindow: 0,
      rateLimitMaxReplies: 10,
    });
    expect(warns).toEqual([]);
  });

  it('scopes 不是数组（含逗号分隔的字符串）时回落默认值并告警', () => {
    const { cfg, warns } = readConfig({ scopes: 'onebot:group, cli:*' });
    expect(cfg.scopes).toEqual(['*:group']);
    expect(warns).toEqual([expect.stringContaining('配置项 scopes 期望数组')]);
  });

  it('scopes 的 null 取默认，[] 保持空', () => {
    expect(readConfig({ scopes: null }).cfg.scopes).toEqual(['*:group']);
    expect(readConfig({ scopes: [] }).cfg.scopes).toEqual([]);
  });

  it('数组 scopes 直接用，数字元素转成字符串', () => {
    expect(readConfig({ scopes: ['onebot:private', 20002] }).cfg.scopes).toEqual(['onebot:private', '20002']);
  });

  it('scopes 里的空串与纯空白丢弃并告警；空数组照旧表示不生效', () => {
    const { cfg, warns } = readConfig({ scopes: ['onebot:group', '', '   '] });
    expect(cfg.scopes).toEqual(['onebot:group']);
    expect(warns).toEqual([expect.stringContaining('配置项 scopes 含空白作用域')]);
    expect(readConfig({ scopes: [] }).cfg.scopes).toEqual([]);
  });

  it('只保留节流字段：评分与闲置触发字段已归 trigger-policy', () => {
    const { cfg } = readConfig({ fixedInterval: 100, idleTriggerScope: 'session' });
    expect(Object.keys(cfg).sort()).toEqual(
      ['cooldownSeconds', 'overrides', 'rateLimitMaxReplies', 'rateLimitWindow', 'scopes'].sort(),
    );
  });

  it('激活后 scopes 里的空串与纯空白不生效：作用域外的 WebUI 会话回复后不进冷却', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    try {
      await registerHubs(app);
      await app.plugin(flowControlPlugin, { scopes: ['onebot:group', '', '   '], cooldownSeconds: 30 });
      await app.plugins.idle();
      const host = app.bind({ events, services });
      const svc = host.services.get(flowControl);
      if (!svc) throw new Error('flow-control 服务未注册');
      for (const [sessionId, platform] of [
        ['webui:console', 'webui'],
        ['onebot:10001:group:20002', 'onebot'],
      ]) {
        await host.events.emit('outbound:message', { content: '好的', sessionId, platform, source: 'agent' });
      }
      expect(svc.isCoolingDown('webui:console')).toBe(false);
      expect(svc.isCoolingDown('onebot:10001:group:20002')).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

describe('flow-control state', () => {
  it('createState 初始值合理', () => {
    const s = createState('cli');
    expect(s.platform).toBe('cli');
    expect(s.mutedUntil).toBe(0);
    expect(s.cooldownUntil).toBe(0);
    expect(s.replyTimestamps).toEqual([]);
  });

  it('rateLimitUsedNow 仅计窗口内', () => {
    const cfg = { ...parseConfig(configSchema, {}), rateLimitWindow: 60 };
    const s = createState('p');
    const now = Date.now();
    s.replyTimestamps = [now - 90_000, now - 30_000, now - 10_000];
    expect(rateLimitUsedNow(s, cfg)).toBe(2);
  });
});

describe('flow-control TTL 清扫', () => {
  it('超过 TTL 未见且无挂起禁言/冷却的会话被删，其余保留', () => {
    const now = Date.now();
    const stale = createState('onebot');
    stale.lastSeenAt = now - SESSION_TTL_MS - 1;
    const recent = createState('onebot');
    recent.lastSeenAt = now - SESSION_TTL_MS + 60_000;
    const muted = createState('onebot');
    muted.lastSeenAt = now - SESSION_TTL_MS - 1;
    muted.mutedUntil = now + 60_000;
    const cooling = createState('onebot');
    cooling.lastSeenAt = now - SESSION_TTL_MS - 1;
    cooling.cooldownUntil = now + 1_000;
    const states = new Map([
      ['stale', stale],
      ['recent', recent],
      ['muted', muted],
      ['cooling', cooling],
    ]);

    expect(sweepStaleStates(states, now)).toBe(1);
    expect([...states.keys()].sort()).toEqual(['cooling', 'muted', 'recent']);
  });

  it('禁言/冷却到期后同一会话在下一次清扫时被删', () => {
    const now = Date.now();
    const s = createState('onebot');
    s.lastSeenAt = now - SESSION_TTL_MS - 1;
    s.mutedUntil = now + 60_000;
    const states = new Map([['S', s]]);
    expect(sweepStaleStates(states, now)).toBe(0);
    expect(sweepStaleStates(states, now + 60_001)).toBe(1);
    expect(states.size).toBe(0);
  });
});
