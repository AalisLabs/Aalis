import { afterEach, describe, expect, it } from 'vitest';
import type {} from '../../packages/api-agent/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type { ToolDefinition } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import toolSearch from '../../packages/plugin-tool-search/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 已发现工具集属会话上下文，只在清理类型为空或含 context 时重置。
// 此前中间件不看类型，/clear -t image 这类无关清理也会让模型刚发现的工具从可见列表消失。
// ════════════════════════════════════════════════════════════

const def = (name: string): ToolDefinition => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});
const ALL_TOOLS = ['fetch_url', 'read_file', 'write_file'].map(def);

/** 调过 fetch_url 且收到结果：一条发现证据 */
const withEvidence: Message[] = [
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'fetch_url', arguments: '{}' } }],
  },
  { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
];

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function world() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(toolSearch, { maxDirectTools: 1 });
  await app.plugins.idle();
  const host = app.bind({ hooks });
  /** 本轮发给模型的工具名（不含 search_tools） */
  async function visible(messages: Message[]): Promise<string[]> {
    const data: HookContextMap['agent:llm:before'] = { messages, tools: [...ALL_TOOLS], sessionId: 's1' };
    await host.hooks.run('agent:llm:before', data, async () => {});
    return data.tools.map(t => t.function.name).filter(n => n !== 'search_tools');
  }
  async function clear(scope: 'session' | 'all', types?: string[]) {
    const data: HookContextMap['memory:clear'] = { scope, types, sessionId: 's1', results: [] };
    await host.hooks.run('memory:clear', data, async () => {});
  }
  expect(await visible(withEvidence)).toEqual(['fetch_url']);
  expect(await visible([]), '证据消失后注册表仍记得').toEqual(['fetch_url']);
  return { visible, clear };
}

describe('plugin-tool-search: 已发现工具集随 context 重置', () => {
  it('不含 context 的类型：保留', async () => {
    const cases: Array<{ scope: 'session' | 'all'; types: string[] }> = [
      { scope: 'session', types: ['image'] },
      { scope: 'all', types: ['vector', 'summary'] },
    ];
    for (const c of cases) {
      const { visible, clear } = await world();
      await clear(c.scope, c.types);
      expect(await visible([]), JSON.stringify(c)).toEqual(['fetch_url']);
    }
  });

  it('类型为空或含 context：重置', async () => {
    const cases: Array<{ scope: 'session' | 'all'; types?: string[] }> = [
      { scope: 'session' },
      { scope: 'session', types: ['context'] },
      { scope: 'all' },
      { scope: 'all', types: ['image', 'context'] },
    ];
    for (const c of cases) {
      const { visible, clear } = await world();
      await clear(c.scope, c.types);
      expect(await visible([]), JSON.stringify(c)).toEqual([]);
    }
  });
});
