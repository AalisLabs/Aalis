import { describe, expect, it } from 'vitest';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { resolveFields } from '../../packages/api-session-settings/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import { configSchema, type FlowControlSettings } from '../../packages/plugin-flow-control/src/config.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import {
  createState,
  rateLimitUsedNow,
  SESSION_TTL_MS,
  sweepStaleStates,
} from '../../packages/plugin-flow-control/src/state.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { recordRoom } from '../fixtures/rooms.js';
import { fakeMemory } from '../fixtures/session-memory.js';

/** 只有全局层（插件配置）时一个会话的参数：与插件按会话读的同一解析 */
const settingsOf = (raw: Record<string, unknown>) =>
  resolveFields(configSchema, raw, { parts: [] }, () => {}).values as FlowControlSettings;

describe('flow-control 按会话的参数', () => {
  it('四项都可按会话设，只适用于房间；缺省取 schema 默认值，生效范围默认只管多方房间', () => {
    expect(Object.keys(configSchema).sort()).toEqual(
      ['audience', 'cooldownSeconds', 'rateLimitMaxReplies', 'rateLimitWindow'].sort(),
    );
    for (const field of Object.values(configSchema)) expect(field.session.appliesTo).toEqual(['room']);
    expect(settingsOf({})).toEqual({
      audience: 'multiParty',
      cooldownSeconds: 10,
      rateLimitWindow: 0,
      rateLimitMaxReplies: 10,
    });
  });

  it('激活后只管生效范围内的房间：WebUI 会话回复后不进冷却，群照常', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    try {
      await registerHubs(app);
      const host = app.bind({ events, provide, services });
      host.provide.use(memory, fakeMemory() as never);
      await app.plugin(sessionManagerPlugin);
      await app.plugin(flowControlPlugin, { cooldownSeconds: 30 });
      await app.plugins.idle();
      const svc = host.services.use.get(flowControl);
      if (!svc) throw new Error('flow-control 服务未注册');
      // 群按原生入站收录，会话管理记下它的聊天窗口，回复计数按它判生效范围
      await recordRoom(host.events.use, 'onebot:10001:group:20002');
      for (const [sessionId, platform] of [
        ['webui:console', 'webui'],
        ['onebot:10001:group:20002', 'onebot'],
      ]) {
        await host.events.use.emit('outbound:message', { content: '好的', sessionId, platform, source: 'agent' });
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
    const cfg = settingsOf({ rateLimitWindow: 60 });
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
