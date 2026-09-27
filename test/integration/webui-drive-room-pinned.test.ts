import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands as commandsService } from '../../packages/api-commands/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 从 WebUI 驱动 IM 群房间：这一轮按房间的出生平台（onebot）档运行。
// webui 档开 system 组（exec）、onebot 档只开 search 组；模型第一轮就叫 exec，
// 钉死时它既不在下发的工具列表里、按名直调也被分组闸挡成「未找到」。`/session` 的来源显示与实际一致。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';
const REPLY = '<回复占位>';

const PROFILES = {
  platformProfiles: [
    { platform: 'webui', enabledToolGroups: ['system'], persona: '<webui 人设>' },
    { platform: 'onebot', enabledToolGroups: ['search'], persona: '<群人设>' },
    { platform: 'onebot', audience: 'private', persona: '<私聊人设>' },
  ],
};

const definition = (name: string) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function loadStack() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const recorder: ChatModelRequest[] = [];
  const callExec: ChatResponse = {
    content: null,
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'exec', arguments: '{}' } }],
  };
  await app.plugin(createMockLLMPlugin({ responses: [callExec, { content: REPLY }], recorder }));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin, {});
  await app.plugin(commandsPlugin, {});
  await app.plugin(triggerPolicyPlugin, { scopes: ['*:group'] });
  await app.plugin(flowControlPlugin, { scopes: ['*:group'] });
  await app.plugin(toolsPlugin, {});
  await app.plugin(sessionManagerPlugin, PROFILES);
  await app.plugin(agentPlugin, { systemPrompt: 'test bot', historyLimit: 10, maxToolIterations: 3 });
  await app.plugins.idle();
  // 装载过激活闸：依赖没凑齐的插件停在 pending 而不报错，会让「整条链根本没跑」伪装成绿
  for (const plugin of [
    commandsPlugin,
    triggerPolicyPlugin,
    flowControlPlugin,
    toolsPlugin,
    sessionManagerPlugin,
    agentPlugin,
  ]) {
    const state = app.plugins.getPlugin(plugin.name)?.state;
    if (state !== 'active') throw new Error(`插件 ${plugin.name} 未激活（state=${state}）`);
  }

  const host = app.bind({ events, tools, gateway, sessionManager, commands: commandsService });
  const exec = vi.fn(async () => 'ran');
  const search = vi.fn(async () => 'found');
  host.tools.register({ definition: definition('exec'), handler: exec, groups: ['system'] });
  host.tools.register({ definition: definition('web_search'), handler: search, groups: ['search'] });
  const outbound: OutgoingMessage[] = [];
  host.events.on('outbound:message', message => void outbound.push(message));
  const commands = host.commands.require();
  // /session 声明了 risk:'sensitive'，没有守卫时会被拒：放行守卫代替 plugin-authority（本文件测的不是鉴权）
  commands.setExecutionGuard(async () => null);
  return { recorder, exec, outbound, gateway: host.gateway.require(), sm: host.sessionManager.require(), commands };
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

  it('/session 从 WebUI 入口对群房间执行：来源为平台档 onebot，生效值与 resolveConfig 一致', async () => {
    const { sm, commands } = await loadStack();
    const input = { sessionId: GROUP, platform: 'webui', userId: 'console', args: [], raw: '' };

    const inherited = await commands.execute('session', input);
    expect(inherited).toContain(`人设: ${sm.resolveConfig(GROUP, 'webui').persona}  [来源: 平台档 onebot]`);
    expect(inherited).not.toContain('webui 人设');

    // 会话有覆盖时：生效值来自覆盖，另起一行列出被覆盖的继承值与来源
    await sm.ensureSession(GROUP, { config: { persona: '<房间人设>' } });
    const overridden = await commands.execute('session', input);
    expect(overridden).toContain(`人设: ${sm.resolveConfig(GROUP, 'webui').persona}  [来源: 会话覆盖]`);
    expect(overridden).toContain('被覆盖的继承值: <群人设>  [来源: 平台档 onebot]');
  });

  it('/session 对私聊房间：来源标出平台档的私聊条目', async () => {
    const { commands } = await loadStack();
    const input = { sessionId: PRIVATE, platform: 'webui', userId: 'console', args: [], raw: '' };

    const shown = await commands.execute('session', input);
    expect(shown).toContain('人设: <私聊人设>  [来源: 平台档 onebot（私聊）]');
  });
});
