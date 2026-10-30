import { describe, expect, it, vi } from 'vitest';
import type { AuthorityService } from '../../packages/api-authority/src/index.js';
import type { BoundCommands } from '../../packages/api-commands/src/index.js';
import type { Audience, I18nService } from '../../packages/api-i18n/src/index.js';
import type { PlatformAdapter } from '../../packages/api-platform/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import { type EvictionConfig, registerRelationCommands } from '../../packages/plugin-user-relation/src/commands.js';
import type { RelationService } from '../../packages/plugin-user-relation/src/index.js';
import { localize, resolveText } from '../../packages/schema-i18n/src/index.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// /relation 的长任务先往当前会话推一句「正在跑」：有平台适配器认领这个会话才推（定时任务以 internal 平台发进群里的
// 也推），没有认领者的不推，也不留推送失败的日志。不按平台名判。这一句按这个会话（读者只带会话 id）的语言渲染再推；渲染出错
// 时按原文推，只告警一次。长任务的结果与整理状态按会话的语言回复。i18n 是替身：一律按 language 渲染，记下各次的读者；关系图
// 服务是替身，各项计数取互不相同的数。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;

/** 一次整理的结果 */
const CONSOLIDATED = {
  aliasCandidates: [{ aKind: 'entity', aId: 'zz-a', bKind: 'entity', bId: 'zz-b', reason: '<占位理由>' }],
  aliasEdgesCreated: 2,
  eventEdgesNormalized: 3,
  entityHierarchyCandidates: 4,
  entityHierarchyEdgesCreated: 5,
  lateralParentCandidates: 6,
  lateralParentsCreated: 7,
  lateralEdgesCreated: 8,
  llmVerified: 9,
  llmRejected: 10,
  summariesRewritten: 11,
};

/** 关系图的规模：人物、事件、实体、边各几个 */
const graphOf = (persons: number, events: number, entities: number, edges: number) => ({
  persons: Array(persons),
  events: Array(events),
  entities: Array(entities),
  edges: Array(edges),
});

/** 最近一次整理的时刻：按跑测试的进程时区构造 */
const AT = new Date(2026, 9, 29, 6, 5, 3).getTime();
const COUNTS = {
  aliasCandidates: 1,
  aliasEdgesCreated: 2,
  eventEdgesNormalized: 3,
  entityHierarchyCandidates: 4,
  entityHierarchyEdgesCreated: 5,
  lateralParentCandidates: 6,
  lateralParentsCreated: 7,
  lateralEdgesCreated: 8,
  eventDuplicateCandidates: 0,
  eventDuplicatesMerged: 0,
};

/**
 * language 是会话的语言；render 给了就顶替 i18n 的渲染。lastConsolidations 是依次交出的最近一次整理（用完了是没整理过），
 * snapshots 是依次读到的全图，maxPersons 是淘汰的人物上限（0 是没配淘汰阈值、体检只清孤儿）
 */
