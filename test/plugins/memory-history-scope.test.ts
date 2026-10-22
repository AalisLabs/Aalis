import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, logger, provide, services } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { sessionValuesPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 跨会话历史范围（memory-history 的 scope，可按会话设）：生效值是召回上限，被动注入与 recent_messages 都不超过它。
// 「仅本会话」一档两处都不查其他会话；工具参数要更宽时按生效值，要更窄时照给的；哪一层写坏了按最窄（仅本会话）。
// 会话设置不在时只按插件配置。
// ════════════════════════════════════════════════════════════

const CUR = 'onebot:10000:group:20001';
const OTHER_GROUP = 'onebot:10000:group:20002';
const PRIV = 'onebot:10000:private:30001';
const WEB = 'webui:console';

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** sessions 给出时装会话设置的替身，按会话 id 交本会话层的值 */
async function setup(pluginConfig: Record<string, unknown>, sessions?: Record<string, Record<string, unknown>>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, services });
  const assembly = app.bind({ contributions, logger });
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const memory = host.services.use.get(memoryService);
  if (!memory) throw new Error('memory 服务未就绪');
  const baseTs = Date.now() - 10_000;
  const entries: Array<[string, string, string]> = [
    [CUR, 'onebot', '本群原文'],
    [OTHER_GROUP, 'onebot', '别的群原文'],
    [PRIV, 'onebot', '私聊原文'],
    [WEB, 'webui', 'WebUI原文'],
  ];
  for (const [i, [sessionId, platform, content]] of entries.entries()) {
    await memory.saveMessage(sessionId, { role: 'user', content, timestamp: baseTs + i, metadata: { platform } });
  }

  if (sessions) await app.plugin(sessionValuesPlugin(sessions));
  const toolHandlers = new Map<string, ToolHandler>();
  host.provide.use(tools, {
    register: (tool: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      toolHandlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugin(memoryHistory, { maxAgeMinutes: 0, perSessionLimit: 0, ...pluginConfig });
  await app.plugins.idle();
  if (app.plugins.getPlugin(memoryHistory.name)?.state !== 'active') throw new Error('plugin-memory-history 未激活');
  return { assembly, recentMessages: toolHandlers.get('recent_messages')! };
}

/** 跑一次被动注入，返回注入块正文（没有注入时为 undefined） */
async function passive(assembly: Awaited<ReturnType<typeof setup>>['assembly']): Promise<string | undefined> {
  const messages: Message[] = [{ role: 'user', content: 'now' }];
  await assemblePromptContributions(assembly, { messages, sessionId: CUR, platform: 'onebot' });
  const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-history'));
  return typeof block?.content === 'string' ? block.content : undefined;
}

const callCtx = { sessionId: CUR, platform: 'onebot' };

describe('plugin-memory-history：跨会话历史范围是召回上限', () => {
  it('这个会话设成仅本会话：被动注入不交料，recent_messages 不论要哪一档都拒', async () => {
    const { assembly, recentMessages } = await setup({ scope: 'cross-platform' }, { [CUR]: { scope: 'session' } });
    expect(await passive(assembly)).toBeUndefined();
    for (const scope of [undefined, 'same-platform', 'cross-platform']) {
      const out = await recentMessages(scope ? { scope } : {}, callCtx);
      expect(out, `scope=${scope}`).toContain('本会话的跨会话历史范围限于本会话');
      expect(out).not.toContain('私聊原文');
      expect(out).not.toContain('别的群原文');
      expect(out).not.toContain('WebUI原文');
    }
  });

  it('这个会话设成同平台、插件配置跨平台：别的平台不进注入，工具要跨平台也按同平台', async () => {
    const { assembly, recentMessages } = await setup(
      { scope: 'cross-platform' },
      { [CUR]: { scope: 'same-platform' } },
    );
    const block = await passive(assembly);
    expect(block).toContain('私聊原文');
    expect(block).toContain('别的群原文');
    expect(block).not.toContain('WebUI原文');
    for (const scope of [undefined, 'cross-platform']) {
      const out = await recentMessages(scope ? { scope } : {}, callCtx);
      expect(out, `scope=${scope}`).toContain('私聊原文');
      expect(out, `scope=${scope}`).not.toContain('WebUI原文');
    }
  });

  it('别的会话设成仅本会话不影响这个会话：按插件配置', async () => {
    const { assembly } = await setup({ scope: 'cross-platform' }, { [PRIV]: { scope: 'session' } });
    expect(await passive(assembly)).toContain('WebUI原文');
  });

  it('会话设置不在：按插件配置，工具要更宽的也不放宽，要更窄的照给', async () => {
    const { assembly, recentMessages } = await setup({ scope: 'same-platform' });
    const block = await passive(assembly);
    expect(block).toContain('私聊原文');
    expect(block).not.toContain('WebUI原文');
    expect(await recentMessages({ scope: 'cross-platform' }, callCtx)).not.toContain('WebUI原文');

    const wide = await setup({ scope: 'cross-platform' });
    expect(await wide.recentMessages({}, callCtx)).toContain('WebUI原文');
    expect(await wide.recentMessages({ scope: 'same-platform' }, callCtx)).not.toContain('WebUI原文');
  });

  it('写坏了按最窄：会话层或插件配置里的坏值都不查其他会话，不回落到更宽的层', async () => {
    const atSession = await setup({ scope: 'cross-platform' }, { [CUR]: { scope: 'everything' } });
    expect(await passive(atSession.assembly)).toBeUndefined();
    expect(await atSession.recentMessages({ scope: 'cross-platform' }, callCtx)).toContain(
      '本会话的跨会话历史范围限于本会话',
    );

    const atGlobal = await setup({ scope: 'everything' });
    expect(await passive(atGlobal.assembly)).toBeUndefined();
    expect(await atGlobal.recentMessages({}, callCtx)).not.toContain('私聊原文');
  });
});
