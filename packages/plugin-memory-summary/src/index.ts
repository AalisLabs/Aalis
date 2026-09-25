import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { contributions } from '@aalis/api-contributions';
import { hooks } from '@aalis/api-hooks';
import type { LLMModel } from '@aalis/api-llm';
import { llm, resolveLLMModel } from '@aalis/api-llm';
import type { MemoryService } from '@aalis/api-memory';
import { memory } from '@aalis/api-memory';
import { messageArchive } from '@aalis/api-message-archive';
import type { BoundOf } from '@aalis/core';
import { config, definePlugin, events, lifecycle, logger, optional } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import type { Message } from '@aalis/schema-message';
import { WellKnownKinds } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';

/**
 * 历史探测条数的下限（即历史写死值）。见 {@link getHistoryProbeLimit}：
 * 探测条数兼作单次摘要输入上界，故不能只按 threshold 推导，否则小 threshold
 * 配置的摘要覆盖面会成倍缩水。
 */
const DEFAULT_PROBE_FLOOR = 200;

/** 工具相关条目进摘要输入时的每条硬截断（参数/结果各自适用），工具名不参与截断 */
const TOOL_ENTRY_MAX_CHARS = 200;

/**
 * toolCallId → 工具名映射。tool 消息的 `name` 是可选字段，由上游适配器决定是否回填，
 * 多数来源只带 `toolCallId`；工具名的唯一可靠来源是同一段历史里 assistant 的
 * `toolCalls[].function.name`。不反查就只剩「工具结果: …」，摘要模型看不出做了什么。
 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.toolCalls ?? []) {
      if (tc.id && tc.function?.name) map.set(tc.id, tc.function.name);
    }
  }
  return map;
}

/**
 * 摘要用消息格式化：content 已含 [昵称(ID)] 前缀，故不再叠加 m.name（否则双重身份 用户[123]: [Alice(123)]:）。
 * generateSummary 与 session:compress 两条路径共用，避免格式漂移。
 *
 * 工具回合必须留痕：带 toolCalls 的 assistant 行 content 常为空，直译成「助手: (空)」
 * 等于告诉摘要模型「这一轮什么也没发生」；tool 结果整条丢掉则连做了什么都看不见。
 * 故两者都渲染成可读一行，名字优先保住、正文按 TOOL_ENTRY_MAX_CHARS 硬截断。
 *
 * 工具名按 toolCallId 从 `nameByToolCallId` 反查（见 {@link buildToolNameMap}），
 * 查不到才回落消息自带的 `name`。形参必填，避免误写成 `.map(formatMsgForSummary)`
 * 把数组下标当成映射传进来。
 */
function formatMsgForSummary(m: Message, nameByToolCallId: ReadonlyMap<string, string>): string {
  if (m.role === 'tool') {
    const body = truncateChars((m.content ?? '').trim(), TOOL_ENTRY_MAX_CHARS, '…');
    const toolName = (m.toolCallId ? nameByToolCallId.get(m.toolCallId) : undefined) ?? m.name;
    return `工具结果${toolName ? `(${toolName})` : ''}: ${body || '(空)'}`;
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const calls = m.toolCalls
      .map(
        tc =>
          `${tc.function?.name ?? '未知工具'}(${truncateChars(tc.function?.arguments ?? '', TOOL_ENTRY_MAX_CHARS, '…')})`,
      )
      .join('、');
    const preamble = m.content?.trim();
    return `助手: ${preamble ? `${preamble} ` : ''}调用 ${calls}`;
  }
  return `${m.role === 'user' ? '用户' : '助手'}: ${m.content ?? '(空)'}`;
}

// ===== 插件元数据 =====

