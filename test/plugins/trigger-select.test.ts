import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { trigger } from '../../packages/api-trigger/src/index.js';
import { App, events, type LogEntry, LogHub, provide, services } from '../../packages/core/src/index.js';
import layaPlugin from '../../packages/plugin-trigger-laya/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 触发插件二选一：trigger-policy（规则）与 trigger-laya（模型）各自是完整的触发插件，
// trigger 服务的胜者（偏好 > 优先级 > 注册顺序）即生效者，另一个对每条消息直接放行、什么都不做。
// 都启用时 Laya（优先级 10）生效；偏好切到规则即时生效；停用 Laya 后规则在下一条消息接手；
// 两个都不在时 inbound:trigger 不做判定。侧车是本地假服务，memory 是内存替身。
// ════════════════════════════════════════════════════════════

const RULE_LABEL = '规则（计数/评分）';
const AT = '<at self id="10000">Aalis</at> ';

const groupMsg = (content: string): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'group',
  sessionId: 'onebot:10000:group:20001',
  groupId: '20001',
  userId: '30001',
  nickname: '甲',
});

interface Sidecar {
  url: string;
  requests: number;
  /** 应答前等它：卡住判定用 */
  hold?: Promise<void>;
  logit: number;
}

const servers: Server[] = [];
const booted: App[] = [];
let sidecar: Sidecar;

beforeEach(async () => {
  const state: Sidecar = { url: '', requests: 0, logit: -3 };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      state.requests++;
      await state.hold;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logit: state.logit, threshold: 0, version: 'v-test' }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sidecar = state;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const app of booted.splice(0)) await app.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

interface SetupOptions {
  policy?: Record<string, unknown> | false;
  laya?: Record<string, unknown> | false;
}

async function setup(opts: SetupOptions = {}) {
  const logHub = new LogHub();
  const logs: LogEntry[] = [];
  logHub.onEntry(e => logs.push(e));
  const app = new App({ name: 'T', logLevel: 'debug', logHub });
  booted.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, hooks, services, events });
  // 规则插件的 required 依赖；闲置注入经它进入站（这里只记下）
  const injected: IncomingMessage[] = [];
  host.provide(gateway, {
    async ingressMessage(m: IncomingMessage) {
      injected.push(m);
    },
  } as never);
  host.provide(memory, { getFullHistory: async () => [] } as never);
  const defs = [];
  if (opts.policy !== false) {
    await app.plugins.register(triggerPolicyPlugin, opts.policy ?? {});
    defs.push(triggerPolicyPlugin);
  }
  if (opts.laya !== false) {
    await app.plugins.register(layaPlugin, { endpoint: sidecar.url, ...opts.laya });
    defs.push(layaPlugin);
  }
  await app.plugins.idle();
  // 激活闸：依赖缺席时插件停在 pending 而不报错，不核状态会让整组用例伪装成绿
  for (const def of defs) {
    const state = app.plugins.getPlugin(def.name)?.state;
    if (state !== 'active') throw new Error(`${def.name} 未激活（state=${state}）`);
  }
  return {
    app,
    host,
    logs,
    injected,
    send: (message: IncomingMessage) => run(host.hooks, message),
    /** WebUI 服务页切偏好的等价操作 */
    prefer: (label: string) => {
      const view = host.services.all(trigger).find(v => v.label === label);
      if (!view) throw new Error(`trigger 服务里没有「${label}」`);
      host.services.prefer(trigger, view.contextId);
    },
    ruleDecisions: () => logs.filter(e => e.message.startsWith('[trigger] 判定')).map(e => e.message),
  };
}

async function run(chain: Hooks, message: IncomingMessage) {
  let reached = false;
  await chain.run('inbound:trigger', { message, metadata: {}, agent: undefined }, async () => {
    reached = true;
  });
  return { reached, message };
}

/** 规则对每条未点名的群消息都开口 */
const EVERY_MESSAGE = { intervalMode: 'fixed', fixedInterval: 1 };
const EVERY_TWO = { intervalMode: 'fixed', fixedInterval: 2 };

