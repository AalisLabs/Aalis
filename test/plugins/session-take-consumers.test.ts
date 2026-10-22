import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { type RegisteredTool, type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, logger, provide, services } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { seedRooms, storedRoom } from '../fixtures/rooms.js';
import { ONEBOT_TYPES, startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 取别的会话的东西，消费方只调会话管理的规则（契约的包装函数）：
// - 读历史的两个工具都经会话历史服务的 getHistory，带这次调用的授权身份；拒绝时回 { error: 原因 }
// - onebot_get_msg 取到的消息按它所在的窗口拼出会话 id 过规则；判不出对端的（她自己发的私聊消息）按判不出拒绝
// - 跨会话历史：被动注入不是谁要的，不传授权身份；recent_messages 带这次调用的授权身份。查询超取后逐条过规则，
//   被拒的再多也不占名额
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const G1 = `onebot:${SELF}:group:20001`;
const G2 = `onebot:${SELF}:group:20002`;
const PA = `onebot:${SELF}:private:30001`;
const PB = `onebot:${SELF}:private:30002`;
/** owner 在 onebot 上与她的私聊 */
const PO = `onebot:${SELF}:private:39999`;
/** 别的平台的群 */
const X1 = 'chat2:777:group:40001';
const A = { platform: 'onebot', userId: '30001' };
const OWNER = { platform: 'onebot', userId: '39999' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 只记下工具的处理函数的工具服务 */
function toolRecorder() {
  const handlers = new Map<string, RegisteredTool['handler']>();
  const plugin = definePlugin({
    name: 'zz-tools',
    provides: [tools],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(tools, {
        register(tool: Omit<RegisteredTool, 'pluginName'>) {
          handlers.set(tool.definition.function.name, tool.handler);
          return () => void handlers.delete(tool.definition.function.name);
        },
        registerGroup: () => () => {},
      } as never);
    },
  });
  const call = async (name: string, args: Record<string, unknown>, ctx: ToolCallContext) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`工具 ${name} 未注册`);
    return String(await handler(args, ctx));
  };
  return { plugin, call };
}

describe('读历史的工具与 onebot_get_msg 过规则', () => {
  /** onebot_get_msg 按 message_id 取到的消息 */
  const MESSAGES: Record<string, Record<string, unknown>> = {
    101: { message_type: 'group', group_id: 20001, sender: { user_id: 30002 }, message: '<群里的>' },
    102: { message_type: 'private', sender: { user_id: 30002 }, message: '<B 的私聊里的>' },
    103: { message_type: 'private', sender: { user_id: 30001 }, message: '<A 的私聊里的>' },
    104: { message_type: 'private', sender: { user_id: Number(SELF) }, message: '<她发的私聊消息>' },
  };

  async function setup() {
    const recorder = toolRecorder();
    const started = await startSettings({
      adapters: [
        {
          platform: 'onebot',
          sessionTypes: ONEBOT_TYPES,
          callAction: async (_sessionId: string, action: string, params: Record<string, unknown>) => {
            if (action !== 'get_msg') throw new Error(`没有动作 ${action}`);
            return MESSAGES[String(params.message_id)];
          },
        },
      ],
      owners: [OWNER],
      stored: Object.fromEntries([G1, PA, PB].map(id => [id, storedRoom(id)])),
      first: [recorder.plugin],
      plugins: [sessionTools, toolOnebot],
    });
    apps.push(started.app);
    await started.app.start();
    await started.app.plugins.idle();
    const ctx: ToolCallContext = { sessionId: G1, platform: 'onebot', userId: A.userId };
    return { call: (name: string, args: Record<string, unknown>) => recorder.call(name, args, ctx) };
  }

  it('session_get_history 与 onebot_get_session_history：A 读自己的私聊放行，读 B 的私聊回原因', async () => {
    const { call } = await setup();
    expect(JSON.parse(await call('session_get_history', { session_id: PA }))).toMatchObject({ ok: true });
    expect(JSON.parse(await call('session_get_history', { session_id: PB }))).toEqual({
      error: expect.stringContaining('别人的私聊'),
    });
    const onebot = (targetId: string) =>
      call('onebot_get_session_history', { target_type: 'private', target_id: targetId }).then(JSON.parse);
    expect(await onebot('30001')).toMatchObject({ ok: true, sessionId: PA });
    expect(await onebot('30002')).toMatchObject({ error: expect.stringContaining('别人的私聊') });
  });

  it('onebot_get_msg：本群与 A 自己私聊里的照常，B 私聊里的回原因，她自己发的私聊消息判不出', async () => {
    const { call } = await setup();
    const get = (id: number) => call('onebot_get_msg', { message_id: String(id) });
    expect(JSON.parse(await get(101))).toMatchObject({ message: '<群里的>' });
    expect(JSON.parse(await get(103))).toMatchObject({ message: '<A 的私聊里的>' });
    const others = await get(102);
    expect(others).toContain('别人的私聊');
    expect(others).not.toContain('<B 的私聊里的>');
    const own = await get(104);
    expect(own).toContain('判不出');
    expect(own).not.toContain('<她发的私聊消息>');
  });
});

