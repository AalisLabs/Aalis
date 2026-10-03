import { expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { sessionManager as sessionManagerService } from '../../packages/api-session-manager/src/index.js';
import { definePlugin, lifecycle, provide, services } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 会话用哪个模型：会话设置链（本会话、父会话、受众、平台档、全局默认）上哪一层设了模型就用它，都没设时用 llm 服务的
// 偏好。全局默认这一层就是设置「会话默认」改的那一层，写进宿主配置文档。
// ════════════════════════════════════════════════════════════

const PROVIDER = 'zz-llm';

/** 两个对话模型 a、b；每次请求记下是哪个模型答的 */
function models(answered: string[]) {
  return definePlugin({
    name: PROVIDER,
    provides: [llm],
    uses: { provide, lifecycle },
    apply(caps) {
      for (const id of ['a', 'b']) {
        const handle: LLMModel = {
          id,
          providerId: caps.lifecycle.id,
          contextLength: 8192,
          maxOutputTokens: 1024,
          capabilities: ['chat', 'streaming'],
          async chat() {
            answered.push(id);
            return { content: 'ok' };
          },
          async *chatStream() {
            answered.push(id);
            yield { contentDelta: 'ok' };
            yield { done: true };
          },
        };
        caps.provide(llm, handle, { entryId: `${caps.lifecycle.id}/${id}` });
      }
    },
  });
}

it('全局默认设了模型时会话用它；会话设置链都没设时用服务偏好，清掉全局默认的模型后回到偏好', async () => {
  const answered: string[] = [];
  const { app } = hostedApp();
  await registerHubs(app);
  await app.plugin(models(answered));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  await app.plugin(agentPlugin, {
    systemPrompt: 'test bot',
    historyLimit: 10,
    memoryTokenBudget: 1024,
    maxToolIterations: 3,
    preferredModel: '',
  });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const host = app.bind({ agent: agentService, sessionManager: sessionManagerService, services });
  const agent = host.agent.require();
  const sm = host.sessionManager.require();
  const turn = async () => {
    await agent.handleMessage({
      content: 'hi',
      sessionId: 's1',
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    return answered.at(-1);
  };

  expect(host.services.prefer(llm, `${PROVIDER}/b`)).toBe(true);
  expect(await turn(), '都没设：服务偏好').toBe('b');

  await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: PROVIDER, model: 'a' } });
  expect(await turn(), '全局默认压过服务偏好').toBe('a');

  await sm.updateLayer({ scope: 'defaults' }, { llm: null });
  expect(await turn(), '清掉后回到服务偏好').toBe('b');

  await app.stop();
});
