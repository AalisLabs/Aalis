import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../../packages/api-i18n/src/index.js';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { MediaService } from '../../packages/api-media/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { ProcessService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger } from '../../packages/core/src/index.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { withForwards } from '../../packages/schema-message/src/index.js';
import { provideHostLanguage } from '../fixtures/host-language.js';
import { provideEvents } from '../fixtures/hubs.js';
import { fixedRef } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 合并转发摘要的输出语言取自全局层的语言列表（经 api-i18n 的 outputLanguageFor，读者是 host），不写死简体中文；
// 目标长度按字符计。会话管理的替身里会话读者是 en（没设），读者错按会话时变成 English。摘要模型用替身，记下收到的消息
// ════════════════════════════════════════════════════════════

const logger: Logger = { info() {}, warn() {}, debug() {}, error() {}, child: () => logger };

const CFG: ForwardConfig = {
  enabled: true,
  maxDepth: 3,
  maxNodesPerLevel: 30,
  imageRecognition: false,
  imageRecognitionConcurrency: 1,
  recognitionMaxItems: 0,
  summarize: true,
  summaryMaxChars: 600,
  summaryInputLimit: 0,
};

const node = (nickname: string, text: string) => ({
  type: 'node',
  data: { nickname, user_id: '1', content: [{ type: 'text', data: { text } }] },
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('合并转发摘要的提示词', () => {
  it('全局层设 ja-JP：system 写 日本語 (日本)（ja-JP），user 的目标长度按字符', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    provideEvents(app);
    apps.push(app);
    provideHostLanguage(app, ['ja-JP']);
    await app.plugin(i18nPlugin);
    await app.plugins.idle();
    const asked: Array<{ role: string; content: string }[]> = [];
    const model = {
      capabilities: ['chat'],
      chat: async (req: { messages: { role: string; content: string }[] }) => {
        asked.push(req.messages);
        return { content: '<摘要>' };
      },
    };
    const expander = createForwardExpander<null>({
      logger,
      memory: fixedRef<MemoryService>(undefined),
      media: fixedRef<MediaService>(undefined),
      llm: fixedRef(model as unknown as LLMModel),
      i18n: app.bind({ i18n }).i18n,
      storage: {} as StorageService,
      processService: fixedRef<ProcessService>(undefined),
      forwardCfg: CFG,
      attachmentMaxBytes: 1024,
      signal: new AbortController().signal,
      sendAction: async () => ({ messages: [node('甲', 'hello'), node('乙', 'hi')] }),
    });

    const out = withForwards(
      '<forward id="F1">[合并转发消息]</forward>',
      await expander.expandForwards(null, [{ type: 'forward', data: { id: 'F1' } }], 's'),
    );

    expect(out).toContain('<摘要>');
    const [system, user] = asked[0];
    expect(system.content).toContain(
      '给定一段合并转发的原始内容，用 日本語 (日本)（ja-JP）输出一段含多人互动细节的摘要：',
    );
    expect(system.content).not.toContain('简体中文');
    expect(user.content).toContain('目标字数：≤600 个字符（可超出 10% 以完整保留互动结构）。');
  });
});
