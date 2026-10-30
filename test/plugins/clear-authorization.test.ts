import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { type App, events } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import type { IncomingMessage, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /clear 的门槛：和别的指令一样只看声明（risk: sensitive，等级 1；confirm: session），群聊私聊不分。
// 守卫先按等级裁决，不够就回通用的等级拒绝语，不问确认；够了才问发出者本人。
// 真实的网关、指令与权限插件，经入站管道发指令，结果与提示经出站消息看。
// ════════════════════════════════════════════════════════════

const MEMBER = { platform: 'onebot', userId: '30001' };
const DM = `onebot:10000:private:${MEMBER.userId}`;
const GROUP = 'onebot:10000:group:20001';
const DENIED = '权限不足："command:clear" 需等级 1（当前 0）';
const SESSIONS = [
  ['群里', GROUP],
  ['私聊', DM],
];

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(gatewayPlugin);
  await app.plugin(commandsPlugin);
  await app.plugin(authorityPlugin);
  await app.plugins.idle();
  for (const p of [gatewayPlugin, commandsPlugin, authorityPlugin]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  const host = app.bind({ events, authority });
  const sent: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', msg => {
    sent.push(msg);
  });
  const say = (sessionId: string, content: string) =>
    host.events.use.emit('inbound:message', {
      sessionId,
      ...MEMBER,
      sessionType: sessionId === GROUP ? 'group' : 'private',
      content,
    } as IncomingMessage);
  const to = (sessionId: string) => sent.filter(m => m.sessionId === sessionId).map(m => m.content);
  return { say, to, setLevel: (level: number) => host.authority.use.setUserLevel(MEMBER, level) };
}

describe('/clear 一律 1 级', () => {
  it.each(SESSIONS)('%s 0 级发 /clear：直接回等级拒绝，不问确认', async (_label, sessionId) => {
    const s = await setup();
    await s.say(sessionId, '/clear');
    await vi.waitFor(() => expect(s.to(sessionId)).toHaveLength(1));
    expect(s.to(sessionId)).toEqual([DENIED]);
  });

  it.each(SESSIONS)('%s 1 级：问确认，回 y 后清掉', async (_label, sessionId) => {
    const s = await setup();
    s.setLevel(1);
    await s.say(sessionId, '/clear');
    await vi.waitFor(() => expect(s.to(sessionId)).toHaveLength(1));
    expect(s.to(sessionId)[0]).toContain('/clear');
    await s.say(sessionId, 'y');
    await vi.waitFor(() => expect(s.to(sessionId)).toHaveLength(2));
    expect(s.to(sessionId)[1]).toContain('当前会话消息历史已清空');
  });
});
