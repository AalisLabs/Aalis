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
// 会话用哪个模型：会话设置链上全局默认之上哪一层设了模型就用它，都没设时用 llm 服务此刻解析到的那一个。默认模型只有一处：
// 全局默认层的「模型」读写的就是 llm 服务的偏好，偏好指向的模型不在时回落到服务按提供者优先级与登记先后解析到的模型。
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
          providerId: caps.lifecycle.use.id,
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
        caps.provide.use(llm, handle, { entryId: `${caps.lifecycle.use.id}/${id}` });
      }
    },
  });
}

/** 模型 a、b，会话管理与对话代理 */
async function boot(answered: string[]) {
  const { app } = hostedApp();
  await registerHubs(app);
  await app.plugin(models(answered));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test bot', memoryTokenBudget: 1024 });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const host = app.bind({ agent: agentService, sessionManager: sessionManagerService, services });
  return { app, host, sm: host.sessionManager.use };
}

it('全局默认层的「模型」就是服务偏好：没有任何一层设时回复用偏好指向的模型，指向的模型不在时回落到服务解析到的那一个', async () => {
  const answered: string[] = [];
  const { app, host, sm } = await boot(answered);
  const agent = host.agent.use;
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

  host.services.use.prefer(llm, `${PROVIDER}/b`);
  expect(await turn(), '都没设：服务偏好').toBe('b');
  expect(sm.getLayer({ scope: 'defaults' }).llm, '全局默认层读到的就是偏好').toEqual({
    provider: PROVIDER,
    model: 'b',
  });

  await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: PROVIDER, model: 'a' } });
  expect(host.services.use.preferred(llm)).toBe(`${PROVIDER}/a`);
  expect(await turn(), '改全局默认即改偏好').toBe('a');

  await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: PROVIDER, model: 'gone' } });
  expect(await turn(), '偏好指向的模型不在：回落到登记在先的 a').toBe('a');

  await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: PROVIDER, model: 'b' } });
  expect(await turn()).toBe('b');
  await sm.updateLayer({ scope: 'defaults' }, { llm: null });
  expect(host.services.use.preferred(llm), '清掉即取消偏好').toBeUndefined();
  expect(await turn(), '没有偏好：登记在先的 a').toBe('a');

  await app.stop();
});

// 回归：对话代理曾有自己的默认模型配置，每次激活都把偏好拉回它
it('重载对话代理不改 llm 服务的偏好', async () => {
  const { app, host, sm } = await boot([]);
  await sm.updateLayer({ scope: 'defaults' }, { llm: { provider: PROVIDER, model: 'b' } });

  expect(await app.plugins.bounce(agentPlugin.name)).toBe(true);
  await app.plugins.idle();
  expect(host.services.use.preferred(llm)).toBe(`${PROVIDER}/b`);

  await app.stop();
});