const configSchema: ConfigSchema = {
  threshold: {
    type: 'number',
    label: '摘要触发阈值',
    default: 30,
    description: '当会话历史超过此条数时，触发旧消息摘要',
  },
  keepRecent: {
    type: 'number',
    label: '保留最近消息数',
    default: 20,
    description: '摘要后保留的最近消息条数（不参与摘要的部分）',
  },
  summaryTokenRatio: {
    type: 'number',
    label: '摘要 Token 占比',
    default: 0.05,
    description:
      '摘要占模型上下文窗口的比例 (0~1)，例如 0.05 表示 5%。 实际 token 上限 = contextLength × 比例，自动适配不同模型',
  },
  autoCompressThreshold: {
    type: 'number',
    label: 'Token 预压缩阈值',
    default: 0.7,
    description:
      '监听 agent 发出的 token:usage 事件，当使用率超过此比例 (0~1) 时启动后台压缩。默认 0.7 实现“临界前预压缩”，让本轮调用仍然能用原始上下文完成，压缩后的成果下一轮生效。设为 0 则禁用 token 触发。',
  },
  summaryPrompt: {
    type: 'string',
    label: '摘要生成提示词',
    description: '用于指导 LLM 生成摘要的系统提示词',
    default: '',
  },
  summaryModelMode: {
    type: 'select',
    label: '摘要模型来源',
    default: 'global',
    options: [
      { label: '沿用全局默认 LLM', value: 'global' },
      { label: '自定义 provider/model', value: 'custom' },
    ],
    description:
      'global=沿用全局默认 LLM；custom=使用下方 summaryLLM 指定的模型。session（沿用会话当轮模型）暂未实现。',
  },
  summaryLLM: {
    type: 'llm-ref',
    label: '摘要模型',
    description: '仅当 summaryModelMode=custom 时生效；provider 为 LLM 插件实例 contextId，model 为实例内某个模型名。',
  },
};

// ===== 配置 =====

interface SummaryConfig {
  /** 当会话消息 > threshold 时，触发摘要生成 */
  threshold: number;
  /** 摘要时保留最近 N 条消息不参与摘要 */
  keepRecent: number;
  /** 摘要占模型上下文窗口的比例 (0~1) */
  summaryTokenRatio: number;
  /** Token 使用率超过此比例时启动后台压缩 (0~1)，0 表示禁用 */
  autoCompressThreshold: number;
  /** 自定义摘要提示词 */
  summaryPrompt: string;
  /** 摘要模型来源：global=全局默认 LLM；custom=指定 provider+model */
  summaryModelMode: 'global' | 'custom';
  /** custom 模式下的 LLM ref */
  summaryLLM?: { provider: string; model: string };
}

// ===== 默认摘要生成提示词 =====

const DEFAULT_SUMMARY_PROMPT = `你是一个对话摘要助手。请将以下对话内容压缩成一段信息丰富的摘要。

要求：
1. 保留关键信息：用户的核心需求、重要决策、达成的共识
2. 保留重要的事实和数据
3. 保留对话中提到的人名、地点、时间等关键实体
4. 保留用户的偏好和习惯信息
5. 保留情感状态变化、关系动态、讨论中形成的观点
6. **特别重要**：保留每个发言者的昵称与ID的对应关系。消息中 [昵称(ID)] 格式标注了发言者身份，摘要中必须保留这种对应关系（如"小明(123456)"），以便后续能通过ID或昵称识别同一个人
6. 忽略纯粹的寒暄和无信息量的重复内容
7. 如果有之前的摘要，在此基础上整合新内容，确保旧摘要中的重要信息不因新内容加入而被丢弃
8. 使用第三方视角描述，标注发言者身份（如"用户[小明]..."、"助手..."）
9. 按话题或时间分段组织，便于后续检索
10. **特别重要**：如果对话中存在正在进行的多步骤任务或计划（如任务列表、待办事项、分步实施方案），必须完整保留任务的目标、已完成的步骤、尚未完成的步骤及其状态。在摘要末尾用独立段落列出，格式如：
    【进行中的任务】
    - 目标：...
    - 已完成：...
    - 待完成：...
11. 保留助手在对话中制定的工作计划、承诺要做的事情、以及用户尚未被满足的请求`;

