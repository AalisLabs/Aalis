import { gateway } from '@aalis/api-gateway';
import { processService } from '@aalis/api-process';
import { type StorageRootInfo, storage } from '@aalis/api-storage';
import { type RegisteredTool, tools } from '@aalis/api-tools';
import { App, events, provide } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { type FlowControlService, flowControl } from '../../packages/api-flow-control/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import sessionToolsPlugin from '../../packages/plugin-tool-session/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 回复闸门：trigger-policy 决定要不要开口，flow-control 只做节流硬闸。
//
// 全部经真实插件（gateway + trigger-policy + flow-control，委派用例另加 tool-session 与
// onebot 适配器）走 gateway 入站相位链驱动；agent 是记录型假件，只在测试指定时回复
// （回复走 gateway.dispatchOutbound，source='agent'，与真实 agent 同路）。
//
// 「缺陷」与「相位」两组是重组前的复现用例：在旧代码（flow 先于 trigger、idle 在 flow-control、
// 委派经适配器 checkAndRecordProactiveSend 预记一次回复）上逐条确认为断言失败。
// 两个插件的配置分开下发：core 不按 schema 校验，混发会掩盖字段放错插件。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const AT = `<at self id="${SELF}">Aalis</at> `;
const sid = (groupId: string) => `onebot:${SELF}:group:${groupId}`;
const privateSid = (userId: string) => `onebot:${SELF}:private:${userId}`;

const groupMsg = (groupId: string, content: string, userId = '30001'): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'group',
  sessionId: sid(groupId),
  groupId,
  userId,
  nickname: '群友',
});

const privateMsg = (userId: string, content: string): IncomingMessage => ({
  content,
  platform: 'onebot',
  sessionType: 'private',
  sessionId: privateSid(userId),
  userId,
  nickname: '网友',
});

/** 与 onebot 适配器合成的群聊戳一戳同形：昵称内嵌在 content 里，用户可控 */
const pokeMsg = (groupId: string, nickname: string, userId = '30001'): IncomingMessage => ({
  ...groupMsg(groupId, `[戳一戳: ${nickname}(${userId}) 戳了你]`, userId),
  nickname,
  noticeType: 'poke',
});

type ToolHandler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<string>;

interface Harness {
  app: App;
  /** 抵达 dispatch（agent.handleMessage）的全部消息 */
  received: IncomingMessage[];
  /** 抵达 agent 的消息正文（按内容比对，不依赖相位链是否透传同一对象引用） */
  contents: () => string[];
  /** 抵达 agent 的 idle 注入 */
  idles: () => IncomingMessage[];
  /** 真人入站：走 gateway.ingressMessage（等整条相位链跑完） */
  send: (msg: IncomingMessage) => Promise<void>;
  /** agent 对某会话的真实回复：gateway.dispatchOutbound，source='agent' */
  reply: (sessionId: string, platform?: string) => Promise<void>;
  /** 调 delegate_to_session（fire-and-forget）；仅 withDelegate 时可用 */
  delegate: (target: string) => Promise<{ delegated?: boolean; error?: string }>;
  /** 流控服务（模拟平台禁言、读禁言状态） */
  flow: () => FlowControlService;
}

interface SetupOptions {
  /** 下发给 plugin-flow-control 的配置 */
  flow?: Record<string, unknown>;
  /** 下发给 plugin-trigger-policy 的配置 */
  trigger?: Record<string, unknown>;
  /** agent 收到这条消息时是否立即回复 */
  autoReply?: (msg: IncomingMessage) => boolean;
  /** 装配 tool-session（delegate_to_session）与 onebot 适配器 */
  withDelegate?: boolean;
  /** 提供 message-archive：收集影子归档的消息 */
  archived?: IncomingMessage[];
  /** 提供内存 data 根存储（禁言落盘）；同一个 Map 传给下一个 App 即模拟重启 */
  files?: Map<string, string>;
}

const DATA_ROOT: StorageRootInfo = {
  name: 'data',
  label: 'data',
  kind: 'data',
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
};

function memoryStorage(files: Map<string, string>): never {
  return {
    listRoots: () => [DATA_ROOT],
    async readFile(uri: string) {
      const data = files.get(uri);
      if (data === undefined) throw new Error(`不存在: ${uri}`);
      return data;
    },
    async writeFile(uri: string, data: string) {
      files.set(uri, String(data));
    },
  } as never;
}

const booted: App[] = [];

/** 刷掉微任务与 fire-and-forget 的入站处理（setImmediate 不在假时钟内） */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>(r => setImmediate(r));
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

async function setup(opts: SetupOptions = {}): Promise<Harness> {
  const app = new App({ name: 'T', logLevel: 'error' });
  booted.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, gateway, flowControl });

  const received: IncomingMessage[] = [];
  const reply = async (sessionId: string, platform = 'onebot'): Promise<void> => {
    await host.gateway.require().dispatchOutbound({ content: '好的', sessionId, platform, source: 'agent' });
  };
  host.provide(agent, {
    async handleMessage(msg: IncomingMessage) {
      received.push(msg);
      if (opts.autoReply?.(msg)) await reply(msg.sessionId, msg.platform);
    },
  } as never);

  if (opts.archived) {
    const archived = opts.archived;
    host.provide(messageArchive, {
      async archiveIncoming(m: IncomingMessage) {
        archived.push(m);
      },
    } as never);
  }
  if (opts.files) host.provide(storage, memoryStorage(opts.files));

  const handlers = new Map<string, ToolHandler>();
  if (opts.withDelegate) {
    host.provide(tools, {
      register(tool: Omit<RegisteredTool, 'pluginName'>) {
        const name = tool.definition.function.name;
        handlers.set(name, tool.handler as unknown as ToolHandler);
        return () => void handlers.delete(name);
      },
      registerGroup: () => () => {},
    } as never);
    // onebot 适配器的两个必需依赖：本测试不连 ws、不落盘，给占位即可
    if (!opts.files) host.provide(storage, { listRoots: () => [] } as never);
    host.provide(processService, {} as never);
  }

  const plugins: Array<{ name: string }> = [gatewayPlugin, flowControlPlugin, triggerPolicyPlugin];
  await app.plugins.register(gatewayPlugin, {});
  await app.plugins.register(flowControlPlugin, opts.flow ?? {});
  await app.plugins.register(triggerPolicyPlugin, opts.trigger ?? {});
  if (opts.withDelegate) {
    await app.plugins.register(onebotPlugin, { connections: [] });
    await app.plugins.register(sessionToolsPlugin, {});
    plugins.push(onebotPlugin, sessionToolsPlugin);
  }
  await app.plugins.idle();
  // 激活闸：required 依赖缺席时插件停在 pending 而不报错，不核状态会让整组用例伪装成绿
  for (const p of plugins) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  await app.start(); // app:ready → platform 档 idle 调度器启动

  return {
    app,
    received,
    contents: () => received.map(m => m.content),
    idles: () => received.filter(m => m.source === 'idle-trigger'),
    send: msg => host.gateway.require().ingressMessage(msg),
    reply,
    delegate: async target => {
      const handler = handlers.get('delegate_to_session');
      if (!handler) throw new Error('delegate_to_session 未注册');
      const raw = await handler(
        { target_session_id: target, task: '去群里发个公告', wait_for_result: false },
        { sessionId: 'webui:console', platform: 'webui', userId: 'owner-1' },
      );
      await flush(); // 委派入站是 fire-and-forget，等它走完相位链
      return JSON.parse(raw) as { delegated?: boolean; error?: string };
    },
    flow: () => host.flowControl.require(),
  };
}