function world({
  language = 'zh-CN',
  render,
  lastConsolidations = [],
  snapshots = [],
  maxPersons = 100,
}: {
  language?: string;
  render?: I18nService['render'];
  maxPersons?: number;
  lastConsolidations?: unknown[];
  snapshots?: unknown[];
} = {}) {
  /** /relation 自己的日志（指令注册表的另用 silent） */
  const logs: string[] = [];
  const at = (level: string) => (message: string) => void logs.push(`${level} ${message}`);
  const logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } as unknown as Logger;
  const sendMessage = vi.fn(async (_sessionId: string, _content: string) => {});
  const onebot: PlatformAdapter = {
    adapterName: 'onebot',
    platform: 'onebot',
    getConnections: () => [],
    sendMessage,
    canHandle: id => id.startsWith('onebot:10000:'),
  };
  const audiences: Audience[] = [];
  const i18n = fixedRef({
    render:
      render ??
      ((value: unknown, audience: Audience) => {
        audiences.push(audience);
        return localize(value, text => resolveText(text, [language]));
      }),
  } as unknown as I18nService);
  const owner = { authorize: () => null } as unknown as AuthorityService;
  const registry = new CommandRegistry(silent, fixedRef(owner), i18n);
  registry.setExecutionGuard(async () => ({ ok: true }));
  const commands = {
    command: (name: string, description?: string, meta?: object) =>
      registry.command(name, description, { ...meta, pluginName: 'relation' }),
  } as unknown as BoundCommands;
  const service = {
    rewriteWeights: async () => ({ skipped: true }),
    consolidate: async () => CONSOLIDATED,
    loadAll: async () => snapshots.shift(),
    evictByQuota: async () => ({}),
    pruneOrphans: async () => ({}),
    getLastConsolidateInfo: () => lastConsolidations.shift(),
  } as unknown as RelationService;
  registerRelationCommands(
    {
      commands,
      platform: ref([{ instance: onebot, contextId: 'onebot:a' }]),
      llm: ref(),
      i18n,
      logger,
      sessionOnly: () => false,
    },
    service,
    {
      consolidateLLM: { modelRef: { provider: 'zz', model: 'zz-model' }, disableThinking: true },
      eviction: { maxPersons, weightDecayHalfLifeDays: 30, weightDecayFloor: 0.1 } as EvictionConfig,
      consolidateAutoLink: false,
      consolidateSkipLowScorePairs: false,
      consolidateLowScoreThreshold: 0,
    },
  );
  const run = async (sessionId: string, platform: string, ...args: string[]) => {
    const reply = await registry.execute('relation', { sessionId, platform, userId: 'console', args, raw: '' });
    await new Promise(resolve => setTimeout(resolve, 0));
    return reply;
  };
  return { logs, sendMessage, run, audiences };
}

