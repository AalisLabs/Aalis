import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { memory as memoryService } from '../../packages/api-memory/src/index.js';
import { App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// "模型卡壳重复回复"守卫在启用 outputFormat 的人设下必须照样成立。
//   落库口径是 archiveContent（persona 规范化后的整串 JSON），历史侧没有任何
//   assistant 解码路径；旧实现拿解码后的纯文本去比历史里的 JSON，于是守卫永不命中——
//   生产 aalis.yaml 正卡在 outputFormat 上。
// 两种人设都要覆盖：服务端解码（clientSideJsonRendering 缺省）与客户端渲染（=true，
// content 本身就是整串 JSON，但模型的原始排版与 JSON.stringify 结果并不逐字相同）。
// 真 fs 角色卡 + mock LLM 连发两次同一 JSON，断言第二轮不外发。
// ════════════════════════════════════════════════════════════

const AGENT_CONFIG = {
  systemPrompt: 'test',
  historyLimit: 50,
  memoryTokenBudget: 1024,
  maxToolIterations: 5,
  toolResultMaxRatio: 0.15,
  trimThresholdRatio: 1.0,
  preferredModel: '',
};

/** 模型两轮都吐同一段 JSON（故意带缩进：与 JSON.stringify 的紧凑排版不逐字相同） */
const RAW_JSON = '{\n  "mood": "平静",\n  "message": "你好呀"\n}';

const cardYaml = (clientSide: boolean): string =>
  [
    'name: zz-fmt',
    'description: 结构化输出人设',
    'prompt: 按 JSON 输出。',
    `clientSideJsonRendering: ${clientSide}`,
    'outputFormat:',
    '  mood:',
    '    description: 心情',
    '  message:',
    '    description: 回复正文',
    '    reply: true',
    '',
  ].join('\n');

/** 宿主侧绑定：出站事件的观测口 + 回合驱动与历史核对所需的两个服务 */
const bindHost = (app: App) => app.bind({ events, agent: agentService, memory: memoryService });

describe('agent 重复回复守卫（outputFormat 人设 · 真 fs 角色卡）', () => {
  let base: string;
  let app: App;
  let host: ReturnType<typeof bindHost>;

  const boot = async (clientSide: boolean): Promise<{ sent: OutgoingMessage[]; sessionId: string }> => {
    writeFileSync(join(base, 'personas', 'zz-fmt.yaml'), cardYaml(clientSide));
    app = new App({ name: 'T', logLevel: 'error' });
    await app.plugin(storageLocalPlugin, {
      roots: [
        {
          name: 'data',
          path: base,
          label: 'data',
          kind: 'data',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.plugin(createMockLLMPlugin({ responses: [{ content: RAW_JSON }] }));
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(personaPlugin, { persona: 'zz-fmt', personasDir: 'data/personas' });
    await app.plugin(agentPlugin, AGENT_CONFIG);
    await app.plugins.idle();
    // 装载过激活闸：依赖没凑齐的插件停在 pending 而不报错，会让「守卫根本没跑」伪装成绿
    for (const id of [storageLocalPlugin.name, personaPlugin.name, agentPlugin.name]) {
      const state = app.plugins.getPlugin(id)?.state;
      if (state !== 'active') throw new Error(`插件 ${id} 未激活（state=${state}）`);
    }

    host = bindHost(app);

    const sent: OutgoingMessage[] = [];
    host.events.on('outbound:message', msg => {
      sent.push(msg);
    });
    return { sent, sessionId: `test:dup-${clientSide ? 'client' : 'server'}` };
  };

  const say = async (sessionId: string): Promise<void> => {
    await host.agent.require().handleMessage({
      content: '你好',
      sessionId,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-dup-reply-'));
    mkdirSync(join(base, 'personas'), { recursive: true });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('服务端解码人设：第二轮同一 JSON 不再外发', async () => {
    const { sent, sessionId } = await boot(false);
    await say(sessionId);
    expect(sent.map(m => m.content)).toEqual(['你好呀']); // 首轮解码后的纯文本

    await say(sessionId);
    expect(sent.length, '第二轮应被重复守卫拦下').toBe(1);

    // 历史里只留一条 assistant，且是整串 JSON（落库口径 = archiveContent）
    const history = await host.memory.require().getHistory(sessionId, 50);
    const assistants = history.filter(m => m.role === 'assistant');
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toBe(JSON.stringify({ mood: '平静', message: '你好呀' }));
  });

  it('客户端渲染人设：第二轮同一 JSON 不再外发', async () => {
    const { sent, sessionId } = await boot(true);
    await say(sessionId);
    expect(sent.length).toBe(1);
    expect(sent[0].content).toContain('"message"'); // 客户端渲染：整串 JSON 直接外发

    await say(sessionId);
    expect(sent.length, '第二轮应被重复守卫拦下').toBe(1);
  });
});