beforeEach(() => {
  // setImmediate 留真，供 flush() 让出事件循环
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
  vi.useRealTimers();
});

// ────────────────────────────────────────────────────────────
// 缺陷 1：idle 退避被回复重置
// 旧代码：agent 回复 idle 提示 → recordReply 把 idleBackoff 复位为 1 → 下一次 idle 仍按 1 倍间隔。
// ────────────────────────────────────────────────────────────
describe('缺陷1 idle 退避不被 agent 回复重置', () => {
  it('session 档 exponential：回复 idle 后下一次按翻倍后的退避计算', async () => {
    const h = await setup({
      trigger: {
        idleTriggerScope: 'session',
        idleTriggerStyle: 'exponential',
        idleTriggerMinutes: 1,
        idleTriggerMaxMinutes: 60,
        idleTriggerJitter: false,
      },
      autoReply: () => true,
    });
    const G = '20001';

    // t=0：真人 @ → agent 回复 → 排下第一次 idle（退避 x1 = 60s）
    await h.send(groupMsg(G, `${AT}在吗`));
    expect(h.received).toHaveLength(1);

    await advance(60_500); // t≈60.5s：第一次 idle 到点，agent 回复它
    expect(h.idles(), '第一次 idle 应在 60s 到点').toHaveLength(1);

    // 注入时退避已翻倍到 x2：下一次应在第一次之后 120s（t=180s），而不是 60s（t=120s）
    await advance(89_500); // t=150s
    expect(h.idles(), 'agent 回复 idle 不应把退避复位为 1（t=150s 时不该有第二次 idle）').toHaveLength(1);

    await advance(35_000); // t=185s
    expect(h.idles(), '退避 x2 到点后第二次 idle 应照常到来').toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────
// 缺陷 2：platform 档反复选同一会话
// 旧代码：pickTarget 按 max(lastMessageTime, lastReplyTime) 选最久未活动者；agent 对 idle 提示
// 沉默时两者都不刷新，下一轮仍选 A。
// ────────────────────────────────────────────────────────────
describe('缺陷2 platform 档不反复选同一会话', () => {
  it('第一轮注入到最久未活动的 A、agent 沉默，第二轮应选 B', async () => {
    const h = await setup({
      trigger: { idleTriggerScope: 'platform', idleTriggerStrategy: 'fixed', idleTriggerMinutes: 1 },
    });
    const A = '20001';
    const B = '20002';

    // 两个会话各有一条真人消息（低于触发阈值被吞，agent 不回复），A 更早
    await h.send(groupMsg(A, '随便聊聊'));
    await advance(10_000);
    await h.send(groupMsg(B, '随便聊聊'));
    expect(h.received, '真人消息低于阈值，不应抵达 agent').toHaveLength(0);

    await advance(51_000); // t≈61s：第一轮 tick
    expect(h.idles().map(m => m.sessionId)).toEqual([sid(A)]);

    await advance(60_000); // t≈121s：第二轮 tick（agent 对第一轮沉默，无任何出站）
    expect(
      h.idles().map(m => m.sessionId),
      '刚被注入过的 A 应视为有活动，第二轮应选 B',
    ).toEqual([sid(A), sid(B)]);
  });
});

// ────────────────────────────────────────────────────────────
// 缺陷 3：禁言期间 idle 仍开口
// 旧代码：idle 注入消息无 sessionType，flow 相位按作用域外直接放行，禁言检查够不到它。
// ────────────────────────────────────────────────────────────
describe('缺陷3 禁言期间 idle 不开口', () => {
  it('session 档，muteTimeSeconds > idle 延迟，禁言期内无 idle 抵达 agent', async () => {
    const h = await setup({
      trigger: {
        idleTriggerScope: 'session',
        idleTriggerStyle: 'fixed',
        idleTriggerMinutes: 1,
        idleTriggerJitter: false,
        muteKeywords: '闭嘴',
        muteTimeSeconds: 600,
      },
    });
    const G = '20001';

    await h.send(groupMsg(G, '随便聊聊')); // 真人活动（低于阈值被吞）
    await advance(1_000);
    await h.send(groupMsg(G, '你闭嘴吧')); // 禁言 600s
    expect(h.received).toHaveLength(0);

    await advance(5 * 60_000); // 禁言期内走过 5 个 idle 周期
    expect(h.idles(), '禁言期内不应有 idle 注入抵达 agent').toHaveLength(0);

    // 非空转校验：禁言结束后 idle 应恢复（证明上面的「没有」不是因为 idle 根本没排上）
    await advance(8 * 60_000);
    expect(h.idles().length, '禁言结束后 idle 应恢复').toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────
// 缺陷 4：委派双计 + 预设冷却
// 旧代码：onebot.checkAndRecordProactiveSend 在放行时就调 recordReply（计 1 次限速 + 设冷却），
// 目标会话真实回复时 outbound 再 recordReply 一次 → 同一次委派计 2 次；且回复落地前的冷却
// 把目标群的真人消息吞掉。
// ────────────────────────────────────────────────────────────
describe('缺陷4 委派不双计、不预设冷却', () => {
  it('放行一次委派 + 目标真实回复一次，限速窗口内只计 1 次', async () => {
    const h = await setup({
      flow: { rateLimitWindow: 60, rateLimitMaxReplies: 2 },
      withDelegate: true,
    });
    const target = sid('20001');

    const first = await h.delegate(target);
    expect(first.delegated, `第一次委派应放行：${first.error ?? ''}`).toBe(true);
    expect(
      h.received.map(m => m.sessionId),
      '委派消息应抵达目标会话 agent',
    ).toEqual([target]);

    await h.reply(target); // 目标会话对委派的真实回复

    // 只计 1 次（上限 2）→ 窗口内第二次委派仍应放行；双计则已顶到上限
    const second = await h.delegate(target);
    expect(second.error, '一次委派 + 一次回复应只占 1 个限速槽').toBeUndefined();
    expect(second.delegated).toBe(true);
  });

  it('放行委派后、目标回复前，目标群真人消息不被冷却吞掉', async () => {
    const h = await setup({
      flow: { rateLimitWindow: 60, rateLimitMaxReplies: 2 },
      trigger: { intervalMode: 'fixed', fixedInterval: 1 },
      withDelegate: true,
    });
    const G = '20001';

    const res = await h.delegate(sid(G));
    expect(res.delegated, `委派应放行：${res.error ?? ''}`).toBe(true);
    expect(h.received).toHaveLength(1); // 委派消息，agent 尚未回复

    // fixedInterval=1：这条真人消息本身满足 interval 触发
    await h.send(groupMsg(G, '随便聊聊'));
    expect(h.contents(), '委派放行不应给目标会话预设冷却').toContain('随便聊聊');
  });
});

// ────────────────────────────────────────────────────────────
// 相位对调（trigger 先于 flow）
// ────────────────────────────────────────────────────────────
describe('相位：immediate 穿透冷却、禁言关键词不被冷却吞、禁言期不计数', () => {
  it('冷却期内 @bot 的消息到达 dispatch', async () => {
    const h = await setup({ flow: { cooldownSeconds: 10 }, autoReply: () => true });
    const G = '20001';

    await h.send(groupMsg(G, `${AT}在吗`)); // agent 回复 → 进入 10s 冷却
    await advance(2_000);
    await h.send(groupMsg(G, `${AT}还在吗`));
    expect(h.contents(), '冷却期内被 @ 应穿透冷却抵达 agent').toContain(`${AT}还在吗`);
  });

  it('冷却期内的禁言关键词使 bot 进入禁言', async () => {
    const h = await setup({
      flow: { cooldownSeconds: 10 },
      trigger: { muteKeywords: '闭嘴', muteTimeSeconds: 600 },
      autoReply: () => true,
    });
    const G = '20001';

    await h.send(groupMsg(G, `${AT}在吗`)); // agent 回复 → 进入 10s 冷却
    await advance(2_000);
    await h.send(groupMsg(G, '你闭嘴吧')); // 冷却期内的禁言关键词

    await advance(15_000); // 冷却已过，仍在 600s 禁言期内
    await h.send(groupMsg(G, `${AT}说句话`));
    expect(h.contents(), '禁言关键词应在冷却期内照样生效：禁言期内被 @ 也不说话').not.toContain(`${AT}说句话`);
  });

  it('禁言期间的消息不累计计数（解禁后第一条普通消息不立即 interval 触发）', async () => {
    const h = await setup({
      trigger: { intervalMode: 'fixed', fixedInterval: 3, muteKeywords: '闭嘴', muteTimeSeconds: 60 },
    });
    const G = '20001';

    await h.send(groupMsg(G, '你闭嘴吧')); // 禁言 60s
    // 只发阈值减一条：若禁言期计数，解禁后第一条恰好凑满阈值
    for (let i = 0; i < 2; i++) {
      await advance(1_000);
      await h.send(groupMsg(G, `禁言期闲聊 ${i}`));
    }
    await advance(60_000); // 解禁

    await h.send(groupMsg(G, '解禁后第一条'));
    expect(h.contents(), '禁言期的 2 条不应计入间隔计数（解禁后计数应从 1 起）').not.toContain('解禁后第一条');

    // 正向对照：继续发到阈值应触发
    await h.send(groupMsg(G, '解禁后第二条'));
    await h.send(groupMsg(G, '解禁后第三条'));
    expect(h.contents()).toEqual(['解禁后第三条']);
  });
});

// ────────────────────────────────────────────────────────────
// 禁言
// ────────────────────────────────────────────────────────────
describe('禁言', () => {
  it('作用域错位：flow-control 作用域不含该群，关键词写入的禁言照样吞掉后续 @', async () => {
    const h = await setup({
      flow: { scopes: [] }, // 冷却与限速对任何会话都不生效
      trigger: { muteKeywords: '闭嘴', muteTimeSeconds: 600 },
    });
    const G = '20001';

    await h.send(groupMsg(G, '你闭嘴吧'));
    expect(h.flow().isMuted(sid(G)), '关键词应写入禁言').toBe(true);

    await advance(5_000);
    await h.send(groupMsg(G, `${AT}说句话`));
    expect(h.contents(), '禁言不看 flow-control 的作用域').not.toContain(`${AT}说句话`);

    // 非空转：禁言结束后同一条 @ 能抵达
    await advance(600_000);
    await h.send(groupMsg(G, `${AT}说句话`));
    expect(h.contents()).toContain(`${AT}说句话`);
  });

  it('平台禁言期间的禁言关键词不缩短禁言', async () => {
    const h = await setup({ trigger: { muteKeywords: '闭嘴', muteTimeSeconds: 60 } });
    const G = '20001';

    h.flow().setMuted(sid(G), 3600, 'onebot'); // 平台禁言 1 小时（适配器收到 group_ban 时同样调用）
    await h.send(groupMsg(G, '你闭嘴吧')); // 若被当作关键词处理，禁言会被改写为 60s

    await advance(120_000);
    expect(h.flow().isMuted(sid(G)), '平台禁言应仍在生效').toBe(true);
    await h.send(groupMsg(G, `${AT}说句话`));
    expect(h.contents()).not.toContain(`${AT}说句话`);
  });

  it('禁言前攒下的计数在禁言期清零（平台禁言同样适用）', async () => {
    const h = await setup({ trigger: { intervalMode: 'fixed', fixedInterval: 3 } });
    const G = '20001';

    await h.send(groupMsg(G, '禁言前 1'));
    await h.send(groupMsg(G, '禁言前 2')); // 计数 2/3
    h.flow().setMuted(sid(G), 60, 'onebot');
    await h.send(groupMsg(G, '禁言期闲聊'));
    await advance(61_000); // 解禁

    await h.send(groupMsg(G, '解禁后第一条'));
    expect(h.contents(), '禁言前的 2 条不应与解禁后的消息凑满阈值').not.toContain('解禁后第一条');
  });

  it('戳一戳者昵称含禁言关键词：不触发禁言，戳一戳照常直触发', async () => {
    const h = await setup({ trigger: { muteKeywords: '闭嘴', muteTimeSeconds: 600 } });
    const G = '20001';

    await h.send(pokeMsg(G, '闭嘴怪'));
    expect(h.flow().isMuted(sid(G)), '合成文案里的昵称不当发言评估').toBe(false);
    expect(
      h.received.map(m => m.noticeType),
      '戳一戳应直触发抵达 agent',
    ).toEqual(['poke']);

    // 对照：同样的词出现在真人发言里应禁言
    await h.send(groupMsg(G, '你闭嘴吧'));
    expect(h.flow().isMuted(sid(G))).toBe(true);
  });

  it('关键词禁言当场清零计数：禁言期一条消息都没有，解禁后第一条也不因禁言前的计数触发', async () => {
    const h = await setup({
      trigger: { intervalMode: 'fixed', fixedInterval: 3, muteKeywords: '闭嘴', muteTimeSeconds: 60 },
    });
    const G = '20001';

    await h.send(groupMsg(G, '禁言前 1'));
    await h.send(groupMsg(G, '禁言前 2')); // 计数 2/3
    await h.send(groupMsg(G, '你闭嘴吧')); // 禁言 60s，禁言期内不再有消息
    await advance(61_000); // 解禁

    await h.send(groupMsg(G, '解禁后第一条'));
    expect(h.contents(), '禁言前的 2 条不应与解禁后的消息凑满阈值').not.toContain('解禁后第一条');

    // 正向对照：计数从 1 起，再发两条凑满阈值
    await h.send(groupMsg(G, '解禁后第二条'));
    await h.send(groupMsg(G, '解禁后第三条'));
    expect(h.contents()).toEqual(['解禁后第三条']);
  });

  it('作用域外的禁言关键词不写入禁言（默认 *:group，私聊不在作用域）', async () => {
    const h = await setup({ trigger: { muteKeywords: '闭嘴', muteTimeSeconds: 600 } });

    await h.send(privateMsg('30009', '你闭嘴吧'));
    expect(h.flow().isMuted(privateSid('30009'))).toBe(false);

    // 对照：同一个词在作用域内的群聊里生效
    await h.send(groupMsg('20001', '你闭嘴吧'));
    expect(h.flow().isMuted(sid('20001'))).toBe(true);
  });

  it('禁言压过 immediate：预置 triggerType=immediate 的消息在禁言期同样被吞', async () => {
    const h = await setup();
    const U = '30009';

    h.flow().setMuted(privateSid(U), 600, 'onebot');
    await h.send({ ...privateMsg(U, '禁言期的直触发'), triggerType: 'immediate' });
    expect(h.contents()).not.toContain('禁言期的直触发');

    // 对照：解禁后同样的消息放行
    await advance(601_000);
    await h.send({ ...privateMsg(U, '解禁后的直触发'), triggerType: 'immediate' });
    expect(h.contents()).toContain('解禁后的直触发');
  });

  it('setMuted(0) 解除禁言后 @ 可达（平台解禁同步）', async () => {
    const h = await setup();
    const G = '20001';

    h.flow().setMuted(sid(G), 3600, 'onebot');
    await h.send(groupMsg(G, `${AT}禁言中`));
    expect(h.contents()).not.toContain(`${AT}禁言中`);

    h.flow().setMuted(sid(G), 0, 'onebot');
    await h.send(groupMsg(G, `${AT}解禁了吗`));
    expect(h.contents()).toContain(`${AT}解禁了吗`);
  });

  it('禁言状态落盘，重启后恢复', async () => {
    const files = new Map<string, string>();
    const G = '20001';
    const first = await setup({ files });
    first.flow().setMuted(sid(G), 3600, 'onebot');
    await flush(); // 落盘走异步串行链
    await first.app.stop();

    const second = await setup({ files });
    expect(second.flow().isMuted(sid(G)), '重启后应恢复未过期的禁言').toBe(true);
    await second.send(groupMsg(G, `${AT}重启后说句话`));
    expect(second.contents()).not.toContain(`${AT}重启后说句话`);
  });
});

// ────────────────────────────────────────────────────────────
// 冷却与限速按真实回复计
// ────────────────────────────────────────────────────────────
describe('冷却与限速', () => {
  it('*:private 覆盖的 cooldownSeconds 经 outbound 记冷却时生效', async () => {
    const h = await setup({
      flow: { cooldownSeconds: 0, overrides: [{ scope: '*:private', cooldownSeconds: 30 }] },
      autoReply: () => true,
    });
    const U = '30009';

    await h.send(privateMsg(U, '第一句')); // agent 回复 → 按私聊覆盖记 30s 冷却
    await advance(5_000);
    await h.send(privateMsg(U, '冷却中的第二句'));
    expect(h.contents(), '私聊覆盖的 30s 冷却应生效（顶层为 0）').not.toContain('冷却中的第二句');

    await advance(30_000);
    await h.send(privateMsg(U, '冷却过后的第三句'));
    expect(h.contents()).toContain('冷却过后的第三句');
  });

  it('作用域为 * 时，委派到无入站记录的私聊：真实回复计入限速，第 N+1 次委派被拒', async () => {
    const N = 2;
    const h = await setup({
      flow: { scopes: ['*'], rateLimitWindow: 60, rateLimitMaxReplies: N },
      autoReply: () => true, // 目标会话收到委派即回复
      withDelegate: true,
    });
    const target = privateSid('30009');

    for (let i = 0; i < N; i++) {
      const res = await h.delegate(target);
      expect(res.delegated, `第 ${i + 1} 次委派应放行：${res.error ?? ''}`).toBe(true);
    }
    const over = await h.delegate(target);
    expect(over.delegated).toBeUndefined();
    expect(over.error).toContain('限速');
    expect(
      h.received.filter(m => m.sessionId === target),
      '被拒的委派不派发',
    ).toHaveLength(N);
  });

  it('回复记账只对作用域内会话：委派到 WebUI 会话（默认作用域不含）不记冷却与限速，不被限速拒绝', async () => {
    // 旧行为：outbound 对任意会话记账，委派到 WebUI 等不受控会话的回复也占限速槽，第 N+1 次委派被拒
    const N = 2;
    const h = await setup({
      flow: { cooldownSeconds: 30, rateLimitWindow: 60, rateLimitMaxReplies: N },
      autoReply: () => true,
      withDelegate: true,
    });
    const target = 'webui-default';

    for (let i = 0; i <= N; i++) {
      const res = await h.delegate(target);
      expect(res.delegated, `第 ${i + 1} 次委派应放行：${res.error ?? ''}`).toBe(true);
    }
    expect(h.received.filter(m => m.sessionId === target)).toHaveLength(N + 1);
    expect(h.flow().isRateLimited(target)).toBe(false);
    expect(h.flow().isCoolingDown(target)).toBe(false);
  });

  it('回复记账：作用域为 * 时，没有流控状态、类型未知的 WebUI 会话照常计', async () => {
    const h = await setup({ flow: { scopes: ['*'], cooldownSeconds: 30 } });
    await h.reply('webui-default', 'webui'); // 无任何入站经过 flow 相位
    expect(h.flow().isCoolingDown('webui-default')).toBe(true);
  });

  it('回复记账：没有真人消息经过 flow 的群按会话 ID 推断为群，委派回复计入冷却与限速', async () => {
    // 旧行为：没有流控状态即类型未知，默认 *:group 下不记账，委派到这类群不受限速
    const N = 2;
    for (const swallowedFirst of [false, true]) {
      const h = await setup({
        flow: { cooldownSeconds: 30, rateLimitWindow: 60, rateLimitMaxReplies: N },
        autoReply: () => true,
        withDelegate: true,
      });
      const target = sid('20001');
      const label = swallowedFirst ? '真人消息被 trigger 吞掉的群' : '安静群';
      // 默认 fixedInterval=5：未点名的一条被 trigger 吞掉，到不了 flow 相位
      if (swallowedFirst) await h.send(groupMsg('20001', '没到阈值'));

      for (let i = 0; i < N; i++) {
        const res = await h.delegate(target);
        expect(res.delegated, `${label}：第 ${i + 1} 次委派应放行：${res.error ?? ''}`).toBe(true);
      }
      expect(h.flow().isCoolingDown(target), label).toBe(true);
      const over = await h.delegate(target);
      expect(over.error, label).toContain('限速');
      expect(
        h.received.filter(m => m.sessionId === target),
        label,
      ).toHaveLength(N);
    }
  });

  it('回复记账：只有禁言记录、缺会话类型的群，回复时补全类型与目标并计入，按群号写的覆盖随之生效', async () => {
    // 旧行为：平台禁言建出的状态只有平台，默认 *:group 下回复不计
    const G = '20001';
    const h = await setup({
      flow: {
        cooldownSeconds: 0,
        rateLimitWindow: 60,
        rateLimitMaxReplies: 1,
        overrides: [{ scope: `onebot:group:${G}`, cooldownSeconds: 30 }],
      },
    });
    h.flow().setMuted(sid(G), 1, 'onebot'); // 适配器同步平台禁言：只知道 sessionId 与平台
    await advance(2_000); // 解禁

    await h.reply(sid(G));
    expect(h.flow().isRateLimited(sid(G)), '回复计入限速').toBe(true);
    expect(h.flow().isCoolingDown(sid(G)), '按群号写的 30s 冷却生效（顶层为 0）').toBe(true);
  });

  it('回复记账：不符合会话 ID 约定的会话不推断，默认作用域下不计', async () => {
    const h = await setup({ flow: { cooldownSeconds: 30 } });
    for (const [sessionId, platform] of [
      ['webui-default', 'webui'],
      [sid('20001'), 'internal'], // 前缀与平台不符（如委派解析不到目标平台时的回落）
    ]) {
      await h.reply(sessionId, platform);
      expect(h.flow().isCoolingDown(sessionId), `${platform} / ${sessionId}`).toBe(false);
    }
  });

  it('回复记账：子任务会话（`<父会话 id>::<uuid>`）不按父会话的类型推断，默认作用域下不计', async () => {
    const h = await setup({ flow: { cooldownSeconds: 30 } });
    const sub = `${sid('20001')}::abcd1234`;
    await h.reply(sub);
    expect(h.flow().isCoolingDown(sub)).toBe(false);
  });

  it('回复记账：没有流控状态的会话按出站消息的平台判作用域，onebot:* 计入、webui 对照不计', async () => {
    const target = privateSid('30009');
    for (const [scopes, counted] of [
      [['onebot:*'], true],
      [['webui'], false],
    ] as const) {
      const h = await setup({ flow: { scopes, cooldownSeconds: 30 } });
      await h.reply(target, 'onebot');
      expect(h.flow().isCoolingDown(target), scopes.join()).toBe(counted);
    }
  });

  it('回复记账：scopes 为空、只靠按群号写的覆盖启用的群，回复进入冷却', async () => {
    const G = '20001';
    const h = await setup({
      flow: { scopes: [], cooldownSeconds: 0, overrides: [{ scope: `onebot:group:${G}`, cooldownSeconds: 30 }] },
      autoReply: () => true,
    });
    await h.send(groupMsg(G, `${AT}在吗`));
    expect(h.contents()).toEqual([`${AT}在吗`]);
    expect(h.flow().isCoolingDown(sid(G))).toBe(true);
  });

  it('回复记账：scopes 为空、只靠按群号写的覆盖启用的安静群，按推断出的目标判作用域', async () => {
    const G = '20001';
    const h = await setup({
      flow: { scopes: [], cooldownSeconds: 0, overrides: [{ scope: `onebot:group:${G}`, cooldownSeconds: 30 }] },
    });
    await h.reply(sid(G)); // 没有任何入站经过 flow 相位
    expect(h.flow().isCoolingDown(sid(G))).toBe(true);
  });

  it('回复记账：推断先用状态里记下的平台，再回落出站平台（只有禁言记录的群，回复的平台为 internal）', async () => {
    const h = await setup({ flow: { cooldownSeconds: 30 } });
    h.flow().setMuted(sid('20001'), 1, 'onebot'); // 状态只有平台
    await advance(2_000);
    await h.reply(sid('20001'), 'internal');
    expect(h.flow().isCoolingDown(sid('20001'))).toBe(true);
  });

  it('回复记账：作用域内的群照常计入冷却与限速，委派超限被拒', async () => {
    const h = await setup({
      flow: { cooldownSeconds: 30, rateLimitWindow: 60, rateLimitMaxReplies: 1 },
      autoReply: () => true,
      withDelegate: true,
    });
    const G = '20001';

    await h.send(groupMsg(G, `${AT}在吗`)); // 真人消息经过 flow 相位，会话类型已知（group）→ agent 回复计 1 次
    expect(h.flow().isCoolingDown(sid(G))).toBe(true);
    expect(h.flow().isRateLimited(sid(G))).toBe(true);
    const res = await h.delegate(sid(G));
    expect(res.delegated).toBeUndefined();
    expect(res.error).toContain('限速');
  });

  it('禁言中的会话拒绝委派', async () => {
    const h = await setup({ withDelegate: true });
    const target = sid('20001');

    h.flow().setMuted(target, 600, 'onebot');
    const res = await h.delegate(target);
    expect(res.delegated).toBeUndefined();
    expect(res.error).toContain('禁言');
    expect(h.received, '被拒的委派不派发').toHaveLength(0);
  });

  it('入站限速：非 immediate 被吞，immediate 穿透限速', async () => {
    const h = await setup({
      flow: { cooldownSeconds: 0, rateLimitWindow: 60, rateLimitMaxReplies: 1 },
      trigger: { intervalMode: 'fixed', fixedInterval: 1 },
      autoReply: () => true,
    });
    const G = '20001';

    await h.send(groupMsg(G, '第一条')); // agent 回复，占满限速窗口
    expect(h.contents()).toContain('第一条');
    await advance(1_000);
    await h.send(groupMsg(G, '限速中的普通消息'));
    expect(h.contents(), '限速窗口内 interval 应被吞').not.toContain('限速中的普通消息');
    await h.send(groupMsg(G, `${AT}限速中被点名`));
    expect(h.contents(), 'immediate 应穿透限速').toContain(`${AT}限速中被点名`);
  });

  it('非 agent 出站（命令回复）不设冷却', async () => {
    const h = await setup({ trigger: { intervalMode: 'fixed', fixedInterval: 1 } });
    const G = '20001';
    const gw = h.app.bind({ gateway }).gateway.require();

    await gw.dispatchOutbound({ content: '命令结果', sessionId: sid(G), platform: 'onebot', source: 'command' });
    await h.send(groupMsg(G, '命令后的普通消息'));
    expect(h.contents()).toContain('命令后的普通消息');

    // 对照：agent 回复后同样的消息被冷却吞掉
    await h.reply(sid(G));
    await h.send(groupMsg(G, '回复后的普通消息'));
    expect(h.contents()).not.toContain('回复后的普通消息');
  });

  it('平台禁言建出的流控状态在首条入站后补全会话类型，按类型写的覆盖随之生效', async () => {
    const h = await setup({
      flow: { cooldownSeconds: 0, overrides: [{ scope: '*:group', cooldownSeconds: 30 }] },
      trigger: { intervalMode: 'fixed', fixedInterval: 1 },
      autoReply: () => true,
    });
    const G = '20001';

    h.flow().setMuted(sid(G), 1, 'onebot'); // 适配器同步平台禁言：只知道 sessionId 与平台
    await advance(2_000); // 解禁

    await h.send(groupMsg(G, '解禁后第一条')); // agent 回复 → 按 *:group 覆盖记 30s 冷却
    await advance(5_000);
    await h.send(groupMsg(G, '冷却中的第二条'));
    expect(h.contents(), '*:group 覆盖的 30s 冷却应生效（顶层为 0）').toEqual(['解禁后第一条']);
  });
});

// ────────────────────────────────────────────────────────────
// 内部注入：带 source 的消息（闲置触发、定时任务、workflow、跨会话委派）不经触发策略，
// flow 相位对它不查回复后冷却，禁言与限速照常。这些消息不带会话类型，flow 判作用域时与回复记账同一口径：
// 先用会话记下的平台与类型，没有再按会话 ID 约定推断。真人消息由适配器投递，不设 source。
// ────────────────────────────────────────────────────────────
describe('内部注入（带 source）', () => {
  /** 与 plugin-scheduler / plugin-workflow / plugin-tool-session 投递的消息同形：无 sessionType */
  const scheduled = (sessionId: string, content: string): IncomingMessage => ({
    content,
    sessionId,
    platform: 'onebot',
    source: 'scheduler',
  });
  const workflow = (sessionId: string, content: string): IncomingMessage => ({
    content,
    sessionId,
    platform: 'onebot',
    source: 'workflow:wf-1',
  });
  const proactive = (sessionId: string, content: string): IncomingMessage => ({
    content,
    sessionId,
    platform: 'onebot',
    source: 'proactive:from:webui:console',
    triggerType: 'proactive',
  });

  it('trigger 作用域为 * 时，定时任务、workflow、委派消息不计数、不被吞，委派的 triggerType 保持 proactive', async () => {
    const h = await setup({ trigger: { scopes: ['*'], intervalMode: 'fixed', fixedInterval: 5 } });
    const G = '20001';

    await h.send(scheduled(sid(G), '定时提醒'));
    await h.send(workflow(sid(G), '工作流通知'));
    await h.send(proactive(sid(G), '委派任务'));
    expect(h.contents(), '内部注入不应被计数判定吞掉').toEqual(['定时提醒', '工作流通知', '委派任务']);
    expect(h.received.find(m => m.content === '委派任务')?.triggerType).toBe('proactive');

    // 不计数：真人消息的计数从 1 起，第 5 条才触发（若三条注入被计数，第 2 条就凑满阈值）
    for (let i = 1; i <= 4; i++) await h.send(groupMsg(G, `真人 ${i}`));
    expect(h.contents().filter(c => c.startsWith('真人'))).toEqual([]);
    await h.send(groupMsg(G, '真人 5'));
    expect(h.contents().filter(c => c.startsWith('真人'))).toEqual(['真人 5']);
  });

  it('trigger 作用域为 * 时，闲置注入同样跳过策略', async () => {
    const h = await setup({
      trigger: {
        scopes: ['*'],
        intervalMode: 'fixed',
        fixedInterval: 5,
        idleTriggerScope: 'session',
        idleTriggerStyle: 'fixed',
        idleTriggerMinutes: 1,
        idleTriggerJitter: false,
      },
    });

    await h.send(groupMsg('20001', '随便聊聊'));
    await advance(61_000);
    expect(h.idles()).toHaveLength(1);
  });

  it('flow：带 source 的消息不受冷却挡，但受禁言挡（默认作用域下按会话 ID 推断为群）', async () => {
    const h = await setup({ flow: { cooldownSeconds: 60 }, autoReply: () => true });
    const G = '20001';

    await h.send(groupMsg(G, `${AT}在吗`)); // agent 回复 → 60s 冷却
    await advance(1_000);
    await h.send(scheduled(sid(G), '冷却中的定时提醒'));
    await h.send(workflow(sid(G), '冷却中的工作流通知'));
    expect(h.contents(), '冷却不应吞掉内部注入').toEqual([`${AT}在吗`, '冷却中的定时提醒', '冷却中的工作流通知']);

    h.flow().setMuted(sid(G), 600, 'onebot');
    await h.send(scheduled(sid(G), '禁言中的定时提醒'));
    expect(h.contents(), '禁言期内部注入同样不说话').not.toContain('禁言中的定时提醒');
  });

  it('定时任务发往安静群（默认作用域，按会话 ID 推断为群）：不受冷却挡；限速窗口已满时被吞并影子归档，窗口过后放行', async () => {
    // 旧行为：入站只看消息自带的 sessionType，内部注入不带，默认 *:group 下算作用域外、不过限速闸
    const archived: IncomingMessage[] = [];
    const h = await setup({
      flow: { cooldownSeconds: 60, rateLimitWindow: 60, rateLimitMaxReplies: 2 },
      autoReply: () => true,
      archived,
    });
    const G = '20001';

    await h.send(scheduled(sid(G), '提醒 1')); // 放行并回复 → 60s 冷却，占 1 个名额
    await advance(1_000);
    await h.send(scheduled(sid(G), '冷却中的提醒 2')); // 不受冷却挡；回复后占满 2 个名额
    expect(h.contents()).toEqual(['提醒 1', '冷却中的提醒 2']);

    await h.send(scheduled(sid(G), '限速中的提醒 3'));
    await h.send(workflow(sid(G), '限速中的工作流通知'));
    expect(h.contents(), '限速窗口已满时内部注入被吞').toEqual(['提醒 1', '冷却中的提醒 2']);
    expect(
      archived.map(m => m.content),
      '被吞的做影子归档',
    ).toEqual(['限速中的提醒 3', '限速中的工作流通知']);

    await advance(60_000);
    await h.send(scheduled(sid(G), '窗口过后的提醒 4'));
    expect(h.contents()).toContain('窗口过后的提醒 4');
  });

  it('发往私聊与 WebUI 的定时任务不受影响：推断为私聊或类型未知，默认作用域外照常放行', async () => {
    const h = await setup({
      flow: { cooldownSeconds: 60, rateLimitWindow: 60, rateLimitMaxReplies: 1 },
      autoReply: () => true,
    });
    const webui = (content: string): IncomingMessage => ({
      content,
      sessionId: 'webui-default',
      platform: 'webui',
      source: 'scheduler',
    });

    for (const i of [1, 2]) {
      await h.send(scheduled(privateSid('30001'), `私聊提醒 ${i}`));
      await h.send(webui(`WebUI 提醒 ${i}`));
    }
    expect(h.contents()).toEqual(['私聊提醒 1', 'WebUI 提醒 1', '私聊提醒 2', 'WebUI 提醒 2']);
  });

  it('平台为 internal、会话 ID 前缀为 onebot 的定时任务发往安静群：不推断，维持作用域外', async () => {
    // WebUI 与配置文件里建的定时任务平台默认是 internal；回复沿用这个平台，同样不推断、不计
    const h = await setup({
      flow: { cooldownSeconds: 60, rateLimitWindow: 60, rateLimitMaxReplies: 1 },
      autoReply: () => true,
    });
    const internal = (content: string): IncomingMessage => ({
      ...scheduled(sid('20001'), content),
      platform: 'internal',
    });

    await h.send(internal('提醒 1'));
    await h.send(internal('提醒 2'));
    expect(h.contents()).toEqual(['提醒 1', '提醒 2']);
    expect(h.flow().isRateLimited(sid('20001'))).toBe(false);
  });

  it('会话已记下平台与类型时，平台为 internal 的定时任务按记下的判作用域，回复同样计入', async () => {
    const h = await setup({
      flow: { cooldownSeconds: 0, rateLimitWindow: 60, rateLimitMaxReplies: 2 },
      autoReply: () => true,
    });
    const G = '20001';
    const internal = (content: string): IncomingMessage => ({ ...scheduled(sid(G), content), platform: 'internal' });

    await h.send(groupMsg(G, `${AT}在吗`)); // 真人消息记下 onebot / group；回复占 1 个名额
    await h.send(internal('提醒 1')); // 放行；回复的平台是 internal，按记下的计入，占满 2 个名额
    await h.send(internal('限速中的提醒 2'));
    expect(h.contents()).toEqual([`${AT}在吗`, '提醒 1']);
  });

  it('flow 相位：禁言期闲置注入也被吞，解禁后放行', async () => {
    const h = await setup();
    const G = '20001';
    const idle = (): IncomingMessage => ({
      content: 'idle',
      sessionId: sid(G),
      platform: 'onebot',
      source: 'idle-trigger',
      triggerType: 'idle',
    });

    h.flow().setMuted(sid(G), 600, 'onebot');
    await h.send(idle());
    expect(h.idles()).toHaveLength(0);

    await advance(601_000);
    await h.send(idle());
    expect(h.idles()).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────
// 计数与判定
// ────────────────────────────────────────────────────────────
describe('计数与判定', () => {
  it('判定放行即复位计数', async () => {
    const h = await setup({ trigger: { intervalMode: 'fixed', fixedInterval: 3 } });
    const G = '20001';

    for (let i = 1; i <= 3; i++) await h.send(groupMsg(G, `m${i}`));
    expect(h.contents()).toEqual(['m3']);
    await h.send(groupMsg(G, 'm4'));
    expect(h.contents(), '触发后计数应从 0 起').toEqual(['m3']);
  });

  it('dynamic：放行后动态阈值回到上限', async () => {
    const h = await setup({ trigger: { intervalMode: 'dynamic' } });
    const G = '20001';

    await h.send(groupMsg(G, 'd1'));
    await h.send(groupMsg(G, 'd2')); // 0.21 + 0.22 ≥ 下限 0.3 → 放行
    expect(h.contents()).toEqual(['d2']);
    await h.send(groupMsg(G, 'd3'));
    await h.send(groupMsg(G, 'd4')); // 约 0.47，低于刚放行后的阈值（接近上限 0.85）
    expect(h.contents(), '刚放行后阈值应接近上限').toEqual(['d2']);
  });

  it('同一用户连续发言的活跃指数增量逐条抬高', async () => {
    // 增量 = 0.2 × (1 + 0.05 × 该用户累计条数)：同一人两条 0.21 + 0.22 = 0.43，两个人各一条 0.21 + 0.21 = 0.42
    const h = await setup({ trigger: { intervalMode: 'dynamic', activityScoreLower: 0.425 } });

    await h.send(groupMsg('20001', 'A1', '30001'));
    await h.send(groupMsg('20001', 'A2', '30001'));
    expect(h.contents(), '同一用户第二条应跨过阈值').toEqual(['A2']);

    await h.send(groupMsg('20002', 'B1', '30002'));
    await h.send(groupMsg('20002', 'C1', '30003'));
    expect(h.contents(), '两个人各一条不应跨过阈值').toEqual(['A2']);
  });

  it('30 天无活动的会话状态被清扫，旧计数不跨月残留', async () => {
    const h = await setup({ trigger: { intervalMode: 'fixed', fixedInterval: 3 } });
    const G = '20001';

    await h.send(groupMsg(G, 'a1'));
    await h.send(groupMsg(G, 'a2'));
    await advance(32 * 24 * 60 * 60 * 1000);
    await h.send(groupMsg(G, 'a3'));
    expect(h.contents(), '31 天前的计数应随状态淘汰').not.toContain('a3');
  });
});

// ────────────────────────────────────────────────────────────
// 闲置触发（session / platform 档）
// ────────────────────────────────────────────────────────────
describe('闲置触发', () => {
  const sessionIdle = (style: 'fixed' | 'exponential', extra: Record<string, unknown> = {}) => ({
    idleTriggerScope: 'session',
    idleTriggerStyle: style,
    idleTriggerMinutes: 1,
    idleTriggerMaxMinutes: 60,
    idleTriggerJitter: false,
    ...extra,
  });

  it('禁言期到点跳过、不翻倍退避：解禁后按基础间隔恢复', async () => {
    const h = await setup({ trigger: sessionIdle('exponential') });
    const G = '20001';

    await h.send(groupMsg(G, '随便聊聊'));
    h.flow().setMuted(sid(G), 600, 'onebot');
    await advance(601_000); // 解禁
    await advance(61_000);
    expect(h.idles().length, '解禁后一个基础间隔内应有 idle').toBeGreaterThan(0);
  });

  it('真人消息把退避复位为 1', async () => {
    const h = await setup({ trigger: sessionIdle('exponential') });
    const G = '20001';

    await h.send(groupMsg(G, '随便聊聊')); // t=0
    await advance(60_500); // 第一次 idle，退避 x2
    expect(h.idles()).toHaveLength(1);
    await advance(40_000); // t≈100.5s
    await h.send(groupMsg(G, '又来一条')); // 退避复位 → t≈160.5s 再次 idle
    await advance(62_000); // t≈162.5s（未复位则要到 t≈220.5s）
    expect(h.idles(), '真人活动后应按 x1 重排').toHaveLength(2);
  });

  it('session 档：agent 回复后从回复时刻重排', async () => {
    const h = await setup({ trigger: sessionIdle('fixed') });
    const G = '20001';

    await h.send(groupMsg(G, '随便聊聊')); // t=0，排在 t=60s
    await advance(30_000);
    await h.reply(sid(G)); // t=30s，重排到 t=90s
    await advance(40_000); // t=70s
    expect(h.idles(), '回复后应从回复时刻重排').toHaveLength(0);
    await advance(25_000); // t=95s
    expect(h.idles()).toHaveLength(1);
  });

  it('exponential 退避封顶 idleTriggerMaxMinutes', async () => {
    const h = await setup({ trigger: sessionIdle('exponential', { idleTriggerMaxMinutes: 2 }) });

    await h.send(groupMsg('20001', '随便聊聊')); // idle 于 t=60s、180s、300s、420s（封顶 2 分钟）
    await advance(7 * 60_000 + 1_000);
    expect(h.idles()).toHaveLength(4);
  });

  it('platform 档：agent 真实回复记为活动，下一轮不选刚回复过的会话', async () => {
    const h = await setup({
      trigger: { idleTriggerScope: 'platform', idleTriggerStrategy: 'fixed', idleTriggerMinutes: 1 },
    });
    const A = '20001';
    const B = '20002';

    await h.send(groupMsg(A, '随便聊聊'));
    await advance(10_000);
    await h.send(groupMsg(B, '随便聊聊'));
    await advance(20_000);
    await h.reply(sid(A)); // t=30s：A 有 bot 活动，比 B 新
    await advance(31_000); // t≈61s tick
    expect(h.idles().map(m => m.sessionId)).toEqual([sid(B)]);
  });

  it('插件停用时清掉 session 档定时器', async () => {
    const h = await setup({ trigger: sessionIdle('fixed') });

    const baseline = vi.getTimerCount(); // 两插件各有一个每日清扫定时器
    await h.send(groupMsg('20001', '随便聊聊'));
    expect(vi.getTimerCount(), '已排上 idle 定时器').toBe(baseline + 1);
    await h.app.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// 影子归档：被吞掉的真人消息进档，下次触发时作为上下文
// ────────────────────────────────────────────────────────────
describe('影子归档', () => {
  it('未触发、禁言关键词、禁言期的消息都入档，禁言期消息只归档一次', async () => {
    const archived: IncomingMessage[] = [];
    const h = await setup({
      trigger: { muteKeywords: '闭嘴', muteTimeSeconds: 60 },
      archived,
    });
    const G = '20001';

    await h.send(groupMsg(G, '未触发的一条'));
    await h.send(groupMsg(G, '你闭嘴吧'));
    await h.send(groupMsg(G, '禁言期'));
    const got = archived.map(m => m.content);
    expect(got).toEqual(['未触发的一条', '你闭嘴吧', '禁言期']);
    expect(h.received).toHaveLength(0);
  });

  it('冷却吞掉的消息入档', async () => {
    const archived: IncomingMessage[] = [];
    const h = await setup({
      flow: { cooldownSeconds: 10 },
      trigger: { intervalMode: 'fixed', fixedInterval: 1 },
      autoReply: () => true,
      archived,
    });

    await h.send(groupMsg('20001', '第一条'));
    await h.send(groupMsg('20001', '冷却中'));
    expect(h.contents()).not.toContain('冷却中');
    expect(archived.map(m => m.content)).toContain('冷却中');
  });
});