describe('跨会话历史过规则', () => {
  async function setup(config: Record<string, unknown> = {}) {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, services });
    const assembly = app.bind({ contributions, logger });
    await app.plugin(memoryInMemory);
    await app.plugins.idle();
    const memory = host.services.use.get(memoryService);
    if (!memory) throw new Error('memory 服务未就绪');
    await seedRooms(memory, { [G1]: '<群一>', [G2]: '<群二>', [PB]: '<B>', [PO]: '<owner>', [X1]: '<别的平台的群>' });
    host.provide.use(platform, {
      adapterName: 'onebot',
      platform: 'onebot',
      sessionTypes: ONEBOT_TYPES,
      getConnections: () => [],
      sendMessage: async () => {},
    });
    host.provide.use(authority, {
      isOwner: (p: string, u?: string) => p === OWNER.platform && u === OWNER.userId,
    } as never);
    const recorder = toolRecorder();
    await app.plugin(recorder.plugin);
    await app.plugin(sessionManagerPlugin);
    await app.plugin(memoryHistory, { maxAgeMinutes: 0, ...config });
    await app.plugins.idle();
    for (const name of [sessionManagerPlugin.name, memoryHistory.name]) {
      const state = app.plugins.getPlugin(name)?.state;
      if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
    }
    let ts = Date.now() - 60_000;
    const save = async (sessionId: string, content: string, platform = 'onebot') =>
      memory.saveMessage(sessionId, { role: 'user', content, timestamp: ts++, metadata: { platform } });
    const passive = async (): Promise<string> => {
      const messages: Message[] = [{ role: 'user', content: 'now' }];
      await assemblePromptContributions(assembly, { messages, sessionId: G1, platform: 'onebot' });
      const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-history'));
      return typeof block?.content === 'string' ? block.content : '';
    };
    const recent = (ctx: Partial<ToolCallContext> = {}) =>
      recorder.call('recent_messages', {}, { sessionId: G1, platform: 'onebot', ...ctx });
    return { save, passive, recent };
  }

  it('owner 在群里的一轮：被动注入不含 owner 与她的私聊，owner 调 recent_messages 含它', async () => {
    const { save, passive, recent } = await setup();
    await save(G2, '<群二原文>');
    await save(PO, '<owner 私聊原文>');
    await save(PB, '<B 私聊原文>');
    const block = await passive();
    expect(block).toContain('<群二原文>');
    expect(block).not.toContain('<owner 私聊原文>');
    expect(block).not.toContain('<B 私聊原文>');
    const out = await recent({ userId: OWNER.userId });
    expect(out).toContain('<群二原文>');
    expect(out).toContain('<owner 私聊原文>');
    expect(out).not.toContain('<B 私聊原文>');
  });

  it('逐条过：同平台别的群的在，别人私聊的与别的平台的不在；每会话上限为 0、别人的私聊刷屏时照样取满上限条群消息', async () => {
    const { save, passive } = await setup({ limit: 3, perSessionLimit: 0 });
    for (const i of [1, 2, 3]) await save(G2, `<群二第${i}条>`);
    await save(X1, '<别的平台原文>', 'chat2');
    for (let i = 0; i < 20; i++) await save(PB, `<B 刷屏${i}>`);
    const block = await passive();
    for (const i of [1, 2, 3]) expect(block).toContain(`<群二第${i}条>`);
    expect(block).not.toContain('<B 刷屏');
    expect(block).not.toContain('<别的平台原文>');
  });
});
