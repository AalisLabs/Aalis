import { afterEach, describe, expect, it } from 'vitest';
import type { TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, events, LogHub } from '../../packages/core/src/index.js';
import agent from '../../packages/plugin-agent/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { recordRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// token:request 的 platform：处理器按它解析模型、会话配置与提示词贡献方的
// 「当前平台」，缺了就会绕过平台档、算成另一个模型的窗口，末尾还真发一条
// token:usage（platform 为空串），memory-summary 可据此触发一次无谓自动压缩。
// 发射方会话服务对房间不填它；处理器按「显式传入 → 会话管理记下的出生平台（子会话取根会话的）→ 'webui'」兜底。
// ════════════════════════════════════════════════════════════

const AGENT_CONFIG = {
  systemPrompt: 'test',
  memoryTokenBudget: 1024,
  toolResultMaxRatio: 0.15,
  trimThresholdRatio: 1.0,
  preferredModel: '',
};

let app: App;

afterEach(async () => {
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
  await app.plugins.register(sessionManagerPlugin, {});
  await app.plugins.register(agent, AGENT_CONFIG);
  await app.plugins.idle();
  requireActive(mockLLM.name, memoryInMemory.name, messageArchive.name, sessionManagerPlugin.name, agent.name);
  const host = app.bind({ events, sessionManager });
  const seen: TokenUsageEvent[] = [];
  host.events.on('token:usage', (u: TokenUsageEvent) => {
    seen.push(u);
  });
  return { seen, host };
}

describe('token:request 的平台归属', () => {
  it('缺省 platform：快照按 webui 归属，不发空平台', async () => {
    const { seen, host } = await boot();
    await host.events.emit('token:request', { sessionId: 'webui-default' });
    expect(seen.length).toBe(1);
    expect(seen[0].platform).toBe('webui');
  });

  it('显式 platform 照用，不被兜底覆盖', async () => {
    const { seen, host } = await boot();
    // 用没有出生平台的会话：房间 id 的出生平台与显式值相同，测不出显式值是否被采用
    await host.events.emit('token:request', { sessionId: 'cli-default', platform: 'cli' });
    expect(seen.length).toBe(1);
    expect(seen[0].platform).toBe('cli');
  });

  it('IM 房间缺省 platform：按会话记下的出生平台归属，子会话取根会话的，不查已注册的适配器', async () => {
    // 不装 onebot 适配器：出生平台是建档时记下的字段，适配器没加载时同样按它
    const { seen, host } = await boot();
    const room = 'onebot:10000:group:20001';
    await recordRoom(host.events, room);
    const task = await host.sessionManager.require().createChildSession(room);
    await host.events.emit('token:request', { sessionId: room });
    await host.events.emit('token:request', { sessionId: task.id });
    expect(seen.map(u => u.platform)).toEqual(['onebot', 'onebot']);
  });

  it('会话表里没有出生平台的会话按 webui，不从会话 id 推', async () => {
    const { seen, host } = await boot();
    await host.events.emit('token:request', { sessionId: 'onebot:10000:group:20002' });
    expect(seen.map(u => u.platform)).toEqual(['webui']);
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

describe('token:usage 的分项', () => {
  it('分项带显示名、按显示的次序排，数与 breakdown 一致；其余系统提示一项带按注入者的明细', async () => {
    const { seen, host } = await boot();
    await host.events.emit('token:request', { sessionId: 'webui-parts' });
    const [usage] = seen;
    const { breakdown } = usage;
    expect(usage.parts.map(part => [part.label, part.tokens])).toEqual([
      ['历史消息', breakdown.history],
      ['工具结果', breakdown.toolResults],
      ['工具定义', breakdown.toolDefs],
      ['人设', breakdown.persona],
      ['对话摘要', breakdown.memorySummary],
      ['向量记忆', breakdown.memoryVector],
      ['技能', breakdown.skills],
      ['平台提示', breakdown.platform],
      ['子任务', breakdown.subtask],
      ['其余系统提示', breakdown.systemOther],
    ]);
    expect(usage.parts.at(-1)?.injectors).toEqual(breakdown.injectors);
    expect(usage.parts.slice(0, -1).every(part => part.injectors === undefined)).toBe(true);
  });
});
