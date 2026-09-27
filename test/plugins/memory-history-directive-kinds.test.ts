import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, logger, provide, services } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryHistory from '../../packages/plugin-memory-history/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { type Message, WellKnownKinds } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 跨会话注入不带指令类消息（安全）。
//
// 宿主通知（白纸的完成通知、后台命令结束通知）与代发任务的指令归档为 notice，kind 属于 DIRECTIVE_KINDS。
// 它们只对所在会话的那一轮有意义；memory-history 按 user、assistant、notice 取别的会话的近期消息，
// 不排除这些 kind 时，试点群的宿主通知正文会进同平台其他会话（包括 owner 私聊）的 turn-context，
// recent_messages 也能读出来。普通 notice（戳一戳等事件）照旧带上。
// ════════════════════════════════════════════════════════════

/** 当前会话：owner 的私聊（占位号） */
const OWNER_PRIVATE = 'onebot:10000:private:30001';
/** 试点群（占位号） */
const PILOT = 'onebot:10000:group:20001';

const HOST_NOTICE = '白纸任务占位已完成，宿主通知正文占位';
const DELEGATION = '代发任务指令占位';
const PLAIN_NOTICE = '群友占位戳了戳你';

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
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
  const seeds: Message[] = [
    { role: 'user', content: '试点群原文', timestamp: baseTs + 1, metadata: { platform: 'onebot' } },
    {
      role: 'notice',
      kind: WellKnownKinds.HostNotice,
      content: HOST_NOTICE,
      timestamp: baseTs + 2,
      metadata: { platform: 'onebot', hostNoticeKind: 'paper-task' },
    },
    {
      role: 'notice',
      kind: WellKnownKinds.CrossSessionDelegation,
      content: DELEGATION,
      timestamp: baseTs + 3,
      metadata: { platform: 'onebot' },
    },
    { role: 'notice', kind: 'poke', content: PLAIN_NOTICE, timestamp: baseTs + 4, metadata: { platform: 'onebot' } },
    { role: 'assistant', content: '试点群回复原文', timestamp: baseTs + 5, metadata: { platform: 'onebot' } },
  ];
  for (const message of seeds) await memory.saveMessage(PILOT, message);

  const toolHandlers = new Map<string, ToolHandler>();
  host.provide(tools, {
    register: (tool: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      toolHandlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugin(memoryHistory, { maxAgeMinutes: 0, perSessionLimit: 0 });
  await app.plugins.idle();
  if (app.plugins.getPlugin(memoryHistory.name)?.state !== 'active') throw new Error('plugin-memory-history 未激活');
  const recentMessages = toolHandlers.get('recent_messages');
  if (!recentMessages) throw new Error('recent_messages 未注册');
  return { assembly, recentMessages };
}

describe('plugin-memory-history：跨会话读取排除指令类 kind（安全）', () => {
  it('被动注入：试点群的宿主通知与代发任务指令不进 owner 私聊的 turn-context，普通消息与普通通知照旧', async () => {
    const { assembly } = await setup();
    const messages: Message[] = [{ role: 'user', content: 'now' }];
    await assemblePromptContributions(assembly, { messages, sessionId: OWNER_PRIVATE, platform: 'onebot' });
    const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-history'))?.content;
    expect(typeof block).toBe('string');
    expect(block).toContain('试点群原文');
    expect(block).toContain('试点群回复原文');
    expect(block).toContain(PLAIN_NOTICE);
    expect(block).not.toContain(HOST_NOTICE);
    expect(block).not.toContain(DELEGATION);
  });

  it('recent_messages：同样读不到别的会话的宿主通知与代发任务指令', async () => {
    const { recentMessages } = await setup();
    for (const scope of ['same-platform', 'cross-platform']) {
      const out = await recentMessages({ scope }, { sessionId: OWNER_PRIVATE, platform: 'onebot' });
      expect(out, `scope=${scope}`).toContain('试点群原文');
      expect(out, `scope=${scope}`).toContain(PLAIN_NOTICE);
      expect(out, `scope=${scope}`).not.toContain(HOST_NOTICE);
      expect(out, `scope=${scope}`).not.toContain(DELEGATION);
    }
  });
});
