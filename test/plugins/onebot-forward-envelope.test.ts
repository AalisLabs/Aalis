import { afterEach, describe, expect, it } from 'vitest';
import { type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import type { ChatModelRequest, ChatResponse, LLMModel } from '../../packages/api-llm/src/index.js';
import type { MediaService } from '../../packages/api-media/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { ProcessService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger, type ServiceSelection } from '../../packages/core/src/index.js';
import { type ExpandedForward, forwardedChat } from '../../packages/plugin-adapter-onebot/src/forward.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { withForwards } from '../../packages/schema-message/src/index.js';
import { provideHostLanguage } from '../fixtures/host-language.js';
import { fixedRef } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 一段转发交出给模型的展开（信封）与给界面的事实，两样出自同一份事实。摘要不可用时，信封与事实的文字退化为截断的原文。信封随
// 消息归档、进 agent 上下文与 Laya 的请求，截断必须代理安全：截在 emoji 中间留下的孤代理会让严格的 JSON 解析器或分词器拒收。
// 「摘要：」「人未列出」「已截断」这些给模型的字只在信封里，不进事实。
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

describe('forwardedChat：信封与给界面的事实', () => {
  it('截断边界落在 emoji 中间：整字符丢弃，不留孤代理', () => {
    const envelope = forwardedChat(expanded(`${'a'.repeat(599)}😀之后`), null).content;
    expect(envelope).not.toMatch(/\p{Cs}/u);
    expect(envelope).toContain(`${'a'.repeat(599)}${SUFFIX}`);
  });

  it('不超过上限原样放入；超过时按上限截断并注明', () => {
    expect(forwardedChat(expanded('短原文'), null).content).toBe(
      '<forward id="f1" count=1 participants="甲(10001)">\n短原文\n</forward>',
    );
    const full = forwardedChat(expanded('x'.repeat(600)), null);
    expect(full.content).toBe(`<forward id="f1" count=1 participants="甲(10001)">\n${'x'.repeat(600)}\n</forward>`);
    expect(full.facts).toEqual({ count: 1, participants: ['甲(10001)'], text: 'x'.repeat(600) });
    expect(forwardedChat(expanded('x'.repeat(601)), null).content).toContain(`${'x'.repeat(600)}${SUFFIX}\n</forward>`);
  });

  it('事实：条数、参与者与原文；原文超过上限时是截断处之前的那段并标出截断', () => {
    const short = forwardedChat(expanded('短原文'), null);
    expect(short.id).toBe('f1');
    expect(short.facts).toEqual({ count: 1, participants: ['甲(10001)'], text: '短原文' });
    expect(forwardedChat(expanded('x'.repeat(601)), null).facts).toEqual({
      count: 1,
      participants: ['甲(10001)'],
      text: 'x'.repeat(600),
      cutOff: true,
    });
  });

  it('有摘要：信封正文写「摘要：」加摘要，事实的文字只是摘要', () => {
    const chat = forwardedChat(expanded('原文'), '说了三件事');
    expect(chat.content).toBe('<forward id="f1" count=1 participants="甲(10001)">\n摘要：说了三件事\n</forward>');
    expect(chat.facts?.text).toBe('说了三件事');
  });

  it('参与者多于 8 个：信封头一行末尾照旧写没列出的人数，事实另记人数', () => {
    const names = Array.from({ length: 8 }, (_, i) => `p${i}(${i})`);
    const chat = forwardedChat({ ...expanded('原文'), count: 11, participants: names, unlisted: 3 }, null);
    expect(chat.content.split('\n')[0]).toBe(
      `<forward id="f1" count=11 participants="${names.join(', ')}, ...(+3 人未列出)">`,
    );
    expect(chat.facts).toEqual({ count: 11, participants: names, unlisted: 3, text: '原文' });
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

/** 展开一条转发：实现端对 get_forward_msg 回 reply，摘要替身回 finishReason；返回交出的各项、拼回的信封、摘要请求与缓存里的条目；cfg 并进展开配置 */
async function expand(
  finishReason: ChatResponse['finishReason'],
  i18nSelection: ServiceSelection<I18nService>,
  cfg: Partial<ForwardConfig> = {},
  reply: unknown = { messages: [node('甲', 'hello'), node('乙', 'hi')] },
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
    sendAction: async () => reply,
  });
  const id = `F-${finishReason}`;
  const forwards = await expander.expandForwards(null, [{ type: 'forward', data: { id } }], 's');
  const envelope = withForwards(`<forward id="${id}">[合并转发消息]</forward>`, forwards);
  return { forwards, envelope, requests, cached: await expander.getOrLoadForward(id) };
}

describe('合并转发摘要在长度上限处停下', () => {
  it('配置项 summaryMaxChars 叫「摘要最大字符数」（上限按字符数算）', () => {
    const { forward } = onebotPlugin.configSchema as unknown as {
      forward: { fields: { summaryMaxChars: { label: unknown } } };
    };
    expect(toSource(forward.fields.summaryMaxChars.label)).toBe('摘要最大字符数');
  });

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

// ════════════════════════════════════════════════════════════
// 摘要请求里的参与人与给模型的信封同一写法（前 8 个，多的写没列出的人数）。顶层转发什么也没展开出来（实现端回成功，数据却为空
// 或没有节点）与拉取失败同一条规则：不带给界面的事实、不进缓存、不拿那一行去调摘要，信封照常写出那一行
// ════════════════════════════════════════════════════════════

describe('合并转发的摘要请求与什么也没展开出来的转发', () => {
  it('参与者多于 8 个：摘要请求照旧写前 8 个与没列出的人数', async () => {
    const people = Array.from({ length: 10 }, (_, i) => ({
      type: 'node',
      data: { nickname: `p${i}`, user_id: String(i), content: [{ type: 'text', data: { text: '在' } }] },
    }));
    const { requests } = await expand('stop', fixedRef<I18nService>(undefined), {}, { messages: people });
    const listed = people.slice(0, 8).map((_, i) => `p${i}(${i})`);
    expect(String(requests[0].messages[1].content)).toContain(`主要参与人：${listed.join(', ')}, ...(+2 人未列出)。`);
  });

  it.each([
    ['数据为空', null, '拉取失败'],
    ['没有节点', { messages: [] }, '内容为空'],
  ])('实现端回成功但%s：不带事实、不进缓存、不调摘要，信封写出那一行', async (_, reply, line) => {
    const { forwards, requests, cached } = await expand('stop', fixedRef<I18nService>(undefined), {}, reply);
    expect(forwards).toEqual([
      {
        id: 'F-stop',
        content: `<forward id="F-stop" count=0 participants="">\n0. 系统: [嵌套合并转发 id=F-stop ${line}]\n</forward>`,
      },
    ]);
    expect(cached).toBeUndefined();
    expect(requests).toEqual([]);
  });
});
