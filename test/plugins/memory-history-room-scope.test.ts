import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { type MemoryRecallScope, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, logger, provide, services } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { roomScopeManager } from '../fixtures/room-scope.js';

// ════════════════════════════════════════════════════════════
// 召回按房间收窄（memory-history）：插件每轮把其他会话的近期原文注入 turn-context，
// recent_messages 也能按需查。试点群设成 session 后这两处都不做跨会话查询；
// 设成 platform 时最多同平台，插件配置或工具参数写 cross-platform 也不放宽。
// session-manager 不在场或房间未设置时维持插件配置。
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

async function setup(
  pluginConfig: Record<string, unknown>,
  room?: { rooms?: Record<string, MemoryRecallScope>; profiles?: Record<string, MemoryRecallScope> },
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, services });
  const assembly = app.bind({ contributions, logger });
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const memory = host.services.get(memoryService);
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

  if (room) host.provide(sessionManager, roomScopeManager(room.rooms, room.profiles));
  const toolHandlers = new Map<string, ToolHandler>();
  host.provide(tools, {
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

describe('plugin-memory-history: 召回按房间收窄', () => {
  it('插件 same-platform、房间 session：被动注入不交料，recent_messages 被拒', async () => {
    const { assembly, recentMessages } = await setup({ scope: 'same-platform' }, { rooms: { [CUR]: 'session' } });
    expect(await passive(assembly)).toBeUndefined();
    for (const scope of [undefined, 'same-platform', 'cross-platform']) {
      const out = await recentMessages(scope ? { scope } : {}, callCtx);
      expect(out, `scope=${scope}`).toContain('本房间的召回范围限于本会话');
      expect(out).not.toContain('私聊原文');
      expect(out).not.toContain('别的群原文');
      expect(out).not.toContain('WebUI原文');
    }
  });

  it('平台档写 session、房间未写：按会话所属平台解析，同样不做跨会话查询', async () => {
    const { assembly, recentMessages } = await setup({ scope: 'same-platform' }, { profiles: { onebot: 'session' } });
    expect(await passive(assembly)).toBeUndefined();
    expect(await recentMessages({}, callCtx)).toContain('本房间的召回范围限于本会话');
  });

  it('插件 cross-platform、房间 platform：别的平台不进注入与工具结果', async () => {
    const { assembly, recentMessages } = await setup({ scope: 'cross-platform' }, { rooms: { [CUR]: 'platform' } });
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

  it('房间写 all：放不宽插件的 same-platform', async () => {
    const { assembly } = await setup({ scope: 'same-platform' }, { rooms: { [CUR]: 'all' } });
    const block = await passive(assembly);
    expect(block).toContain('私聊原文');
    expect(block).not.toContain('WebUI原文');
  });

  it('session-manager 不在场：行为与插件配置一致', async () => {
    const { assembly, recentMessages } = await setup({ scope: 'same-platform' });
    const block = await passive(assembly);
    expect(block).toContain('私聊原文');
    expect(block).not.toContain('WebUI原文');
    // 工具参数照旧可以指定 cross-platform
    expect(await recentMessages({ scope: 'cross-platform' }, callCtx)).toContain('WebUI原文');
  });
});
