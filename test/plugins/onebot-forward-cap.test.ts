import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger, ServiceSelection } from '../../packages/core/src/index.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import { ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// `<forward id=...>` 的 id 来自对**正文**的正则扫描，而 text 段在 segmentsToText 里原样透传
// （types.ts 的 case 'text'）——群里任何人发一条纯文本就能伪造任意多个标记，且展开发生在
// 触发策略之前，无需 @ 机器人。展开是 Promise.all 逐 id 并发，每个还按 maxDepth ×
// maxNodesPerLevel 继续下探：一条消息即可放大成数百次协议端 RPC。
// ════════════════════════════════════════════════════════════

const CFG: ForwardConfig = {
  enabled: true,
  maxDepth: 3,
  maxNodesPerLevel: 30,
  imageRecognition: false,
  imageRecognitionConcurrency: 8,
  recognitionMaxItems: 32,
  summarize: false,
  summaryMaxChars: 500,
  summaryInputLimit: 0,
};

/** 无提供者的服务引用：本用例只数协议端请求，memory/media/llm/storage/process 一律缺席。 */
function absentRef<P>(): ServiceSelection<P> {
  return ref();
}

/** fetch 是实现端对 get_forward_msg 的回应（缺省回 null，即拉不到内容），cfg 并进展开配置 */
function setup(fetch: (params: Record<string, unknown>) => Promise<unknown> = async () => null, cfg = {}) {
  const asked: string[] = [];
  const params: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const logger: Logger = {
    info: (m: string) => logs.push(m),
    warn() {},
    debug() {},
    error() {},
    child: () => logger,
  };
  const expander = createForwardExpander<null>({
    logger,
    memory: absentRef(),
    media: absentRef(),
    llm: absentRef(),
    i18n: absentRef(),
    storage: absentRef<StorageService>().use,
    processService: absentRef(),
    forwardCfg: { ...CFG, ...cfg },
    attachmentMaxBytes: 1024 * 1024,
    sendAction: async (_state, _action, sent) => {
      asked.push(String((sent as { id?: unknown }).id ?? ''));
      params.push(sent);
      return fetch(sent);
    },
  });
  return { expander, asked, params, logs };
}

const marker = (id: string) => `<forward id="${id}">[合并转发消息]</forward>`;

describe('合并转发展开的数量上限', () => {
  it('正文伪造大量标记时，展开次数被封顶而不是逐个发 RPC', async () => {
    const { expander, asked, logs } = setup();
    const text = Array.from({ length: 40 }, (_, i) => marker(`fake${i}`)).join('\n');

    await expander.expandForwardsInText(null, text, undefined, 'onebot:1:group:2');

    const distinct = new Set(asked);
    expect(distinct.size, `40 个伪造标记不该换来 ${distinct.size} 次协议端请求`).toBeLessThanOrEqual(8);
    expect(
      logs.some(l => l.includes('超上限')),
      '封顶时应出声，便于运维发现',
    ).toBe(true);
  });

  it('正常数量的转发照常全部展开', async () => {
    const { expander, asked } = setup();
    const text = [marker('a'), marker('b')].join('\n');

    await expander.expandForwardsInText(null, text, undefined, 'onebot:1:group:2');
    expect(new Set(asked).size, '真实消息里的少量转发不能被误伤').toBe(2);
  });
});

describe('合并转发的拉取与缓存', () => {
  it('拉取失败时只按标准参数名 id 拉一次，不换参数键重试', async () => {
    const { expander, params } = setup(async () => {
      throw new Error('<占位原话>');
    });
    const out = await expander.expandForwardsInText(null, marker('f1'), undefined, 'onebot:1:group:2');
    expect(params).toEqual([{ id: 'f1' }]);
    expect(out).toContain('拉取失败');
  });

  it('节点超限的转发：内存缓存命中时重建的信封照样带截断标志', async () => {
    const node = (text: string) => ({ type: 'node', data: { nickname: '甲', user_id: 1, content: text } });
    const { expander, params } = setup(async () => ({ messages: [node('一'), node('二'), node('三')] }), {
      maxNodesPerLevel: 2,
    });
    const first = await expander.expandForwardsInText(null, marker('f1'), undefined, 'onebot:1:group:2');
    const second = await expander.expandForwardsInText(null, marker('f1'), undefined, 'onebot:1:group:2');
    expect(params, '第二次走内存缓存').toHaveLength(1);
    expect(first).toContain('truncatedNodes');
    expect(second).toContain('truncatedNodes');
  });
});
