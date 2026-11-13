import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent as agentService, type TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { sessionManager as sessionManagerService } from '../../packages/api-session-manager/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 会话级提示选项在真实回合与 token:request 快照里口径一致：
//   1. 快照的 tokenBudget 曾少乘 trimThresholdRatio，与真实回合对不上；
//   2. 快照的系统提示曾不带会话选项（人设覆盖 / 结构化输出开关 / 额外提示），persona 桶按全局层估算；
//   3. 额外提示（人设插件的按会话字段 systemPromptExtra）接在人设提示之后、结构化输出格式说明之前：agent 把会话交给人设服务，
//      由它按会话读。
// 真 fs 角色卡 + 真会话管理与会话设置 + mock LLM。
// ════════════════════════════════════════════════════════════

const CARD = [
  'name: zz-card',
  'description: 结构化输出人设',
  'prompt: 卡片正文。',
  'outputFormat:',
  '  mood:',
  '    description: 心情',
  '  message:',
  '    description: 回复正文',
  '    reply: true',
  '',
].join('\n');

describe('会话级提示选项：真实回合与 token:request 快照', () => {
  let base: string;
  let app: App;

  const boot = async (trimThresholdRatio: number) => {
    app = new App({ logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.plugin(storageLocalPlugin, {});
    const recorder: ChatModelRequest[] = [];
    await app.plugin(createMockLLMPlugin({ responses: [{ content: '{"mood":"平静","message":"好"}' }], recorder }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(sessionManagerPlugin, {});
    await app.plugin(sessionSettingsPlugin, {});
    await app.plugin(personaPlugin, { timeInjection: false });
    await app.plugin(agentPlugin, { systemPrompt: '', memoryTokenBudget: 1024, trimThresholdRatio });
    await app.plugins.idle();
    for (const id of [storageLocalPlugin.name, sessionManagerPlugin.name, personaPlugin.name, agentPlugin.name]) {
      const state = app.plugins.getPlugin(id)?.state;
      if (state !== 'active') throw new Error(`插件 ${id} 未激活（state=${state}）`);
    }
    const host = app.bind({ events, agent: agentService, sessionManager: sessionManagerService, sessionSettings });
    /** 写这个会话本会话层人设插件的一项（会话先建档） */
    const set = async (sessionId: string, key: string, value: unknown) => {
      await host.sessionManager.use.ensureSession(sessionId);
      await host.sessionSettings.use.update({ sessionId }, { plugin: personaPlugin.name, key, value });
    };
    const usage: TokenUsageEvent[] = [];
    host.events.use.on('token:usage', u => {
      usage.push(u);
    });
    /** 发 token:request 并取回这一次的快照 */
    const snapshot = async (sessionId: string): Promise<TokenUsageEvent> => {
      const before = usage.length;
      await host.events.use.emit('token:request', { sessionId, platform: 'test' });
      expect(usage.length, 'token:request 未产出快照').toBe(before + 1);
      return usage[usage.length - 1];
    };
    return { host, recorder, usage, snapshot, set, agent: host.agent.use };
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-session-prompt-'));
    mkdirSync(join(base, 'self', 'persona'), { recursive: true });
    writeFileSync(join(base, 'self', 'persona', 'default.yaml'), CARD);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('快照的 tokenBudget 与真实回合同一公式（trimThresholdRatio ≠ 1）', async () => {
    const { agent, usage, snapshot } = await boot(0.5);
    await agent.handleMessage({ content: '你好', sessionId: 'test:budget', platform: 'test', userId: 'u1' });
    const real = usage.find(u => u.sessionId === 'test:budget');
    if (!real) throw new Error('真实回合未发 token:usage');

    const snap = await snapshot('test:budget');
    expect(snap.contextWindow).toBe(real.contextWindow);
    expect(snap.tokenBudget).toBe(real.tokenBudget);
    // 钉住比例确实生效：预算低于「不乘比例」的算法
    expect(snap.tokenBudget).toBeLessThan(snap.contextWindow - snap.maxTokens - 512);
  });

  it('快照的系统提示按会话设置构建：额外提示与结构化输出开关计入 persona 桶', async () => {
    const { set, snapshot } = await boot(1);
    await set('test:extra', 'systemPromptExtra', '额外'.repeat(1000));
    await set('test:plain-output', 'disableOutputFormat', true);

    const baseline = (await snapshot('test:default')).breakdown.persona;
    expect((await snapshot('test:extra')).breakdown.persona).toBeGreaterThan(baseline + 500);
    // 关掉结构化输出，格式说明块不再计入
    expect((await snapshot('test:plain-output')).breakdown.persona).toBeLessThan(baseline);
  });

  it('真实回合：systemPromptExtra 接在人设提示之后、格式说明之前；未设置的会话不带', async () => {
    const { agent, set, recorder } = await boot(1);
    await set('test:with-extra', 'systemPromptExtra', '  本会话只用英文回答。  ');

    await agent.handleMessage({ content: '你好', sessionId: 'test:with-extra', platform: 'test', userId: 'u1' });
    const system = String(recorder[0].messages[0].content);
    const cardAt = system.indexOf('卡片正文。');
    const extraAt = system.indexOf('本会话只用英文回答。');
    const formatAt = system.indexOf('# 输出格式');
    expect(cardAt).toBeGreaterThanOrEqual(0);
    expect(extraAt).toBeGreaterThan(cardAt);
    expect(formatAt).toBeGreaterThan(extraAt);

    await agent.handleMessage({ content: '你好', sessionId: 'test:no-extra', platform: 'test', userId: 'u1' });
    expect(String(recorder[recorder.length - 1].messages[0].content)).not.toContain('本会话只用英文回答。');
  });
});
