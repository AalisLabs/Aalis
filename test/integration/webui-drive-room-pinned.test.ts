import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import { textOf } from '../../packages/schema-i18n/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { seedRooms } from '../fixtures/rooms.js';
import { ALL, fieldsPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 从 WebUI 驱动收录过的 IM 群房间：这一轮按房间记下的出生平台（onebot）档运行。
// webui 档开 system 组（exec）、onebot 档只开 search 组；模型第一轮就叫 exec，
// 钉死时它既不在下发的工具列表里、按名直调也被分组闸挡成「未找到」。`/session` 从 WebUI 入口执行时，来源同样按出生平台写。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';
const REPLY = '<回复占位>';

const TOOLS = '@aalis/plugin-tools';
const PERSONA = 'zz-persona';
/** 宿主配置文档里会话设置的各层，按插件实例放值 */
const LAYERS = {
  platforms: {
    webui: { [TOOLS]: { enabledToolGroups: ['system'] }, [PERSONA]: { persona: '<webui 人设>' } },
    onebot: { [TOOLS]: { enabledToolGroups: ['search'] }, [PERSONA]: { persona: '<群人设>' } },
  },
  platformTypes: { onebot: { private: { [PERSONA]: { persona: '<私聊人设>' } } } },
};
/** 人设这一项由人设插件声明，这里不装人设插件，由测试插件代为声明 */
const personaSetting = fieldsPlugin(PERSONA, {
  persona: {
    type: 'string',
    label: '人设',
    default: 'default',
    session: { appliesTo: ALL, prominence: 'common', minLevel: 1 },
  },
}).definition;

const definition = (name: string) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function loadStack() {
  const { app, store } = hostedApp({ sessionConfig: LAYERS });
  apps.push(app);
  await registerHubs(app);
  // /session 只列请求者能改的项：owner 都能改（本文件测的不是鉴权）
  app.bind({ provide }).provide.use(authority, {
    isOwner: () => true,
    ownerOn: () => undefined,
    authorize: () => null,
    meetsLevel: () => true,
  } as never);
  const recorder: ChatModelRequest[] = [];
  const callExec: ChatResponse = {
    content: null,
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'exec', arguments: '{}' } }],
  };
  await app.plugin(createMockLLMPlugin({ responses: [callExec, { content: REPLY }], recorder }));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugins.idle();
  // 房间先由原生入站收录过（预置进会话表）：选档读会话记下的出生平台，不看 id
  await seedRooms(app.bind({ memory }).memory.use, { [GROUP]: '<群名>', [PRIVATE]: '<对端>' });
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin, {});
  await app.plugin(commandsPlugin, {});
  await app.plugin(triggerPolicyPlugin, {});
  await app.plugin(flowControlPlugin, {});
  for (const plugin of [toolsPlugin, sessionManagerPlugin, sessionSettingsPlugin, personaSetting]) {
    await registerFromDoc(app, store, plugin);
  }
  await app.plugin(agentPlugin, { systemPrompt: 'test bot' });
  await app.plugins.idle();
  // 装载过激活闸：依赖没凑齐的插件停在 pending 而不报错，会让「整条链根本没跑」伪装成绿
  for (const plugin of [
    commandsPlugin,
    triggerPolicyPlugin,
    flowControlPlugin,
    toolsPlugin,
    sessionManagerPlugin,
    sessionSettingsPlugin,
    personaSetting,
    agentPlugin,
  ]) {
    const state = app.plugins.getPlugin(plugin.name)?.state;
    if (state !== 'active') throw new Error(`插件 ${plugin.name} 未激活（state=${state}）`);
  }

  const host = app.bind({ events, tools, gateway, sessionManager, sessionSettings, commands: commandsService });
  const exec = vi.fn(async () => 'ran');
  const search = vi.fn(async () => 'found');
  host.tools.use.register({ definition: definition('exec'), handler: exec, groups: ['system'] });
  host.tools.use.register({ definition: definition('web_search'), handler: search, groups: ['search'] });
  const outbound: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => void outbound.push(message));
  const commands = host.commands.use;
  // /session 声明了 risk:'sensitive'，没有守卫时会被拒：放行守卫代替 plugin-authority（本文件测的不是鉴权）
  commands.setExecutionGuard(async () => null);
  return {
    recorder,
    exec,
    outbound,
    gateway: host.gateway.use,
    sm: host.sessionManager.use,
    admin: host.sessionSettings.use,
    commands,
  };
}

describe('WebUI 驱动 IM 房间按出生平台选档', () => {
  it('工具组取 onebot 档：exec 不下发、按名直调也被挡，回复照常发出', async () => {
    const { recorder, exec, outbound, gateway } = await loadStack();

    await gateway.ingressMessage({ sessionId: GROUP, platform: 'webui', userId: 'console', content: '<占位>' });

    expect(recorder.length, '模型应被调用两轮（叫工具、给回复）').toBe(2);
    const offered = (recorder[0].tools ?? []).map(t => t.function.name);
    expect(offered).toContain('web_search');
    expect(offered).not.toContain('exec');
    expect(exec).not.toHaveBeenCalled();
    const toolResult = recorder[1].messages.find(m => m.role === 'tool');
    expect(toolResult?.content).toContain('未找到');
    expect(
      outbound.some(m => m.sessionId === GROUP && m.content?.includes(REPLY)),
      '回复应照常发出（未被触发判定挡下）',
    ).toBe(true);
  });

  it('/session 从 WebUI 入口对群房间执行：来源为平台档 onebot，不按入口的 webui 档；本会话这一层设了时来源写本会话', async () => {
    const { admin, commands } = await loadStack();
    const input = { sessionId: GROUP, platform: 'webui', userId: 'console', args: [], raw: '' };
    const show = async () => textOf(await commands.execute('session', input));

    expect(await show()).toContain('人设（persona）：<群人设> — 来自 平台档 onebot');
    expect(await show()).not.toContain('webui 人设');

    await admin.update({ sessionId: GROUP }, { plugin: PERSONA, key: 'persona', value: '<房间人设>' });
    expect(await show()).toContain('人设（persona）：<房间人设> — 来自 本会话');
  });

  it('/session 对私聊房间：来源写平台类型档的平台与类型名；场所写了的，来源写场所', async () => {
    const { sm, admin, commands } = await loadStack();
    const input = { sessionId: PRIVATE, platform: 'webui', userId: 'console', args: [], raw: '' };
    const show = async () => textOf(await commands.execute('session', input));

    expect(await show()).toContain('人设（persona）：<私聊人设> — 来自 平台类型档 onebot · private');

    const place = { scope: 'place', key: sm.placeOf(PRIVATE).key } as const;
    await admin.update({ layer: place }, { plugin: PERSONA, key: 'persona', value: '<窗口人设>' });
    expect(await show()).toMatch(/人设（persona）：<窗口人设> — 来自 场所/);
  });
});
