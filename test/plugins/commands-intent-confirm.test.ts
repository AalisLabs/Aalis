import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import type {} from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type App, events, services } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import { tryDispatchSubcommand } from '../../packages/runtime/src/subcommand.js';
import type { IncomingMessage, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 指令的确认是意图确认：人亲手输入的指令声明了 confirm，就在同一会话里向发出者本人问一句，
// 只认这个人在这个会话里的下一条消息（带 source 的注入不认），超时取消；不走 owner 审批。
// 定时任务触发的指令与 runtime 一次性子命令不问（skipConfirm），always 档照常要确认、无从确认即拒。
// 真实的网关、指令与权限插件；结果与提示经出站消息看，放行到后续相位的消息在 dispatch 相位记下。
// ════════════════════════════════════════════════════════════

const MEMBER = { platform: 'onebot', userId: '30001' };
const OTHER = { platform: 'onebot', userId: '30002' };
const DM = `onebot:10000:private:${MEMBER.userId}`;
const GROUP = 'onebot:10000:group:20001';
const TIMEOUT_MS = 60_000;

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
});

async function setup({
  confirm = 'session',
  appConfig = {},
}: {
  confirm?: 'session' | 'always';
  appConfig?: object;
} = {}) {
  const { app } = hostedApp(appConfig);
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
  const host = app.bind({ events, hooks, services, commands });
  let runs = 0;
  host.commands.use.command('probe', '探针', { confirm }).action(async () => {
    runs++;
    return 'ran';
  });
  const sent: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', msg => {
    sent.push(msg);
  });
  /** 过了指令相位、往下走的消息（这里拦住，不交给 agent） */
  const passed: IncomingMessage[] = [];
  host.hooks.use.middleware('inbound:dispatch', async data => {
    passed.push(data.message);
  });
  const say = (msg: Partial<IncomingMessage> & { content: string }) =>
    host.events.use.emit('inbound:message', {
      sessionId: DM,
      ...MEMBER,
      sessionType: 'private',
      ...msg,
    } as IncomingMessage);
  const to = (sessionId: string) => sent.filter(m => m.sessionId === sessionId).map(m => m.content);
  return { app, host, say, sent, to, passed, runs: () => runs };
}

