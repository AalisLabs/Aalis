import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { provideHostLanguage } from '../fixtures/host-language.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 事实提取的提示词：每条事实的语言取自全局层的语言列表（经 api-i18n 的 outputLanguageFor，读者是 host），不写死中文；
// 长度上限按字符计。会话管理的替身里会话读者是 en（没设），读者错按会话时变成 English。提取模型用替身，记下收到的 system 消息
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:g1';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('plugin-user-profile: 事实的语言', () => {
  it('全局层设 ja-JP：system 写「一句简洁的 日本語 (日本)（ja-JP）」，上限按字符', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, events, memory });
    const systems: string[] = [];
    const chat = vi.fn(async (req: { messages: { role: string; content: string }[] }) => {
      systems.push(req.messages.find(m => m.role === 'system')?.content ?? '');
      return { content: '{"add": [], "update": [], "remove": []}' };
    });
    host.provide.use(llm, { id: 'stub-model', capabilities: ['chat'], chat } as never);
    provideHostLanguage(app, ['ja-JP']);
    await app.plugin(i18nPlugin);
    await app.plugin(memoryInMemory);
    await app.plugins.idle();
    await app.plugin(userProfile, { extractEveryNMessages: 1, relationIncrementWitness: 0, maxFactCharsPerItem: 80 });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(userProfile.name)?.state, 'user-profile 未激活').toBe('active');
    await host.memory.use.saveMessage(SESSION, {
      role: 'user',
      content: 'I like cats',
      metadata: { userId: 'u1', platform: 'onebot' },
    });

    await host.events.use.emit('inbound:message:archived', {
      sessionId: SESSION,
      incoming: { userId: 'u1', platform: 'onebot' },
    } as never);
    await vi.waitFor(() => expect(chat).toHaveBeenCalled());

    expect(systems[0]).toContain('5. 每条 text 用一句简洁的 日本語 (日本)（ja-JP），不超过 80 个字符，');
    expect(systems[0]).not.toContain('简洁中文');
  });
});