describe('触发插件二选一', () => {
  it('都启用：Laya（优先级 10）生效，规则插件什么都不做（不判定、不计数）', async () => {
    const h = await setup({ policy: EVERY_TWO });
    expect(h.host.services.all(trigger).map(v => v.label)).toEqual(['Laya 模型', RULE_LABEL]);

    // 模型判不回：吞掉。规则若也在判，fixedInterval=2 的第 2 条会被它放行
    expect((await h.send(groupMsg('第 1 条'))).reached).toBe(false);
    expect((await h.send(groupMsg('第 2 条'))).reached).toBe(false);
    expect(sidecar.requests).toBe(2);
    expect(h.ruleDecisions()).toEqual([]);

    // 切到规则后从 0 计：Laya 生效期间经过的消息没有计入规则的计数
    h.prefer(RULE_LABEL);
    expect((await h.send(groupMsg('第 3 条'))).reached).toBe(false);
    expect((await h.send(groupMsg('第 4 条'))).reached).toBe(true);
  });

  it('偏好切到规则：即时生效，Laya 不再请求侧车；切回 Laya 同样即时', async () => {
    const h = await setup({ policy: EVERY_MESSAGE });
    h.prefer(RULE_LABEL);
    const r = await h.send(groupMsg('随便聊聊'));
    expect(r.reached).toBe(true);
    expect(r.message.triggerType).toBe('interval');
    expect(sidecar.requests).toBe(0);
    expect(h.ruleDecisions()).toHaveLength(1);

    h.prefer('Laya 模型');
    expect((await h.send(groupMsg('再聊聊'))).reached).toBe(false);
    expect(sidecar.requests).toBe(1);
    expect(h.ruleDecisions()).toHaveLength(1);
  });

  it('Laya 的 priority 配到规则之下：规则生效', async () => {
    const h = await setup({ policy: EVERY_MESSAGE, laya: { priority: -1 } });
    expect((await h.send(groupMsg('x'))).reached).toBe(true);
    expect(sidecar.requests).toBe(0);
  });

  it('停用 Laya：规则在下一条消息接手；重新启用后 Laya 接回', async () => {
    const h = await setup({ policy: EVERY_MESSAGE });
    expect((await h.send(groupMsg('第 1 条'))).reached).toBe(false);
    expect(await h.app.plugins.disable(layaPlugin.name)).toBe(true);
    expect((await h.send(groupMsg('第 2 条'))).reached).toBe(true);
    expect(sidecar.requests).toBe(1);

    expect(await h.app.plugins.enable(layaPlugin.name)).toBe(true);
    await h.app.plugins.idle();
    expect((await h.send(groupMsg('第 3 条'))).reached).toBe(false);
    expect(sidecar.requests).toBe(2);
  });

  it('两个都不在：不做触发判定，消息照常往下走、不写 triggerType', async () => {
    const h = await setup({ policy: EVERY_TWO });
    await h.app.plugins.disable(layaPlugin.name);
    await h.app.plugins.disable(triggerPolicyPlugin.name);
    expect(h.host.services.all(trigger)).toEqual([]);
    const r = await h.send(groupMsg('随便聊聊'));
    expect(r.reached).toBe(true);
    expect(r.message.triggerType).toBeUndefined();
    expect(sidecar.requests).toBe(0);
  });

  it('判定途中切换偏好：在途消息仍由取下的 Laya 判完，规则不再判第二次', async () => {
    const gate = deferred();
    sidecar.hold = gate.promise;
    sidecar.logit = 3;
    const h = await setup({ policy: { intervalMode: 'fixed', fixedInterval: 100 } });
    const pending = h.send(groupMsg('在途'));
    await vi.waitFor(() => expect(sidecar.requests).toBe(1));
    h.prefer(RULE_LABEL);
    gate.resolve();
    const r = await pending;
    expect(r.reached, 'Laya 判回').toBe(true);
    expect(r.message.triggerType).toBe('interval');
    expect(h.ruleDecisions(), '规则没有再判（否则计数 1/100 会把它吞掉）').toEqual([]);
  });

  it('@ 在 Laya 生效时不强制开口，切到规则后直接开口', async () => {
    const h = await setup({ policy: {} });
    expect((await h.send(groupMsg(`${AT}在吗`))).reached).toBe(false);
    h.prefer(RULE_LABEL);
    const r = await h.send(groupMsg(`${AT}在吗`));
    expect(r.reached).toBe(true);
    expect(r.message.triggerType).toBe('immediate');
  });
});

describe('规则插件的闲置开口只在它生效时', () => {
  it('session 档：Laya 生效期间到点不注入、agent 回复也不记；切回规则后按原排程照常', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = await setup({
      policy: {
        idleTriggerScope: 'session',
        idleTriggerStyle: 'fixed',
        idleTriggerMinutes: 1,
        idleTriggerJitter: false,
      },
    });
    const message = groupMsg('随便聊聊');
    // T0：规则生效时来一条真人消息，建出会话状态，闲置定时器排在 T0+60s
    h.prefer(RULE_LABEL);
    await h.send(message);
    h.prefer('Laya 模型');

    // T0+30s：Laya 生效期间 agent 回复。记下的话会把闲置定时器重排到 T0+90s
    await vi.advanceTimersByTimeAsync(30_000);
    await h.host.events.emit('outbound:message', {
      content: '好的',
      sessionId: message.sessionId,
      platform: 'onebot',
      source: 'agent',
    });
    // T0+60s 到点：不生效，跳过并按原退避重排到 T0+120s
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.injected).toEqual([]);

    h.prefer(RULE_LABEL);
    await vi.advanceTimersByTimeAsync(30_000); // T0+100s
    expect(h.injected, '不生效时的 agent 回复没有重排闲置定时器').toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000); // T0+130s
    expect(h.injected.map(m => m.source)).toEqual(['idle-trigger']);
  });
});