describe('人亲手输入的指令：向发出者本人确认意图', () => {
  it('本人在同一会话回 y：执行；提示发进这个会话，回复被吞掉不往下走', async () => {
    const s = await setup();
    await s.say({ content: '/probe' });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(1));
    expect(s.to(DM)[0]).toContain('/probe');
    expect(s.runs(), '确认之前不得执行').toBe(0);
    await s.say({ content: ' Y ' });
    await vi.waitFor(() => expect(s.to(DM)).toEqual([expect.any(String), 'ran']));
    expect(s.runs()).toBe(1);
    expect(s.passed, '确认回复不得进入后续相位').toEqual([]);
  });

  it('本人回别的话：取消，不执行；这条回复同样被吞掉', async () => {
    const s = await setup();
    await s.say({ content: '/probe' });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(1));
    await s.say({ content: '算了' });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(2));
    expect(s.to(DM)[1]).toContain('没有得到发出者确认');
    expect(s.runs()).toBe(0);
    expect(s.passed).toEqual([]);
  });

  const notCounted: Array<[string, Partial<IncomingMessage>]> = [
    ['同一会话里别人回 y', { sessionId: GROUP, ...OTHER, sessionType: 'group' }],
    ['本人在另一个会话回 y', { sessionId: `onebot:10000:private:${OTHER.userId}` }],
    ['带 source 的注入（同一个人）回 y', { source: 'workflow:wf:n1' }],
  ];
  it.each(notCounted)('%s：不算应答，照常往下走；本人之后仍能确认', async (_label, reply) => {
    const s = await setup();
    const origin = reply.sessionId === GROUP ? { sessionId: GROUP, sessionType: 'group' as const } : {};
    await s.say({ content: '/probe', ...origin });
    const where = origin.sessionId ?? DM;
    await vi.waitFor(() => expect(s.to(where)).toHaveLength(1));
    await s.say({ content: 'y', ...reply });
    await vi.waitFor(() => expect(s.passed.map(m => m.content)).toEqual(['y']));
    expect(s.runs()).toBe(0);
    await s.say({ content: 'y', ...origin });
    await vi.waitFor(() => expect(s.runs()).toBe(1));
  });

  it('超时不回：取消，不执行', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await setup();
    await s.say({ content: '/probe' });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.to(DM)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(s.to(DM), '时限之内还在等').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.to(DM)[1]).toContain('没有得到发出者确认');
    await s.say({ content: 'y' });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runs(), '超时后的 y 不得补执行').toBe(0);
    expect(
      s.passed.map(m => m.content),
      '超时后的 y 是普通消息',
    ).toEqual(['y']);
  });

  it('指令插件重载：等待中的确认当即按取消结算，不留到时限；之后回的 y 是普通消息', async () => {
    const s = await setup();
    await s.say({ content: '/probe' });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(1));
    await s.app.plugins.bounce(commandsPlugin.name);
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(2));
    expect(s.to(DM)[1]).toContain('没有得到发出者确认');
    await s.say({ content: 'y' });
    await vi.waitFor(() => expect(s.passed.map(m => m.content)).toEqual(['y']));
    expect(s.runs()).toBe(0);
  });

  it('群成员在私聊里 /clear 清自己的记忆：本人确认后照常清理', async () => {
    const s = await setup();
    await s.say({ content: '/clear' });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(1));
    await s.say({ content: 'y' });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(2));
    expect(s.to(DM)[1]).toContain('当前会话消息历史已清空');
  });

  it('带 source 注入的指令需要确认：无从确认，直接拒，不发提示', async () => {
    const s = await setup();
    await s.say({ content: '/probe', source: 'workflow:wf:n1', userId: undefined });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(1));
    expect(s.to(DM)[0]).toContain('需要发出者本人确认');
    expect(s.runs()).toBe(0);
  });

  it('带 source 也带 userId 的注入（子任务的派发与追问）里的指令需要确认：不问，直接拒', async () => {
    const s = await setup();
    await s.say({ content: '/probe', source: 'subtask', userId: `parent:${DM}` });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(1));
    expect(s.to(DM)[0]).toContain('需要发出者本人确认');
    expect(s.runs()).toBe(0);
  });

  it('不知道发出者是谁（适配器没给 userId）：问不到本人，直接拒，不发提示', async () => {
    const s = await setup();
    await s.say({ content: '/probe', userId: undefined });
    await vi.waitFor(() => expect(s.to(DM)).toHaveLength(1));
    expect(s.to(DM)[0]).toContain('需要发出者本人确认');
    expect(s.runs()).toBe(0);
  });

  it('confirmOverrides 关掉确认：不问，直接执行', async () => {
    const s = await setup({ appConfig: { confirmOverrides: { 'command:probe': 'off' } } });
    await s.say({ content: '/probe' });
    await vi.waitFor(() => expect(s.to(DM)).toEqual(['ran']));
  });
});

describe('没人可问的受信来源：skipConfirm 照旧', () => {
  const scheduled = {
    content: '/probe',
    sessionId: 'internal',
    platform: 'internal',
    source: 'scheduler',
    userId: undefined,
    sessionType: undefined,
    actor: { platform: 'webui', userId: 'console' },
  };

  it('定时任务触发的指令：session 档不问直接执行', async () => {
    const s = await setup();
    await s.say(scheduled);
    await vi.waitFor(() => expect(s.runs()).toBe(1));
    expect(s.sent, '不发确认提示').toEqual([]);
  });

  it('定时任务触发的指令：always 档无从确认，拒绝', async () => {
    const s = await setup({ confirm: 'always' });
    const done = vi.fn();
    s.host.events.use.on('gateway:phase:done', ({ phase }) => {
      if (phase === 'inbound:command') done();
    });
    await s.say(scheduled);
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(s.runs()).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it('runtime 一次性子命令：session 档直接执行，always 档拒绝', async () => {
    const session = await setup();
    const printed: string[] = [];
    expect(await tryDispatchSubcommand(session.host.services.use, ['probe'], m => printed.push(m))).toBe(0);
    expect(printed).toEqual(['ran']);

    const always = await setup({ confirm: 'always' });
    const out: string[] = [];
    await tryDispatchSubcommand(always.host.services.use, ['probe'], m => out.push(m));
    expect(always.runs()).toBe(0);
    expect(out[0]).toContain('需要发出者本人确认');
  });
});
