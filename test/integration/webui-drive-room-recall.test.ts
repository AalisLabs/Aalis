import { afterEach, describe, expect, it } from 'vitest';
import type { TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryHistoryPlugin from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 从 WebUI 驱动 IM 群房间时，提示词贡献方取跨会话料的「当前平台」是房间的出生平台：
// memory-history 的同平台注入只取 onebot 的会话，不带 owner 自己 WebUI 会话的原文。
// token:request 快照（webui-server 只带 sessionId，agent 按出生平台兜底）与真实回合同一口径，
// 两处注入的是同一块内容。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const OTHER_GROUP = 'onebot:10000:group:20002';
const OWNER = 'session-abcd1234';
/** 两边原文长度差得远：注入块换了来源，token 数一定不同 */
const OWNER_TEXT = `WebUI原文${'。'.repeat(400)}`;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function loadStack() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const recorder: ChatModelRequest[] = [];
  await app.plugin(createMockLLMPlugin({ responses: [{ content: '<回复占位>' }], recorder }));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin, {});
  await app.plugin(triggerPolicyPlugin, { scopes: ['*:group'] });
  await app.plugin(flowControlPlugin, { scopes: ['*:group'] });
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(memoryHistoryPlugin, { scope: 'same-platform', maxAgeMinutes: 0, perSessionLimit: 0 });
  await app.plugin(agentPlugin, { systemPrompt: 'test bot', historyLimit: 10 });
  await app.plugins.idle();
  // 装载过激活闸：依赖没凑齐的插件停在 pending 而不报错，会让「整条链根本没跑」伪装成绿
  for (const plugin of [
    triggerPolicyPlugin,
    flowControlPlugin,
    sessionManagerPlugin,
    memoryHistoryPlugin,
    agentPlugin,
  ]) {
    const state = app.plugins.getPlugin(plugin.name)?.state;
    if (state !== 'active') throw new Error(`插件 ${plugin.name} 未激活（state=${state}）`);
  }

  const host = app.bind({ events, gateway, memory: memoryService });
  const memory = host.memory.require();
  const baseTs = Date.now() - 10_000;
  await memory.saveMessage(OTHER_GROUP, {
    role: 'user',
    content: '别的群原文',
    timestamp: baseTs,
    metadata: { platform: 'onebot' },
  });
  await memory.saveMessage(OWNER, {
    role: 'user',
    content: OWNER_TEXT,
    timestamp: baseTs + 1,
    metadata: { platform: 'webui' },
  });
  const usages: TokenUsageEvent[] = [];
  host.events.on('token:usage', usage => void usages.push(usage));
  return { recorder, usages, gateway: host.gateway.require(), events: host.events };
}

describe('WebUI 驱动 IM 房间：跨会话料按出生平台', () => {
  it('安全：真实回合只注入 onebot 会话的原文，token 快照注入同一块', async () => {
    const { recorder, usages, gateway, events: bus } = await loadStack();

    await gateway.ingressMessage({ sessionId: GROUP, platform: 'webui', userId: 'console', content: '<占位>' });

    expect(recorder.length, '模型应被调用一轮').toBe(1);
    const block = recorder[0].messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-history'));
    expect(block?.content).toContain('别的群原文');
    expect(block?.content).not.toContain('WebUI原文');

    const turnUsage = usages.find(u => u.sessionId === GROUP);
    const turnTokens = turnUsage?.breakdown.injectors?.['memory-history'];
    expect(turnTokens, '真实回合应带 memory-history 的注入').toBeGreaterThan(0);

    usages.length = 0;
    await bus.emit('token:request', { sessionId: GROUP });
    expect(usages).toHaveLength(1);
    expect(usages[0].breakdown.injectors?.['memory-history']).toBe(turnTokens);
  });
});