describe('/relation 长任务的立即反馈', () => {
  it.each([
    ['有适配器认领的会话', 'onebot'],
    ['平台写 internal、有适配器认领的会话（定时任务发进群里）', 'internal'],
  ])('%s：推一句正在跑，按这个会话的语言渲染', async (_, platform) => {
    const { sendMessage, run, audiences } = world();
    expect(await run(GROUP, platform, 'rewrite-weights')).toBe('weight 衰减未启用，已跳过。');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(GROUP, '正在按 halfLifeDays=30、floor=0.1 回写 weight，请稍候…');
    expect(audiences).toContainEqual({ sessionId: GROUP });
  });

  it('没有适配器认领的会话：不推，不留推送失败的日志', async () => {
    const { logs, sendMessage, run } = world();
    expect(await run('session-zz000001', 'webui', 'rewrite-weights')).toBe('weight 衰减未启用，已跳过。');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('按会话的语言渲染出错：按原文推，告警只一次', async () => {
    const { logs, sendMessage, run } = world({
      render: () => {
        throw new Error('<占位渲染错误>');
      },
    });
    await run(GROUP, 'onebot', 'rewrite-weights');
    await run(GROUP, 'onebot', 'rewrite-weights');
    expect(sendMessage.mock.calls).toEqual([
      [GROUP, '正在按 halfLifeDays=30、floor=0.1 回写 weight，请稍候…'],
      [GROUP, '正在按 halfLifeDays=30、floor=0.1 回写 weight，请稍候…'],
    ]);
    expect(logs.filter(line => line.startsWith('warn'))).toEqual([
      'warn 按会话的语言渲染立即回执出错，按原文发出（之后再出错不再告警）:',
    ]);
  });
});

describe('/relation 整理与体检：立即反馈与结果按会话的语言', () => {
  /**
   * 整理与体检各一次，都不带选项：autoLink 关、LLM 开（两个参数取不同值），体检走到带 LLM 的整理一行与配了配额的压缩一行。
   * 先推的立即反馈与回复
   */
  async function consolidateAndMaintain(language: string) {
    const { sendMessage, run } = world({
      language,
      snapshots: [graphOf(40, 41, 42, 43), graphOf(30, 31, 32, 33), graphOf(20, 21, 22, 23)],
    });
    const replies = [await run(GROUP, 'onebot', 'consolidate')];
    replies.push(await run(GROUP, 'onebot', 'maintain'));
    return { acks: sendMessage.mock.calls.map(([, text]) => text), replies };
  }

  it('en', async () => {
    expect(await consolidateAndMaintain('en')).toEqual({
      acks: [
        'Consolidating the relation graph (autoLink=off, LLM=on), please wait…',
        'Running a checkup on the relation graph: consolidating, then compressing (autoLink=off, LLM=on), please wait…',
      ],
      replies: [
        [
          'Relation graph consolidated:',
          '- Alias candidate pairs: 1 (auto-link=off, is-alias-of edges created: 2)',
          '- EventEntityEdge deduplication, groups rewritten: 3',
          '- Entity hierarchy candidate pairs: 4, new entity-entity[part-of] edges: 5',
          '- Lateral parent candidate clusters: 6, new parent entities: 7, new lateral part-of edges: 8',
          '- LLM verification: 9 passed, 10 rejected; summaries rewritten: 11',
          '',
          'Alias candidates (first 10):',
          '  · [entity] zz-a  ↔  [entity] zz-b  —  <占位理由>',
        ].join('\n'),
        [
          'Relation graph checkup done:',
          '[1/2] Consolidate: people 40→30, events 41→31, entities 42→32, edges 43→33; aliases 1 candidates/2 edges, event edges rewritten 3, hierarchy 4 candidates/5 edges, lateral parents 6 clusters/7 created/8 edges, LLM passed 9, rejected 10, summaries rewritten 11',
          '[2/2] Compress: people 30→20, events 31→21, entities 32→22, edges 33→23',
        ].join('\n'),
      ],
    });
  });

  it('zh-CN 与改动前逐字相同', async () => {
    expect(await consolidateAndMaintain('zh-CN')).toEqual({
      acks: [
        '正在整理关系图（autoLink=off，LLM=on），请稍候…',
        '正在体检关系图：先整理再压缩（autoLink=off，LLM=on），请稍候…',
      ],
      replies: [
        [
          '关系图整理完成：',
          '- 别名候选：1 对（auto-link=off，已建 2 条 is-alias-of 边）',
          '- EventEntityEdge 去重：3 组重整',
          '- 实体层级候选：4 对，新增 5 条 entity-entity[part-of] 边',
          '- 侧向父候选：6 簇，新建父实体 7 个，新增 8 条侧向 part-of 边',
          '- LLM 核验：通过 9，否决 10；摘要重写 11 条',
          '',
          '别名候选（前 10 条）：',
          '  · [entity] zz-a  ↔  [entity] zz-b  —  <占位理由>',
        ].join('\n'),
        [
          '关系图体检完成：',
          '[1/2] 整理：人物 40→30，事件 41→31，实体 42→32，边 43→33；别名 1 候选/2 边，事件边重整 3，层级 4 候选/5 边，侧向父 6 簇/新建 7/边 8，LLM 通过 9 否决 10 摘要重写 11',
          '[2/2] 压缩：人物 30→20，事件 31→21，实体 32→22，边 33→23',
        ].join('\n'),
      ],
    });
  });

  it.each([
    [
      'en',
      'Running a checkup on the relation graph: consolidating, then compressing (autoLink=off, LLM=off), please wait…',
      [
        'Relation graph checkup done:',
        '[1/2] Consolidate: people 40→30, events 41→31, entities 42→32, edges 43→33; aliases 1 candidates/2 edges, event edges rewritten 3, hierarchy 4 candidates/5 edges, lateral parents 6 clusters/7 created/8 edges',
        '[2/2] Compress: orphans only (no eviction limits set) — people 30→20, events 31→21, entities 32→22, edges 33→23',
      ],
    ],
    [
      'zh-CN',
      '正在体检关系图：先整理再压缩（autoLink=off，LLM=off），请稍候…',
      [
        '关系图体检完成：',
        '[1/2] 整理：人物 40→30，事件 41→31，实体 42→32，边 43→33；别名 1 候选/2 边，事件边重整 3，层级 4 候选/5 边，侧向父 6 簇/新建 7/边 8',
        '[2/2] 压缩：仅清孤儿（未配置淘汰阈值）—人物 30→20，事件 31→21，实体 32→22，边 33→23',
      ],
    ],
  ])('%s：体检不带 LLM、没配淘汰阈值时整理一行不带 LLM，压缩只清孤儿', async (language, ack, reply) => {
    const { sendMessage, run } = world({
      language,
      maxPersons: 0,
      snapshots: [graphOf(40, 41, 42, 43), graphOf(30, 31, 32, 33), graphOf(20, 21, 22, 23)],
    });
    expect(await run(GROUP, 'onebot', 'maintain', '--no-llm')).toBe(reply.join('\n'));
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([ack]);
  });
});

describe('/relation consolidation-status 按会话的语言', () => {
  /** 没整理过，再依次是：手动、带重复与缓存命中；淘汰前自动、只有计数；API 调用、LLM 没有缓存命中 */
  async function statuses(language: string) {
    const { run } = world({
      language,
      lastConsolidations: [
        undefined,
        {
          at: AT,
          trigger: 'manual',
          counts: {
            ...COUNTS,
            eventDuplicateCandidates: 12,
            eventDuplicatesMerged: 13,
            llm: { verified: 9, rejected: 10, cacheHits: 14, summariesRewritten: 11 },
          },
        },
        { at: AT, trigger: 'eviction', counts: COUNTS },
        {
          at: AT,
          trigger: 'api',
          counts: { ...COUNTS, llm: { verified: 9, rejected: 10, cacheHits: 0, summariesRewritten: 11 } },
        },
      ],
    });
    const replies = [];
    for (let i = 0; i < 4; i++) replies.push(await run(GROUP, 'onebot', 'consolidation-status'));
    return replies;
  }

  const COUNTED = '别名候选 1，建别名边 2，事件边整理 3，实体层级候选 4，层级边 5，侧向父候选 6，新建父 7，侧向边 8';
  const COUNTED_EN =
    'Alias candidates 1, alias edges created 2, event edges tidied 3, entity hierarchy candidates 4, hierarchy edges 5, lateral parent candidates 6, parents created 7, lateral edges 8';

  it('en：时间按读者的语言，条件片段各成一句', async () => {
    const at = `${new Intl.DateTimeFormat('en', { dateStyle: 'short' }).format(AT)} ${new Intl.DateTimeFormat('en', { timeStyle: 'medium' }).format(AT)}`;
    expect(await statuses('en')).toEqual([
      'Note: consolidation has not run since startup.\nTriggers: /relation consolidate (manual), /relation maintain (consolidate, then compress), or automatically before capacity eviction.',
      `Last consolidation: ${at} (trigger: manual)\n${COUNTED_EN}, duplicate event candidates 12 (merged 13), LLM passed 9, rejected 10 (cache hits 14), summaries rewritten 11`,
      `Last consolidation: ${at} (trigger: automatic, before eviction)\n${COUNTED_EN}`,
      `Last consolidation: ${at} (trigger: API call)\n${COUNTED_EN}, LLM passed 9, rejected 10, summaries rewritten 11`,
    ]);
  });

  it('zh-CN 与改动前逐字相同', async () => {
    expect(await statuses('zh-CN')).toEqual([
      '注意：本次运行以来尚未执行过整理。\n触发方式：/relation consolidate（手动）、/relation maintain（先整理后压缩），或容量淘汰前自动触发。',
      `最近一次整理：2026/10/29 06:05:03（触发方式：手动）\n${COUNTED}，重复事件候选 12（合并 13），LLM 通过 9 否决 10（缓存命中 14） 摘要重写 11`,
      `最近一次整理：2026/10/29 06:05:03（触发方式：淘汰前自动）\n${COUNTED}`,
      `最近一次整理：2026/10/29 06:05:03（触发方式：API 调用）\n${COUNTED}，LLM 通过 9 否决 10 摘要重写 11`,
    ]);
  });
});
