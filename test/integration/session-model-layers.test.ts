import { expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { definePlugin, lifecycle, provide, services } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 会话用哪个模型：会话设置里全局之上哪一层设了 agent 的「模型」就用它，都没设时交给服务选择。这一项的全局层是 agent 的本插件
// 偏好（写全局层改的就是它，不动 llm 服务的全局偏好）；本插件偏好没设时跟全局偏好，指向的模型不在时回落到服务按提供者优先级
// 与位次解析到的模型。
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

/** 模型 a、b，会话管理、会话设置与对话代理 */
async function boot(answered: string[]) {
  const { app } = hostedApp();
  await registerHubs(app);
  await app.plugin(models(answered));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  await app.plugin(sessionSettingsPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test bot', memoryTokenBudget: 1024 });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const host = app.bind({ agent: agentService, sessionSettings, services });
  /** 写 agent「模型」的全局层（null 即恢复默认） */
  const setGlobal = (model: string | null) =>
    host.sessionSettings.use.update(
      { layer: { scope: 'global' } },
      { plugin: agentPlugin.name, key: 'llm', value: model === null ? null : { provider: PROVIDER, model } },
    );
  return { app, host, setGlobal };
}

const forAgent = { for: agentPlugin.name };

it('「模型」的全局层是 agent 的本插件偏好：没设时跟全局偏好，指向的模型不在时回落到服务解析到的那一个', async () => {
  const answered: string[] = [];
  const { app, host, setGlobal } = await boot(answered);
  const turn = async () => {
    await host.agent.use.handleMessage({
      content: 'hi',
      sessionId: 's1',
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    return answered.at(-1);
  };

  host.services.use.prefer(llm, `${PROVIDER}/b`);
  expect(await turn(), '都没设：全局偏好').toBe('b');

  await setGlobal('a');
  expect(host.services.use.preferred(llm, forAgent)).toBe(`${PROVIDER}/a`);
  expect(host.services.use.preferred(llm), '不动全局偏好').toBe(`${PROVIDER}/b`);
  expect(await turn(), '写全局层即改本插件偏好').toBe('a');

  // 写下之后才不在的模型：偏好照旧指着它
  host.services.use.prefer(llm, `${PROVIDER}/gone`, forAgent);
  expect(await turn(), '本插件偏好指向的模型不在：回落到全局偏好').toBe('b');

  await setGlobal(null);
  expect(host.services.use.preferred(llm, forAgent), '恢复默认即取消本插件偏好').toBeUndefined();
  host.services.use.unprefer(llm);
  expect(await turn(), '都没有偏好：登记在先的 a').toBe('a');

  await app.stop();
});

// 回归：对话代理曾有自己的默认模型配置，每次激活都把偏好拉回它
it('重载对话代理不改它的本插件偏好', async () => {
  const { app, host, setGlobal } = await boot([]);
  await setGlobal('b');

  expect(await app.plugins.bounce(agentPlugin.name)).toBe(true);
  await app.plugins.idle();
  expect(host.services.use.preferred(llm, forAgent)).toBe(`${PROVIDER}/b`);

  await app.stop();
});
