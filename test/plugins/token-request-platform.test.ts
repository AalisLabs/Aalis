import { afterEach, describe, expect, it } from 'vitest';
import type { TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { App, events, LogHub } from '../../packages/core/src/index.js';
import agent from '../../packages/plugin-agent/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import { resolveSessionPlatform } from '../../packages/plugin-webui-server/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// token:request 的 platform：契约原先没有这个字段，唯一发射方（webui-server）
// 也不带，而处理器按 data.platform 解析模型与会话配置——于是预算快照绕过
// 平台 profile 层，算成另一个模型的窗口，末尾还真发一条 token:usage
// （platform 为空串），memory-summary 可据此触发一次无谓自动压缩。
// 处理器统一按 'webui' 兜底；显式传入的平台照用。
// ════════════════════════════════════════════════════════════

const AGENT_CONFIG = {
  systemPrompt: 'test',
  historyLimit: 50,
  memoryTokenBudget: 1024,
  maxToolIterations: 5,
  toolResultMaxRatio: 0.15,
  trimThresholdRatio: 1.0,
  preferredModel: '',
};

let app: App;

afterEach(async () => {
  // 纯函数用例不启动 app
  await app?.stop();
});

/** 激活闸下「插件没激活」会让缺断言的用例伪装成绿：装载后逐个核实状态 */
function requireActive(...names: string[]): void {
  for (const name of names) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`插件 "${name}" 未激活（state=${state}）`);
  }
}

async function boot() {
  app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const mockLLM = createMockLLMPlugin({});
  await app.plugin(mockLLM);
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.register(messageArchive, { debugLogs: false });
  await app.plugins.register(agent, AGENT_CONFIG);
  await app.plugins.idle();
  requireActive(mockLLM.name, memoryInMemory.name, messageArchive.name, agent.name);
  const host = app.bind({ events });
  const seen: TokenUsageEvent[] = [];
  host.events.on('token:usage', (u: TokenUsageEvent) => {
    seen.push(u);
  });
  return { seen, host };
}

describe('resolveSessionPlatform（webui-server 发射侧的平台归属）', () => {
  // WebUI 是管理面，订阅的会话可以属于任何平台；一律报 'webui' 会让快照算到错的档上
  const known = new Set(['onebot', 'telegram']);

  it('已注册平台的会话前缀照用', () => {
    expect(resolveSessionPlatform('onebot:123456', known)).toBe('onebot');
    expect(resolveSessionPlatform('telegram:g:1', known)).toBe('telegram');
  });

  it('不带前缀的会话落回 webui（CLI 的 cli-default、webui 自己的会话）', () => {
    expect(resolveSessionPlatform('cli-default', known)).toBe('webui');
    expect(resolveSessionPlatform('webui-default', known)).toBe('webui');
  });

  it('前缀未注册为平台时落回 webui，不凭字面猜', () => {
    expect(resolveSessionPlatform('discord:9', known)).toBe('webui');
    expect(resolveSessionPlatform(':x', known)).toBe('webui');
  });
});

describe('token:request 的平台归属', () => {
  it('缺省 platform：快照按 webui 归属，不发空平台', async () => {
    const { seen, host } = await boot();
    await host.events.emit('token:request', { sessionId: 'webui-default' });
    expect(seen.length).toBe(1);
    expect(seen[0].platform).toBe('webui');
  });

  it('显式 platform 照用，不被兜底覆盖', async () => {
    const { seen, host } = await boot();
    await host.events.emit('token:request', { sessionId: 'onebot:1', platform: 'onebot' });
    expect(seen.length).toBe(1);
    expect(seen[0].platform).toBe('onebot');
  });
});

describe('token 日志节流状态随会话删除清理', () => {
  // 节流状态按 sessionId 累计；会话删除后不清就只增不减。可观测面是节流日志：
  // 同一会话首轮必打、之后每 10 轮一次，清理后同 id 应从头计数。
  it('session:deleted 之后同一会话的节流计数从头开始', async () => {
    const logHub = new LogHub();
    const lines: string[] = [];
    logHub.onEntry(e => {
      if (e.message.includes('[token-usage:')) lines.push(e.message);
    });
    app = new App({ name: 'T', logLevel: 'info', logHub });
    await registerHubs(app);
    const mockLLM = createMockLLMPlugin({});
    await app.plugin(mockLLM);
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.register(messageArchive, { debugLogs: false });
    await app.plugins.register(agent, AGENT_CONFIG);
    await app.plugins.idle();
    requireActive(mockLLM.name, memoryInMemory.name, messageArchive.name, agent.name);
    const host = app.bind({ events });
    const sessionId = 'webui-token-log-reset';

    await host.events.emit('token:request', { sessionId }); // 首轮：打
    await host.events.emit('token:request', { sessionId }); // 第二轮、同一桶：不打
    expect(lines, '前置：节流生效，否则下面的断言恒真').toHaveLength(1);

    await host.events.emit('session:deleted', sessionId);
    await host.events.emit('token:request', { sessionId });
    expect(lines, '删除会话后同 id 重新计数，首轮必打').toHaveLength(2);
  });
});