// ===== 摘要存储 =====
//
// 通过 MemoryService 的 metadata API 持久化摘要，让摘要与对话历史共享同一存储后端
// （sqlite/mongodb/inmemory）。namespace 固定为 'summary'，key 为 sessionId。
// metadata payload 形如 { summary, updatedAt }。

const SUMMARY_NAMESPACE = 'summary';

interface SummaryRecord {
  summary: string;
}

/**
 * 绑定一个提供者实例，按次构造：一次操作（读历史 → 调 LLM → 写摘要 → 裁切或回滚）全程只认开头
 * 取到的那一个。memory 胜者可能在 LLM 调用期间换人而本插件不重启，每步现取胜者会从 A 读历史、
 * 在 A 上裁切，摘要却写进 B。
 */
class SummaryStore {
  constructor(private readonly provider: MemoryService) {}

  async getSummary(sessionId: string): Promise<SummaryRecord | null> {
    const data = await this.provider.getMetadata(SUMMARY_NAMESPACE, sessionId);
    if (!data) return null;
    return { summary: String(data.summary ?? '') };
  }

  async upsertSummary(sessionId: string, summary: string): Promise<void> {
    await this.provider.saveMetadata(SUMMARY_NAMESPACE, sessionId, {
      summary,
      updatedAt: new Date().toISOString(),
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.provider.deleteMetadata(SUMMARY_NAMESPACE, sessionId);
  }

  async clearAll(): Promise<void> {
    const items = await this.provider.listMetadata(SUMMARY_NAMESPACE);
    await this.provider.commitMetadata(
      items.map(it => ({ op: 'del' as const, namespace: SUMMARY_NAMESPACE, key: it.key })),
    );
  }
}

// ===== 插件入口 =====

const uses = {
  memory,
  llm,
  messageArchive: optional(messageArchive),
  config,
  logger,
  events,
  hooks,
  contributions,
  lifecycle,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-memory-summary',
  displayName: '记忆摘要',
  subsystem: 'memory',
  configSchema,
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { memory, llm, messageArchive, config, logger, events, hooks, contributions, lifecycle } = caps;
  const cfg: SummaryConfig = {
    threshold: (config.threshold as number) ?? 30,
    keepRecent: (config.keepRecent as number) ?? 20,
    summaryTokenRatio: (config.summaryTokenRatio as number) ?? 0.05,
    autoCompressThreshold: (config.autoCompressThreshold as number) ?? 0.7,
    summaryPrompt: (config.summaryPrompt as string) ?? '',
    summaryModelMode: (config.summaryModelMode as string) === 'custom' ? 'custom' : 'global',
    summaryLLM:
      config.summaryLLM &&
      typeof config.summaryLLM === 'object' &&
      (config.summaryLLM as { provider?: unknown }).provider &&
      (config.summaryLLM as { model?: unknown }).model
        ? (config.summaryLLM as { provider: string; model: string })
        : undefined,
  };

  if (!memory.current) {
    logger.warn('memory 服务不可用，摘要插件将不会启动');
    return;
  }

  logger.info('会话摘要插件已启动（摘要持久化经由 memory.metadata）');

  // 正在摘要中的 session，避免并发重复摘要
  const summarizing = new Set<string>();

  /**
   * 根据 summaryModelMode 解析出用于生成摘要的 LLMModel entry。
   * - global：按默认优先级/preference 选首个 chat-capable entry
   * - custom：按 cfg.summaryLLM 精确匹配
   */
  let warnedUnresolvedSummaryLLM = false;
  function resolveSummaryModel(): LLMModel | undefined {
    const ref = cfg.summaryModelMode === 'custom' ? cfg.summaryLLM : undefined;
    const resolved = resolveLLMModel(llm, ref, ['chat'])?.instance;
    // custom 指定了模型却解析落空 → 自动压缩会静默不跑、上下文持续膨胀
    //（2026-08「压缩静默死亡」事故的根因形态；手动路径已有报错，这里补自动路径）。
    // 只警一次防刷屏，恢复后复位以便下次失效再警。
    if (ref && !resolved) {
      if (!warnedUnresolvedSummaryLLM) {
        warnedUnresolvedSummaryLLM = true;
        logger.warn(`摘要模型解析失败（${ref.provider}/${ref.model} 不存在或未激活），自动压缩将不运行`);
      }
    } else if (resolved) {
      warnedUnresolvedSummaryLLM = false;
    }
    return resolved;
  }

  /**
   * 根据实际使用的 LLMModel 计算摘要 token 上限。
   * service-granularity 后每个 entry 直接拥有 contextLength，无需再反查 router。
   */
  function getSummaryTokenBudget(): number {
    const model = resolveSummaryModel();
    const contextLength = model?.contextLength ?? 4096;
    // 注：摘要是每轮重发的常驻块，大窗口下 contextLength × ratio 会给出很大的预算
    // （1e6 × 0.05 = 5 万 token）并被写进提示词。要收紧请调 summaryTokenRatio，
    // 内核不代替宿主设绝对上限——窗口大小与"愿意为常驻块付多少"是宿主的决定。
    return Math.max(512, Math.floor(contextLength * cfg.summaryTokenRatio));
  }

  /**
   * 取多少条历史来判定"是否该压缩"，同时是单次摘要输入量的上界
   * （摘要区间是 `[0, total - keepRecent)`）。这两个职责耦合在同一个数上。
   *
   * 三个下界缺一不可：
   * - `cfg.threshold`：`totalCount` 充当阈值判定的样本，取少了会让
   *   `totalCount < threshold` 恒真、压缩永不触发且零日志（曾写死 200，
   *   threshold>200 的配置全部静默失效）。
   * - `cfg.keepRecent + 1`：否则摘要区间为空，压缩空转。
   * - `DEFAULT_PROBE_FLOOR`：**摘要输入量的下限**。只取前两者的话，
   *   小 threshold 配置（如默认 30/20）单次只摘 10 条，而 `trimHistory` 仍按
   *   keepRecent 归档**全部**活跃历史——超出探测窗的那批被归档却从未进摘要。
   *   实测积压 800 条时摘要输入 180→10 条。此下界即原写死值，保住旧行为。
   *
   * 注：「归档范围 > 摘要范围」在积压极大时仍然存在，那是本函数解决不了的
   * 设计耦合（判定样本与摘要窗口应当拆开），留待后续处理。
   */
  function getHistoryProbeLimit(): number {
    return Math.max(cfg.threshold, cfg.keepRecent + 1, DEFAULT_PROBE_FLOOR);
  }

  // 摘要生成提示词
  const summarySystemPrompt = cfg.summaryPrompt || DEFAULT_SUMMARY_PROMPT;

  /**
   * 待摘要区间 = 除最近 keepRecent 条之外的旧消息。历史不多于 keepRecent 时为空：此时裁切什么都
   * 不归档，若照摘前段（slice 的负数下标会取出开头若干条），同一批消息每轮重摘一次、反复叠进摘要。
   * 条数触发与 session:compress 共用这一处判定。
   */
  function selectMessagesToSummarize(allHistory: Message[]): Message[] {
    if (allHistory.length <= cfg.keepRecent) return [];
    return allHistory.slice(0, allHistory.length - cfg.keepRecent);
  }

  /**
   * 摘要并裁切（generateSummary 与 session:compress 共用）：格式化待摘要消息 → 联合已有摘要调用模型
   * → 摘要落库 → 裁切活跃历史 → 写压缩分隔标记。`userSuffix` 追加在摘要请求正文末尾
   * （compress 路径的任务列表状态与任务提示）。
   *
   * 模型失败或返回空时降级为只裁切、不写摘要；裁切抛错时先把摘要回滚到落库前再原样抛出。
   * 返回写入的摘要，降级时为空串。
   */
  async function summarizeAndTrim(
    provider: MemoryService,
    summaryModel: LLMModel,
    sessionId: string,
    allHistory: Message[],
    messagesToSummarize: Message[],
    userSuffix: string,
  ): Promise<string> {
    const store = new SummaryStore(provider);
    const existing = await store.getSummary(sessionId);

    // 映射建在 allHistory 上：比待摘要切片多扫几条，零成本。
    // 工具名来源（assistant.toolCalls）恒早于 tool 结果，切片又是 allHistory 的前缀：只要 assistant 还在探测
    // 窗口内就一定在切片内；窗口头部被截断的那组查不到，回落 m.name。
    const nameByToolCallId = buildToolNameMap(allHistory);
    const formattedMessages = messagesToSummarize
      .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
      .map(m => formatMsgForSummary(m, nameByToolCallId))
      .join('\n');

    // 构建摘要请求
    const summaryBudget = getSummaryTokenBudget();
    const budgetHint = `\n\n重要：你的摘要输出上限为 ${summaryBudget} tokens（约 ${summaryBudget * 4} 个英文字符，或约 ${Math.floor(summaryBudget / 1.5)} 个中文字符）。请合理分配篇幅，确保“【进行中的任务】”等关键结构能完整输出。`;
    const summaryMessages: Message[] = [{ role: 'system', content: summarySystemPrompt + budgetHint }];

    // 如果已有旧摘要，在提示中包含它
    if (existing?.summary) {
      summaryMessages.push({
        role: 'user',
        content: `以下是之前的对话摘要：\n${existing.summary}\n\n以下是新增的对话内容，请在之前摘要的基础上整合生成更新的摘要：\n${formattedMessages}${userSuffix}`,
      });
    } else {
      summaryMessages.push({
        role: 'user',
        content: `请为以下对话生成摘要：\n${formattedMessages}${userSuffix}`,
      });
    }

    logger.debug(
      `正在为 session=${sessionId} 生成摘要 (${messagesToSummarize.length} 条旧消息 → 摘要，保留最近 ${cfg.keepRecent} 条)`,
    );

    // 调用 LLM 生成摘要。生成失败不再滞留于"涨破阈值→超时→原样重试"的循环
    // （慢模型场景实测每隔几分钟白烧一次 120s；usageRatio 触发的压缩同样会每次 LLM 调用都再触发一次）：
    // 降级为纯裁切——该段历史无摘要但仍在归档层可检索，活跃上下文回到 keepRecent 以内，循环即断。
    let summaryText = '';
    try {
      const stream = summaryModel.chatStream?.({
        messages: summaryMessages,
        temperature: 0.3,
        maxTokens: summaryBudget,
        think: false, // 取舍见下方非流式分支的注释
      });
      if (!stream) {
        // think: false 写死不设配置——摘要是机械压缩任务，思维链只贡献耗时方差：
        // thinkingMode=auto 下 v4 全系默认带思考，300 条群聊的摘要曾多次撞
        // provider 的 120s 超时；压缩卡住 → 活跃数冲破取数窗 → 滑窗复活，
        // 质量和前缀缓存一起塌。「不思考的摘要」对「超时导致根本没有摘要」
        // 不是权衡。将来真出现需要思考版摘要的模型再补配置键。
        const resp = await summaryModel.chat({
          messages: summaryMessages,
          temperature: 0.3,
          maxTokens: summaryBudget,
          think: false,
        });
        summaryText = resp.content ?? '';
      } else {
        for await (const chunk of stream) {
          if (chunk.contentDelta) {
            summaryText += chunk.contentDelta;
          }
        }
      }
    } catch (err) {
      // 半截流式输出必须丢弃：provider 超时常在吐出部分内容后中断流，把截断文本
      // 入库会让它成为后续所有增量摘要的权威基底，链条被永久污染（对抗审计实测）
      summaryText = '';
      logger.warn('生成会话摘要失败，降级为纯裁切（该段历史无摘要，归档层仍可检索）:', err);
    }

    const finalSummary = summaryText.trim();
    const summaryTs = Date.now();
    // 摘要先落库、裁切后执行，两步不原子：裁切抛错（SQLITE_BUSY / Mongo 瞬时错，
    // 两个 provider 的 trimHistory 都不内吞异常）时摘要已提交而历史没裁，getHistory
    // 仍取到同一段（archived 没变、totalCount 不降），下一轮切的还是这批内容，而基底
    // 已是刚写进去的新摘要——同一段历史被反复叠进摘要，每轮都花一次模型调用。
    // 故记下旧摘要，裁切失败就把摘要回滚到落库前的样子，让下一轮从干净基底重摘。
    const prevSummary = existing?.summary;
    if (finalSummary) {
      await store.upsertSummary(sessionId, finalSummary);
    }

    // 真正的压缩：将旧消息标记为 archived，只保留最近 keepRecent 条作为热上下文。
    // 摘要成功与失败共用这段——失败路径就是上述降级方案。
    // 安全调整：避免裁剪点落在 tool call 组中间（assistant(toolCalls) 被删但 tool 响应被保留）
    // 下界 1：keepRecent=0 会让索引 allHistory.length - 0 越界、undefined.role 抛
    // TypeError——异常被外层 catch 吞成一条 warn，摘要已花完却不裁切，之后每轮重摘全量历史
    let safeKeepRecent = Math.max(1, Math.floor(cfg.keepRecent));
    while (safeKeepRecent < allHistory.length) {
      const firstKeptMsg = allHistory[allHistory.length - safeKeepRecent];
      if (firstKeptMsg.role === 'tool') {
        safeKeepRecent++;
      } else {
        break;
      }
    }
    let trimmed = false;
    if (provider.trimHistory) {
      let deleted: number;
      try {
        deleted = await provider.trimHistory(sessionId, safeKeepRecent);
      } catch (trimErr) {
        // 别把「摘要已写、历史没裁」这个半成品状态留下
        if (finalSummary) {
          try {
            if (prevSummary) await store.upsertSummary(sessionId, prevSummary);
            else await store.clearSession(sessionId);
          } catch (rollbackErr) {
            logger.warn('裁切失败后回滚摘要也失败（下一轮会在新摘要基底上重摘）:', rollbackErr);
          }
        }
        throw trimErr;
      }
      trimmed = true;
      logger.info(
        finalSummary
          ? `会话已压缩: session=${sessionId}, 归档 ${deleted} 条旧消息，保留 ${safeKeepRecent} 条`
          : `会话已裁切（无摘要）: session=${sessionId}, 归档 ${deleted} 条旧消息，保留 ${safeKeepRecent} 条`,
      );
    } else {
      logger.warn('记忆服务不支持 trimHistory，旧消息未归档');
    }

    // 保存系统事件消息，供前端持久化显示压缩分隔线。
    // 失败降级的"已裁切" marker 以真的裁切了为前提——provider 不支持 trimHistory 时
    // 什么都没发生，写 marker 是说谎且每轮重复追加一条
    const archive = messageArchive.current;
    if (archive && (finalSummary || trimmed))
      await archive.saveMessage(sessionId, {
        role: 'system',
        kind: WellKnownKinds.EventMarker,
        content: finalSummary ? '对话已压缩' : '对话已裁切（摘要生成失败，该段无摘要）',
        timestamp: summaryTs,
      });

    return finalSummary;
  }

  /**
   * 为指定 session 生成/更新摘要
   *
   * 流程：
   * 1. 从 memory 获取完整历史
   * 2. 如果总消息数 < threshold，或不多于 keepRecent，不需要摘要
   * 3. 取 [0, total - keepRecent) 区间的消息，联合已有摘要生成新摘要并裁切（见 summarizeAndTrim）
   */
  async function generateSummary(sessionId: string): Promise<void> {
    if (summarizing.has(sessionId)) return;
    summarizing.add(sessionId);

    try {
      const provider = memory.current;
      const summaryModel = resolveSummaryModel();
      if (!provider || !summaryModel) return;

      // 获取较多的历史消息来判断是否需要摘要
      const allHistory = await provider.getHistory(sessionId, getHistoryProbeLimit());
      if (allHistory.length < cfg.threshold) return;

      // keepRecent ≥ threshold 的配置下，过了阈值也可能还不多于 keepRecent：此时区间为空，不摘
      const messagesToSummarize = selectMessagesToSummarize(allHistory);
      if (messagesToSummarize.length === 0) return;

      await summarizeAndTrim(provider, summaryModel, sessionId, allHistory, messagesToSummarize, '');
    } catch (err) {
      logger.warn('生成会话摘要失败:', err);
    } finally {
      summarizing.delete(sessionId);
    }
  }

  // === 贡献：在 LLM 调用前注入摘要（agent:prompt / context 槽）===
  contributions.contribute('agent:prompt', {
    id: 'memory-summary',
    anchor: 'context',
    async build(view) {
      const sessionId = view.sessionId;
      if (!sessionId) return null;

      const existing = await new SummaryStore(memory.require()).getSummary(sessionId);
      if (!existing?.summary) return null;

      // 动态计算摘要 token 预算
      const summaryBudget = getSummaryTokenBudget();
      const summaryTokens = Math.ceil(existing.summary.length / 3);
      let summaryContent = existing.summary;

      // 如果超出预算，截断
      if (summaryTokens > summaryBudget) {
        const maxChars = summaryBudget * 3;
        // 代理安全截断：摘要会落库并每轮重注入上下文，切坏 emoji 出孤代理会让 DeepSeek 请求 400。
        summaryContent = truncateChars(summaryContent, maxChars, '\n... [摘要已截断]');
      }

      return `以下是之前对话的摘要，包含了较早的对话上下文：\n${summaryContent}`;
    },
  });

  // === 在 agent:turn:after 钩子触发摘要生成 ===
  // 每轮对话结束后，异步检查是否需要生成摘要
  hooks.middleware('agent:turn:after', async (data, next) => {
    await next();
    // 中止/异常回合不触发摘要：本轮没有产生有效新内容（用户停止或报错），
    // 摘要无意义且浪费算力。turn:after 现已在 aborted/error 路径也触发（生命周期收口），
    // 故此处需显式跳过这两种 outcome。
    if (data.outcome === 'aborted' || data.outcome === 'error') return;
    // 异步触发，不阻塞主流程
    generateSummary(data.sessionId).catch(err => {
      logger.warn('异步摘要生成失败:', err);
    });
  });

  // === 监听 token:usage 事件，预压缩触发 ===
  // agent 在每次 LLM 调用前发出 token 使用统计；
  // 当使用率超过 autoCompressThreshold（默认 0.7）时，转发为 session:compress(reason='auto') 启动后台压缩。
  // 注意：generateSummary/session:compress 内部已有 summarizing 锁，这里再做一次提前判断避免无谓 emit。
  events.on('token:usage', async usage => {
    if (!usage?.sessionId) return;
    if (cfg.autoCompressThreshold <= 0) return;
    if (usage.usageRatio < cfg.autoCompressThreshold) return;
    if (summarizing.has(usage.sessionId)) return;
    logger.info(
      `Token 使用率 ${(usage.usageRatio * 100).toFixed(1)}% 超过阈值 ${(cfg.autoCompressThreshold * 100).toFixed(0)}%，触发后台压缩`,
    );
    events
      .emit('session:compress', { sessionId: usage.sessionId, reason: 'auto', usageRatio: usage.usageRatio })
      .catch(() => {});
  });

  // === 监听手动/自动压缩事件 ===
  events.on('session:compress', async data => {
    logger.info(`收到压缩请求: session=${data.sessionId}, reason=${data.reason}`);

    // reason 必填且仅 manual|auto（api-memory 契约），两个发射方也只发这两种：
    // 两者都走同一条压缩路径——手动/自动之别只体现在 taskHint 措辞上。
    // 压缩不看 threshold：消息数不到阈值也强制执行。
    if (summarizing.has(data.sessionId)) return;
    summarizing.add(data.sessionId);

    // 通知前端：压缩开始
    events.emit('session:compressing', { sessionId: data.sessionId, status: 'start' }).catch(() => {});

    try {
      const provider = memory.current;
      const summaryModel = resolveSummaryModel();
      if (!provider || !summaryModel) {
        // 报 error 而非 done：报 done 会让前端插入"对话已压缩"的假成功分隔线。
        // 常见触发：summaryModelMode=custom 指向的 provider 被卸载/重载中。
        logger.warn(
          `压缩跳过: ${!provider ? 'memory 服务不可用' : '摘要模型解析失败（检查 summaryModelMode/summaryLLM 配置）'}`,
        );
        events.emit('session:compressing', { sessionId: data.sessionId, status: 'error' }).catch(() => {});
        return;
      }
      const allHistory = await provider.getHistory(data.sessionId, getHistoryProbeLimit());
      // 只要有 > keepRecent 条消息就压缩
      const messagesToSummarize = selectMessagesToSummarize(allHistory);
      if (messagesToSummarize.length === 0) {
        logger.info(`会话消息数 ${allHistory.length} ≤ keepRecent(${cfg.keepRecent})，无需压缩`);
        events.emit('session:compressing', { sessionId: data.sessionId, status: 'done' }).catch(() => {});
        return;
      }

      // 从历史消息中提取最近的 todo-list 状态，注入到压缩上下文中
      let todoContext = '';
      try {
        const recentMessages = allHistory.slice(-cfg.keepRecent);
        const todoMsgs = recentMessages.filter(
          m =>
            m.role === 'assistant' &&
            m.toolCalls?.some(tc => tc.function.name === 'manage_todo_list' || tc.function.name === 'todo_manage'),
        );
        if (todoMsgs.length > 0) {
          const lastTodo = todoMsgs[todoMsgs.length - 1];
          const tc = lastTodo.toolCalls?.find(
            tc => tc.function.name === 'manage_todo_list' || tc.function.name === 'todo_manage',
          );
          if (tc?.function.arguments) {
            todoContext = `\n\n当前任务列表状态：\n${tc.function.arguments}`;
          }
        }
      } catch {
        /* ignore */
      }

      const taskHint =
        data.reason === 'auto'
          ? '\n\n注意：此次压缩是在任务执行过程中自动触发的，助手可能正在进行多步骤工作。请特别注意保留所有未完成的任务状态和下一步计划。'
          : '';

      const finalSummary = await summarizeAndTrim(
        provider,
        summaryModel,
        data.sessionId,
        allHistory,
        messagesToSummarize,
        `${todoContext}${taskHint}`,
      );

      // 通知前端：成功报 done；降级报 error（摘要确实失败了，裁切结果经历史刷新可见）。
      // 空响应此前既不裁也不发事件，前端会永远停在 'start'——现在归入降级路径一并解决。
      events
        .emit('session:compressing', { sessionId: data.sessionId, status: finalSummary ? 'done' : 'error' })
        .catch(() => {});
    } catch (err) {
      logger.warn('压缩会话失败:', err);
      // 通知前端：压缩失败
      events.emit('session:compressing', { sessionId: data.sessionId, status: 'error' }).catch(() => {});
    } finally {
      summarizing.delete(data.sessionId);
    }
  });

  // 统一记忆清除：通过 memory:clear hook 参与编排
  hooks.middleware('memory:clear', async (data, next) => {
    // 类型过滤：如果指定了 types 且不包含 summary，跳过
    if (data.types && !data.types.includes('summary')) {
      await next();
      return;
    }

    try {
      const store = new SummaryStore(memory.require());
      if (data.scope === 'all') {
        await store.clearAll();
        data.results.push({ source: 'summary', success: true, message: '所有会话摘要已清空' });
        logger.info('所有会话摘要已清空');
      } else if (data.sessionId) {
        await store.clearSession(data.sessionId);
        data.results.push({ source: 'summary', success: true, message: '当前会话摘要已清空' });
        logger.info(`会话摘要已清空: session=${data.sessionId}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      data.results.push({ source: 'summary', success: false, message: `摘要清空失败: ${msg}` });
      logger.warn('摘要清空失败:', err);
    }

    await next();
  });

  // 清理
  lifecycle.onDispose(() => {
    logger.info('会话摘要插件已卸载');
  });
}
