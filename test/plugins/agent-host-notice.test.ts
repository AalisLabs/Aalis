import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import { type IncomingMessage, type Message, selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 宿主通知回合（plugin-agent 渲染面）：宿主撰写的事件通知不是任何人的发言。
// 当轮以 system 通知呈现（正文 + 注入方包好的不可信段），不产出 user 消息；
// 归档只留宿主正文，不可信段不进历史，之后的回合看不到它；
// 每轮材料（turn-context、turn-hint）落在通知之前、全部历史之后。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:10000:group:20001';
const HOST_BODY = '白纸任务 T-1 已完成，远端说明见 paper_status T-1';
const SENTINEL = 'UNTRUSTED-SENTINEL-7f3a';

/** 与白纸枢纽注入的通知同形：带 source 与无主体 actor，不带 userId、nickname、sessionType、triggerType */
function hostNotice(extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: HOST_BODY,
    sessionId: SESSION,
    platform: 'onebot',
    source: 'paper',
    actor: selfInitiatedActor('onebot'),
    hostNotice: { kind: 'paper-task', id: 'n-1', untrusted: `<remote>${SENTINEL}</remote>` },
    ...extra,
  };
}

const humanMessage: IncomingMessage = {
  content: '做好了吗',
  sessionId: SESSION,
  platform: 'onebot',
  sessionType: 'group',
  userId: '30001',
  nickname: '群友',
  triggerType: 'immediate',
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 以插件身份登记一条 agent:prompt 贡献（贡献点键约束经源码路径导入不生效，同 prompt-assembly.test.ts） */
function promptProbe(name: string, id: string, anchor: string, out: string) {
  return definePlugin({
    name,
    uses: { contributions },
    apply(caps) {
      caps.contributions.contribute('agent:prompt' as never, { id, anchor, build: () => out } as never);
    },
  });
}

async function boot(opts: { probes?: boolean } = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const recorder: ChatModelRequest[] = [];
  await app.plugin(createMockLLMPlugin({ responses: [{ content: '收到' }], recorder }));
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  if (opts.probes) {
    await app.plugin(promptProbe('p-tctx', 'tc', 'turn-context', 'TURN-CONTEXT-BLOCK'));
    await app.plugin(promptProbe('p-hint', 'th', 'turn-hint', 'TURN-HINT-BLOCK'));
  }
  await app.plugin(agentPlugin, { systemPrompt: 'persona' });
  await app.plugins.idle();
  for (const name of [agentPlugin.name, messageArchivePlugin.name, ...(opts.probes ? ['p-tctx', 'p-hint'] : [])]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const host = app.bind({ agent, memory });
  return {
    recorder,
    send: (msg: IncomingMessage) => host.agent.require().handleMessage(msg),
    history: () => host.memory.require().getHistory(SESSION, 50),
  };
}

const text = (m: Message) => String(m.content ?? '');

describe('plugin-agent：宿主通知回合', () => {
  it('当轮渲染为 system 通知（正文 + 不可信段），不产出 user 消息，也不是跨会话委派', async () => {
    const h = await boot();
    await h.send(humanMessage);
    await h.send(hostNotice());
    expect(h.recorder).toHaveLength(2);
    const msgs = h.recorder[1].messages;
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('system');
    expect(text(last)).toContain('[宿主通知]');
    expect(text(last)).toContain(HOST_BODY);
    expect(text(last)).toContain(SENTINEL);
    // 宿主行在前，不可信段接在其后
    expect(text(last).indexOf(HOST_BODY)).toBeLessThan(text(last).indexOf(SENTINEL));
    expect(msgs.filter(m => m.role === 'user' && text(m).includes(HOST_BODY))).toEqual([]);
    expect(msgs.some(m => text(m).includes('[跨会话委派'))).toBe(false);
  });

  it('安全：不可信段不进归档，下一个真人回合看得到宿主正文、看不到不可信段', async () => {
    const h = await boot();
    await h.send(hostNotice());
    await h.send(humanMessage);
    expect(h.recorder).toHaveLength(2);
    const next = JSON.stringify(h.recorder[1].messages);
    expect(next).toContain(HOST_BODY);
    expect(next).not.toContain(SENTINEL);

    const archived = (await h.history()).find(m => m.kind === 'host-notice');
    expect(archived).toMatchObject({ role: 'notice', content: HOST_BODY });
    expect(JSON.stringify(archived)).not.toContain(SENTINEL);
  });

  it('turn-context 与 turn-hint 落在通知之前、全部历史之后', async () => {
    const h = await boot({ probes: true });
    await h.send(humanMessage);
    await h.send(hostNotice());
    const msgs = h.recorder[1].messages;
    const at = (needle: string) => msgs.findIndex(m => text(m).includes(needle));
    const tc = at('TURN-CONTEXT-BLOCK');
    const th = at('TURN-HINT-BLOCK');
    const notice = msgs.findIndex(m => m.role === 'system' && text(m).startsWith('[宿主通知]'));
    // 历史：上一轮的真人消息与她的回复
    const lastHistory = Math.max(
      msgs.findIndex(m => m.role === 'user' && text(m).includes('做好了吗')),
      msgs.findIndex(m => m.role === 'assistant' && text(m) === '收到'),
    );
    expect(lastHistory).toBeGreaterThan(0);
    expect(tc).toBeGreaterThan(lastHistory);
    expect(th).toBeGreaterThan(tc);
    expect(notice).toBe(th + 1);
    expect(notice).toBe(msgs.length - 1);
  });

  it('回归：workflow agent 节点的 proactive 注入仍渲染为跨会话委派、归档为 cross-session-delegation', async () => {
    const h = await boot();
    await h.send({
      content: '去群里发一条提醒',
      sessionId: SESSION,
      platform: 'onebot',
      source: 'workflow:wf-1:n1',
      triggerType: 'proactive',
    });
    const msgs = h.recorder[0].messages;
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('system');
    expect(text(last)).toContain('[跨会话委派 — 非用户消息]');
    expect(last.metadata?.injector).toBe('cross-session-delegation');
    const archived = await h.history();
    expect(archived[0]).toMatchObject({ role: 'notice', kind: 'cross-session-delegation' });
  });

  it('回归：定时任务注入（带 source、不带 hostNotice）仍按 user 渲染', async () => {
    const h = await boot();
    await h.send({
      content: '该喝水了',
      sessionId: SESSION,
      platform: 'onebot',
      userId: '30001',
      source: 'scheduler',
      actor: { platform: 'onebot', userId: '30001' },
    });
    const msgs = h.recorder[0].messages;
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('user');
    expect(text(last)).toContain('该喝水了');
    expect(msgs.some(m => text(m).includes('[宿主通知]'))).toBe(false);
  });
});
