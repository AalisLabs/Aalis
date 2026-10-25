import { afterEach, describe, expect, it } from 'vitest';
import { type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import type { ChatModelRequest, ChatResponse, LLMModel } from '../../packages/api-llm/src/index.js';
import type { MediaService } from '../../packages/api-media/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { ProcessService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger, type ServiceSelection } from '../../packages/core/src/index.js';
import { buildEnvelope, type ExpandedForward } from '../../packages/plugin-adapter-onebot/src/forward.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { provideHostLanguage } from '../fixtures/host-language.js';
import { fixedRef } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 摘要不可用时，合并转发的信封退化为截断的原文。信封随消息归档、进 agent 上下文与 Laya 的请求，
// 截断必须代理安全：截在 emoji 中间留下的孤代理会让严格的 JSON 解析器或分词器拒收。
// ════════════════════════════════════════════════════════════

const expanded = (fullText: string): ExpandedForward => ({
  id: 'f1',
  count: 1,
  participants: ['甲(10001)'],
  fullText,
  truncatedDepth: false,
  truncatedNodes: false,
});

const SUFFIX = '\n…（已截断，原文保留在缓存中）';

describe('buildEnvelope：摘要不可用时的截断', () => {
  it('截断边界落在 emoji 中间：整字符丢弃，不留孤代理', () => {
    const envelope = buildEnvelope(expanded(`${'a'.repeat(599)}😀之后`), null);
    expect(envelope).not.toMatch(/\p{Cs}/u);
    expect(envelope).toContain(`${'a'.repeat(599)}${SUFFIX}`);
  });

  it('不超过上限原样放入；超过时按上限截断并注明', () => {
    expect(buildEnvelope(expanded('短原文'), null)).toBe(
      '<forward id="f1" count=1 participants="甲(10001)">\n短原文\n</forward>',
    );
    expect(buildEnvelope(expanded('x'.repeat(601)), null)).toContain(`${'x'.repeat(600)}${SUFFIX}\n</forward>`);
  });
});

// ════════════════════════════════════════════════════════════
// 摘要的输出上限只防失控：max(2048, 3×summaryMaxChars)，默认 600 字时为 2048。摘要模型因上限停下（finishReason 'length'）
// 时，信封里的摘要末尾标出「已在长度上限处截断」，按 host 读者的语言（与摘要的输出语言同一读者）；带标记的摘要进转发缓存。
// 摘要模型用替身，记下收到的请求
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

/** 展开一条转发：摘要替身回 finishReason，返回信封、摘要请求与缓存里的条目；cfg 并进展开配置 */
async function expand(
  finishReason: ChatResponse['finishReason'],
  i18nSelection: ServiceSelection<I18nService>,
  cfg: Partial<ForwardConfig> = {},
) {
  const requests: ChatModelRequest[] = [];
  const model = {
    capabilities: ['chat'],
    chat: async (request: ChatModelRequest) => {
      requests.push(request);
      return { content: '甲和乙在打招呼', finishReason };
    },
  };
  const expander = createForwardExpander<null>({
    logger,
    memory: fixedRef<MemoryService>(undefined),
    media: fixedRef<MediaService>(undefined),
    llm: fixedRef(model as unknown as LLMModel),
    i18n: i18nSelection,
    storage: {} as StorageService,
    processService: fixedRef<ProcessService>(undefined),
    forwardCfg: { ...CFG, ...cfg },
    attachmentMaxBytes: 1024,
    sendAction: async () => ({ messages: [node('甲', 'hello'), node('乙', 'hi')] }),
  });
  const id = `F-${finishReason}`;
  const envelope = await expander.expandForwardsInText(
    null,
    `<forward id="${id}">[合并转发消息]</forward>`,
    [{ type: 'forward', data: { id } }],
    's',
  );
  return { envelope, requests, cached: await expander.getOrLoadForward(id) };
}

describe('合并转发摘要在长度上限处停下', () => {
  it('报 length：信封与缓存里的摘要末尾带标记，请求的输出上限是 2048', async () => {
    const { envelope, requests, cached } = await expand('length', fixedRef<I18nService>(undefined));
    expect(envelope).toContain('甲和乙在打招呼（已在长度上限处截断）\n</forward>');
    expect(cached?.summary).toBe('甲和乙在打招呼（已在长度上限处截断）');
    expect(requests[0].maxTokens).toBe(2048);
  });

  it('摘要目标字数大时输出上限取它的 3 倍', async () => {
    const { requests } = await expand('stop', fixedRef<I18nService>(undefined), { summaryMaxChars: 1000 });
    expect(requests[0].maxTokens).toBe(3000);
  });

  it('报 stop：不带标记', async () => {
    const { envelope } = await expand('stop', fixedRef<I18nService>(undefined));
    expect(envelope).toContain('甲和乙在打招呼\n</forward>');
  });

  it('全局层设 en：标记按 host 读者的语言', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    provideHostLanguage(app, ['en']);
    await app.plugin(i18nPlugin);
    await app.plugins.idle();
    const { envelope } = await expand('length', app.bind({ i18n }).i18n);
    expect(envelope).toContain('甲和乙在打招呼 (cut off at the length limit)\n</forward>');
  });
});
