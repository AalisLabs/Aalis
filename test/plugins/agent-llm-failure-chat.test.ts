import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { App, definePlugin, events, type PluginDefinition } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 一个 LLM 都解析不到时，agent 把「以下 LLM 插件激活失败：…」发回会话（群聊也在内）。
// 这条只点名出错的实例、指向 /doctor，不带插件的 error 原文：模型发现失败的原因里有发现地址与
// connect ECONNREFUSED <地址>:<端口> 这类网络层原因，发进会话就把内网部署细节交给了群里所有人。
// ════════════════════════════════════════════════════════════

/** 占位的内网地址（TEST-NET-1），只出现在插件的 error 原文里 */
const ADDRESS = '192.0.2.10:11434';
const REASON = `模型发现失败 http://${ADDRESS}/api/tags: fetch failed ← connect ECONNREFUSED ${ADDRESS}`;

/** 声明提供 llm、激活时按模型发现失败抛错的插件（可多实例） */
const brokenLLM = definePlugin({
  name: 'zz-broken-llm',
  reusable: true,
  provides: [llm],
  apply() {
    throw new Error(REASON);
  },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

async function use(app: App, module: PluginDefinition, config?: Record<string, unknown>): Promise<void> {
  await app.plugin(module, config);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(module.name)?.state;
  if (state !== 'active') throw new Error(`插件 ${module.name} 未激活（state=${state}）`);
}

describe('LLM 全部激活失败：发回会话的提示只点名实例', () => {
  it('点名每个出错的实例并指向 /doctor，不带 error 原文', async () => {
    const app = new App({ name: 'E2E', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const instances = ['zz-broken-llm', 'zz-broken-llm:b', 'zz-broken-llm:c', 'zz-broken-llm:d'];
    for (const id of instances) await app.plugin(brokenLLM, {}, id);
    await app.plugins.idle();
    for (const id of instances) {
      const entry = app.plugins.getPlugin(id);
      expect(entry?.state, `前置：${id} 没有转为 error`).toBe('error');
      expect(entry?.error, `前置：${id} 的 error 里没有原因`).toContain(ADDRESS);
    }
    await use(app, memoryInMemoryPlugin);
    await use(app, messageArchivePlugin, { debugLogs: false });
    await use(app, agentPlugin, { systemPrompt: 'test', historyLimit: 50, memoryTokenBudget: 1024 });

    const host = app.bind({ events, agent });
    const sent: string[] = [];
    host.events.on('outbound:message', (msg: OutgoingMessage) => {
      sent.push(msg.content);
    });
    await host.agent.require().handleMessage({
      content: '你好',
      sessionId: 'test:group:llm-down',
      platform: 'test',
      userId: 'u1',
      sessionType: 'group',
    });

    expect(sent, `应只发一条提示: ${JSON.stringify(sent)}`).toHaveLength(1);
    const text = sent[0] ?? '';
    expect(text, '聊天提示带出了 error 原文').not.toContain('模型发现失败');
    expect(text, '聊天提示带出了内网地址').not.toContain('192.0.2.10');
    expect(text, '聊天提示带出了网络层原因').not.toContain('ECONNREFUSED');
    expect(text, '出错的实例要全部点名').toContain(`以下 LLM 插件激活失败：${instances.join('、')}。`);
    expect(text, '/doctor 是受限指令，提示要注明需要权限').toContain('可用 /doctor 查看原因（需要相应权限）');
  });
});
