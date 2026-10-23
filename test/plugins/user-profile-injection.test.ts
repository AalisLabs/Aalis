import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import userProfilePlugin from '../../packages/plugin-user-profile/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { StepModel, stepModelPlugin } from '../fixtures/step-llm.js';

// ════════════════════════════════════════════════════════════
// 关系分只给真人的话：她回复的点名与插话叠加增量，每条归档的入站加旁观增量；带来源的注入（子任务的任务消息、好友申请通知等）
// 不是谁在跟她说话，两样都不加，也就不为它带的账号建档案。真的 agent 与消息归档，模型是替身。
// ════════════════════════════════════════════════════════════

const PROFILE_NS = 'user:profile';
const PARENT = 'onebot:10000:group:20001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(stepModelPlugin(new StepModel(() => ({ content: '好' }))));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugin(userProfilePlugin, { extractEveryNMessages: 0 });
  await app.plugins.idle();
  for (const { name } of [agentPlugin, userProfilePlugin]) {
    expect(app.plugins.getPlugin(name)?.state, name).toBe('active');
  }
  const host = app.bind({ agent, memory });
  /** 关系分写入不等回合（旁观那一路在归档事件里），等它们落盘再读 */
  const profileOf = async (key: string) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return host.memory.use.getMetadata(PROFILE_NS, key);
  };
  return { say: (message: IncomingMessage) => host.agent.use.handleMessage(message), profileOf };
}

describe('关系分只给真人的话', () => {
  it.each<[string, IncomingMessage, string]>([
    [
      '子任务的任务消息（发言者写成 parent:<父会话>）',
      {
        content: '查一下明天的天气',
        sessionId: 'sub-1',
        platform: 'onebot',
        userId: `parent:${PARENT}`,
        source: 'subtask',
        fromTurn: { platform: 'onebot', participants: [{ platform: 'onebot', userId: '30001' }] },
      },
      `onebot:parent:${PARENT}`,
    ],
    [
      '好友申请通知（发言者是申请人）',
      {
        content: '[系统通知] 有人向我发出了好友申请',
        sessionId: 'onebot:10000:private:30009',
        platform: 'onebot',
        userId: '30009',
        source: 'onebot-request',
      },
      'onebot:30009',
    ],
  ])('%s：不建档案、不加关系分；同一个 agent 里真人的话照常加（点名的加旁观与 direct，被挑中的插话加旁观与 interval）', async (_name, injected, key) => {
    const s = await boot();
    await s.say(injected);
    const group = { sessionId: PARENT, platform: 'onebot', sessionType: 'group' } as const;
    await s.say({ ...group, content: '你好', userId: '30001' });
    await s.say({ ...group, content: '路过', userId: '30002', triggerType: 'interval' });
    expect(await s.profileOf(key)).toBeUndefined();
    expect(Number((await s.profileOf('onebot:30001'))?.relationScore)).toBeCloseTo(1.1, 5);
    expect(Number((await s.profileOf('onebot:30002'))?.relationScore)).toBeCloseTo(0.6, 5);
  });
});
