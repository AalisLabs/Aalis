import type { TokenUsageEvent } from '@aalis/api-agent'; // 也是本包 declaration merging 的激活点（agent:* 钩子、agent:prompt 贡献点与 token:usage 事件）——删掉会丢键类型，不可删
import { contributions } from '@aalis/api-contributions';
import { hooks } from '@aalis/api-hooks';
import type { LLMModel } from '@aalis/api-llm';
import { lightestThinking, llm, resolveLLMModel } from '@aalis/api-llm';
import type { MemoryService } from '@aalis/api-memory';
import { clearMetadataNamespaces, compression, compressionDue, memory } from '@aalis/api-memory';
import { messageArchive } from '@aalis/api-message-archive';
import { type SessionSetting, sessionManager } from '@aalis/api-session-manager';
import type { BoundOf, Logger } from '@aalis/core';
import { config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import type { Message } from '@aalis/schema-message';
import { WellKnownKinds, WellKnownMetadataKeys } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';

/** 工具相关条目进摘要输入时的每条硬截断（参数/结果各自适用），工具名不参与截断 */
const TOOL_ENTRY_MAX_CHARS = 200;

/** 摘要模型没声明输出上限时按这个数封顶，与对话代理对模型输出上限的缺省假设相同 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** 自动压缩线的默认值：会话设置的各层都没设时用它，也是设置项字段的默认值 */
const DEFAULT_COMPRESS_AT = 0.8;

/** 后台压缩连续没压成时，两次尝试之间至多隔这么多轮 */
const MAX_RETRY_INTERVAL_TURNS = 32;

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
 * 消息的可见正文。回复经结构化输出（persona 的 outputFormat）时，content 存整串 JSON 信封，
 * agent 把解码后的回复另写进 metadata 的 VisibleContent 键；键缺省即 content 本身。
 * 摘要要的是「当时说了什么」，信封里的键骨架与状态字段不该进摘要输入。
 */
function visibleText(m: Message): string | null {
  const visible = m.metadata?.[WellKnownMetadataKeys.VisibleContent];
  return typeof visible === 'string' ? visible : m.content;
}

/** 进摘要输入的消息：对话与工具回合（系统标记、平台通知不进） */
const isConversation = (m: Message) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool';

/**
 * 摘要用消息格式化：content 已含 [昵称(ID)] 前缀，故不再叠加 m.name（否则双重身份 用户[123]: [Alice(123)]:）。
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
    const preamble = visibleText(m)?.trim();
    return `助手: ${preamble ? `${preamble} ` : ''}调用 ${calls}`;
  }
  return `${m.role === 'user' ? '用户' : '助手'}: ${visibleText(m) ?? '(空)'}`;
}

/**
 * 切分点：快照末尾的工具调用组没写全时（快照恰好读在 agent 写这一组的几次写入之间）退到这组的 assistant 之前，
 * 它与随后写入的结果都留在活跃历史里；否则为快照末尾
 */
function cutPoint(snapshot: Message[]): number {
  let start = snapshot.length;
  while (start > 0 && snapshot[start - 1].role === 'tool') start--;
  const head = snapshot[start - 1];
  if (head?.role !== 'assistant' || !head.toolCalls?.length) return snapshot.length;
  const results = new Set(snapshot.slice(start).map(m => m.toolCallId));
  return head.toolCalls.every(call => results.has(call.id)) ? snapshot.length : start - 1;
}

const toolCallIds = (m: Message) => m.toolCalls?.map(call => call.id).join() ?? '';

/** 落笔前核对：现在的活跃历史前 count 条与快照逐条相同（时间戳、角色、正文与工具调用 id） */
function samePrefix(snapshot: Message[], current: Message[], count: number): boolean {
  return snapshot.slice(0, count).every((m, i) => {
    const now = current[i];
    return (
      now !== undefined &&
      now.timestamp === m.timestamp &&
      now.role === m.role &&
      now.content === m.content &&
      now.toolCallId === m.toolCallId &&
      toolCallIds(now) === toolCallIds(m)
    );
  });
}

/** 把格式化好的各行拼成每块不超过 limit 字的若干块；单行超过 limit 的切成几段（代理对不拆开） */
function chunkLines(lines: string[], limit: number): string[] {
  const chunks: string[] = [];
  for (const line of lines) {
    for (let rest = line; rest; ) {
      const piece = truncateChars(rest, limit);
      rest = rest.slice(piece.length);
      const last = chunks.length - 1;
      if (last >= 0 && chunks[last].length + 1 + piece.length <= limit) chunks[last] += `\n${piece}`;
      else chunks.push(piece);
    }
  }
  return chunks;
}

// ===== 插件元数据 =====

const configSchema = defineConfig({
  summaryTokenRatio: {
    type: 'number',
    label: '摘要 Token 上限（占窗口比例）',
    default: 0.05,
    secret: false,
    description:
      '摘要的输出上限占会话所用模型上下文窗口的比例 (0~1)，例如 0.05 表示 5%。窗口取这个会话最近一次模型调用的（还没有用量时取摘要模型的），上限不少于 512、不超过摘要模型的输出上限',
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
});

// ===== 配置 =====

type SummaryConfig = ConfigOf<typeof configSchema>;

// ===== 会话设置项：自动压缩线 =====

declare module '@aalis/api-session-manager' {
  interface SessionConfig {
    /** 自动压缩线：用量占上下文窗口的比例，0 到 1；0 表示不按用量压缩 */
    compressAt?: number;
  }
}

/** 会话设置项「自动压缩线」：适用于全部会话；子会话按自己的继承链实时解析，不冻结父会话当时的值 */
const COMPRESS_AT_SETTING: SessionSetting = {
  key: 'compressAt',
  field: {
    type: 'number',
    label: '自动压缩线（占窗口比例）',
    min: 0,
    max: 1,
    default: DEFAULT_COMPRESS_AT,
    description: '用量到上下文窗口的这个比例时压缩；0 表示不按用量压缩',
  },
  appliesTo: ['owner', 'room', 'task'],
  prominence: 'advanced',
  liveOnly: true,
};

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
 * 绑定一个提供者实例，按次构造：一次压缩（读历史 → 调 LLM → 核对 → 写摘要 → 归档或回滚）全程只认开头取到的那一个。
 * memory 胜者可能在 LLM 调用期间换人而本插件不重启，每步现取胜者会从 A 读历史、在 A 上归档，摘要却写进 B。
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

  /** 读不出的摘要一并删除，由 logger 记下（见 clearMetadataNamespaces） */
  async clearAll(logger: Pick<Logger, 'info'>): Promise<void> {
    await clearMetadataNamespaces(this.provider, [SUMMARY_NAMESPACE], logger);
  }
}

// ===== 插件入口 =====

const uses = {
  memory,
  llm,
  messageArchive: optional(messageArchive),
  /** 登记并解析会话设置项「自动压缩线」；不在场时一律按默认 0.8 */
  sessionManager: optional(sessionManager),
  config,
  logger,
  events,
  hooks,
  contributions,
  lifecycle,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-memory-summary',
  displayName: '记忆摘要',
  subsystem: 'memory',
  configSchema,
  provides: [compression],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { memory, llm, messageArchive, sessionManager, logger, events, hooks, contributions, lifecycle, provide } =
    caps;
  const parsed = parseConfig(configSchema, caps.config, logger);
  const cfg: SummaryConfig = {
    ...parsed,
    summaryLLM:
      parsed.summaryLLM &&
      typeof parsed.summaryLLM === 'object' &&
      parsed.summaryLLM.provider &&
      parsed.summaryLLM.model
        ? parsed.summaryLLM
        : undefined,
  };
  sessionManager.registerSetting(COMPRESS_AT_SETTING);

  logger.info('会话摘要插件已启动（摘要持久化经由 memory.metadata）');

  /** 正在压缩的会话：同一会话同时只有一次压缩 */
  const summarizing = new Set<string>();

  /**
   * 清空代数：memory:clear 清摘要时递增（全局清空递增 clearAllEpoch，会话级递增该会话的代数）。
   * 压缩在读历史前记下代数，每块摘要返回后与落笔前比对：期间清过就丢弃在途结果，不把已清掉的对话写回摘要。
   * 已过比对、正在落库的那一段比对拦不住，由清理等它落定（见 committing）。
   */
  let clearAllEpoch = 0;
  const clearEpoch = new Map<string, number>();
  /** 记下会话此刻的清空代数；返回的函数在此后清过（全局或本会话）时为真 */
  function clearedSince(sessionId: string): () => boolean {
    const all = clearAllEpoch;
    const own = clearEpoch.get(sessionId) ?? 0;
    return () => clearAllEpoch !== all || (clearEpoch.get(sessionId) ?? 0) !== own;
  }
  /**
   * 已过比对、正在落库（写摘要 → 归档 → 写标记）的会话。比对与落库之间隔着数据库往返，清理在其间开始时
   * 比对拦不住：清理先等这一段落定再删，删掉的就包括它刚写进去的
   */
  const committing = new Map<string, Promise<unknown>>();

  /** 每个会话最近一条真实回合的用量（带 turnId）：回合结束时只认这一轮的那条做判定 */
  const turnUsages = new Map<string, TokenUsageEvent>();
  /** 每个会话最近一次用量的窗口（真实回合与 token:request 的快照都记），供摘要预算用 */
  const windows = new Map<string, number>();
  /**
   * 后台压缩连续没压成的次数，与最后一次之后判过的轮数：第 count 次之后隔 2^count 轮（至多 MAX_RETRY_INTERVAL_TURNS 轮）
   * 才重试。按轮数退避而不按用量又涨了多少：用量是硬裁剪之后量的，涨到裁剪预算就不再涨
   */
  const failures = new Map<string, { count: number; turns: number }>();
  /**
   * 压缩代数：会话每压成一次加一。回合开始时记下当时的代数与清空代数（turnId → 两者），结束时任一变过的不判：
   * 这一轮的用量是按压缩或清空之前的历史算的
   */
  const compressions = new Map<string, number>();
  const turnStarts = new Map<string, { compressions: number; cleared: () => boolean }>();

  /** 这个会话的自动压缩线：会话设置的各层都没设（或没有会话管理）时为默认 0.8；设为 0 时为 undefined */
  function compressAt(sessionId: string, platform?: string): number | undefined {
    const line = sessionManager.current?.resolveConfig(sessionId, platform).compressAt ?? DEFAULT_COMPRESS_AT;
    return line > 0 ? line : undefined;
  }

  /**
   * 摘要的输出上限：会话最近一次用量的窗口 × summaryTokenRatio（还没有用量时按摘要模型的窗口），下限 512，
   * 不超过摘要模型的输出上限。摘要是每轮重发的常驻块，要收紧调 summaryTokenRatio
   */
  function summaryBudget(sessionId: string, model: LLMModel): number {
    const window = windows.get(sessionId) ?? model.contextLength;
    return Math.min(
      Math.max(512, Math.floor(window * cfg.summaryTokenRatio)),
      model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    );
  }

  // 摘要生成提示词
  const summarySystemPrompt = cfg.summaryPrompt || DEFAULT_SUMMARY_PROMPT;

  /** 调一次摘要模型：模型失败、流式中途断开或返回空都以原因抛出 */
  async function askSummaryModel(
    model: LLMModel,
    sessionId: string,
    maxTokens: number,
    previous: string | undefined,
    conversation: string,
  ): Promise<string> {
    const budgetHint = `\n\n重要：你的摘要输出上限为 ${maxTokens} tokens（约 ${maxTokens * 4} 个英文字符，或约 ${Math.floor(maxTokens / 1.5)} 个中文字符）。请合理分配篇幅，确保“【进行中的任务】”等关键结构能完整输出。`;
    const messages: Message[] = [
      { role: 'system', content: summarySystemPrompt + budgetHint },
      {
        role: 'user',
        content: previous
          ? `以下是之前的对话摘要：\n${previous}\n\n以下是新增的对话内容，请在之前摘要的基础上整合生成更新的摘要：\n${conversation}`
          : `请为以下对话生成摘要：\n${conversation}`,
      },
    ];
    // 最浅的思考档写死不设配置——摘要是机械压缩任务，思维链只贡献耗时方差：
    // DeepSeek v4 全系默认带思考，300 条群聊的摘要曾多次撞 provider 的 120s 超时。
    // 「不思考的摘要」对「超时导致根本没有摘要」不是权衡。将来真出现需要思考版摘要的模型再补配置键。
    const request = {
      messages,
      temperature: 0.3,
      maxTokens,
      think: lightestThinking(model),
      sessionId,
      purpose: '摘要',
    };
    let text = '';
    try {
      const stream = model.chatStream?.(request);
      if (stream) for await (const chunk of stream) text += chunk.contentDelta ?? '';
      else text = (await model.chat(request)).content ?? '';
    } catch (err) {
      // 半截流式输出一并丢弃：provider 超时常在吐出部分内容后中断流，截断的文本入库会成为之后所有增量摘要的基底
      throw new Error(`摘要模型调用失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const summary = text.trim();
    if (!summary) throw new Error('摘要模型返回了空内容');
    return summary;
  }

  /**
   * 把待摘要部分连同已有摘要交给摘要模型，得到新摘要。格式化后的输入超过摘要模型的单次容量时分块增量：每块不超过
   * (窗口 − 输出上限) ÷ 2 字（按每字至多 2 token 保守折算，留出提示词与已有摘要），上一块的结果作为下一块的已有摘要。
   * 任何一块失败或返回空整次失败；每块返回后会话被清空过的，整次作废
   */
  async function summarize(
    model: LLMModel,
    sessionId: string,
    part: Message[],
    previous: string | undefined,
    cleared: () => boolean,
  ): Promise<string> {
    const maxTokens = summaryBudget(sessionId, model);
    const limit = Math.floor((model.contextLength - maxTokens) / 2);
    // 每块至少两个码元，切分才能前进（代理对不拆开）
    if (limit < 2)
      throw new Error(`摘要模型的上下文窗口（${model.contextLength}）装不下摘要的输出上限（${maxTokens}）`);
    const names = buildToolNameMap(part);
    const lines = part.map(m => formatMsgForSummary(m, names));
    // 待摘要部分里最后一次待办的参数作为最后一行，与其余各行一起分块
    const todo = part
      .flatMap(m => m.toolCalls ?? [])
      .filter(call => call.function.name === 'manage_todo_list')
      .at(-1)?.function.arguments;
    if (todo) lines.push(`当前任务列表状态：\n${todo}`);
    let summary = '';
    for (const [i, chunk] of chunkLines(lines, limit).entries()) {
      summary = await askSummaryModel(model, sessionId, maxTokens, i === 0 ? previous : summary, chunk);
      if (cleared()) throw new Error('压缩期间会话被清空');
    }
    return summary;
  }

  /** 落定：写摘要 → 归档切分点之前的 cut 条 → 写分隔标记。归档抛错时把摘要回滚到写入前，原样抛出 */
  async function commitCompression(
    provider: MemoryService,
    store: SummaryStore,
    sessionId: string,
    cut: number,
    previous: string | undefined,
    summary: string,
  ): Promise<void> {
    const at = Date.now();
    await store.upsertSummary(sessionId, summary);
    let archived: number;
    try {
      archived = await provider.archiveOldest(sessionId, cut);
    } catch (err) {
      // 摘要已写、历史没归档：下一次压缩会把同一段历史再并进这份新摘要，故回滚到写入前
      try {
        if (previous) await store.upsertSummary(sessionId, previous);
        else await store.clearSession(sessionId);
      } catch (rollbackErr) {
        logger.warn('归档失败后回滚摘要也失败（下一次压缩会把这一段再并进新摘要）:', rollbackErr);
      }
      throw err;
    }
    logger.info(`会话已压缩: session=${sessionId}, 归档 ${archived} 条`);
    // 系统事件消息，供前端持久化显示压缩分隔线
    await messageArchive.current?.saveMessage(sessionId, {
      role: 'system',
      kind: WellKnownKinds.EventMarker,
      content: '对话已压缩',
      timestamp: at,
    });
  }

  /**
   * 全量压缩一次（后台与手动共用）：快照全部活跃历史，切分点之前的全部连同已有摘要压成一份新摘要，落笔前核对快照前缀
   * 没被改过，再写摘要、归档切分点之前的消息、写分隔标记；切分点之后的消息（快照之后到达的、没写全的工具调用组）
   * 原样留在活跃历史里。进度经 session:compressing 报 start、done、error，报 done 才算压成（界面据此插「对话已压缩」）。
   * 没压成（摘要模型不在、模型失败、期间被清空或历史被改动）时以原因拒绝，什么都不写；待摘要部分没有对话时什么都不做、
   * 不报进度；开始之前就失败的（正在压缩、记忆不在、读不出历史）只拒绝，也不报
   */
  async function compressHistory(sessionId: string): Promise<void> {
    if (summarizing.has(sessionId)) throw new Error('这个会话正在压缩，稍后再试');
    summarizing.add(sessionId);
    const cleared = clearedSince(sessionId);
    const report = (status: 'start' | 'done' | 'error') =>
      void events.emit('session:compressing', { sessionId, status });

    let started = false;
    try {
      const provider = memory.current;
      if (!provider) throw new Error('memory 服务不可用');
      const snapshot = await provider.getHistory(sessionId, Infinity);
      const cut = cutPoint(snapshot);
      const part = snapshot.slice(0, cut).filter(isConversation);
      if (part.length === 0) return;
      report('start');
      started = true;
      // global 按默认优先级选首个能对话的模型；custom 按 summaryLLM 精确匹配，常见的落空是它指向的 provider 被卸载或重载中
      const ref = cfg.summaryModelMode === 'custom' ? cfg.summaryLLM : undefined;
      const model = resolveLLMModel(llm, ref, ['chat'])?.instance;
      if (!model) {
        throw new Error(
          ref
            ? `摘要模型解析失败（${ref.provider}/${ref.model} 不存在或未激活）`
            : '摘要模型解析失败（检查 summaryModelMode/summaryLLM 配置）',
        );
      }
      const store = new SummaryStore(provider);
      const previous = (await store.getSummary(sessionId))?.summary || undefined;
      const summary = await summarize(model, sessionId, part, previous, cleared);
      const current = await provider.getHistory(sessionId, Infinity);
      if (cleared()) throw new Error('压缩期间会话被清空');
      // 回滚删了前缀里的消息、晚到的消息时间戳插进了前缀：归档最早的 cut 条就会归掉没进摘要的消息
      if (!samePrefix(snapshot, current, cut)) throw new Error('压缩期间历史被改动');
      const commit = commitCompression(provider, store, sessionId, cut, previous, summary);
      committing.set(sessionId, commit);
      try {
        await commit;
      } finally {
        committing.delete(sessionId);
      }
      compressions.set(sessionId, (compressions.get(sessionId) ?? 0) + 1);
      failures.delete(sessionId);
      report('done');
    } catch (err) {
      logger.warn(`压缩没有压成: session=${sessionId}`, err);
      if (started) report('error');
      throw err;
    } finally {
      summarizing.delete(sessionId);
    }
  }

  // === 贡献：在 LLM 调用前注入摘要（agent:prompt / context 槽）===
  // 不按预算截断：生成时的 maxTokens 已是上限；换了窗口更小的模型时，下一次压缩会重写摘要，期间由硬裁剪兜底
  contributions.contribute('agent:prompt', {
    id: 'memory-summary',
    anchor: 'context',
    async build(view) {
      if (!view.sessionId) return null;
      const existing = await new SummaryStore(memory.require()).getSummary(view.sessionId);
      return existing?.summary ? `以下是之前对话的摘要，包含了较早的对话上下文：\n${existing.summary}` : null;
    },
  });

  provide(
    compression,
    {
      compress(sessionId, request) {
        logger.info(`收到压缩请求: session=${sessionId}, reason=${request.reason}`);
        return compressHistory(sessionId);
      },
      compressAt,
    },
    { label: '会话压缩' },
  );

  events.on('token:usage', usage => {
    windows.set(usage.sessionId, usage.contextWindow);
    if (usage.turnId) turnUsages.set(usage.sessionId, usage);
  });

  // 回合从开始（agent:input:before）到它的 next 返回为止：记下开始时的压缩代数与清空代数，被下游拦下、出错的一轮同样在 finally 里丢掉
  hooks.middleware('agent:input:before', async (data, next) => {
    const sessionId = data.message.sessionId;
    turnStarts.set(data.turnId, { compressions: compressions.get(sessionId) ?? 0, cleared: clearedSince(sessionId) });
    try {
      await next();
    } finally {
      turnStarts.delete(data.turnId);
    }
  });

  // === 回合结束时判一次是否该压缩（中止与出错的回合不判）===
  // 只认这一轮最后一次调用的用量：token:request 的快照不带 turnId，上一轮留下的属于别的回合；这一轮开始之后压成过或清空过的，
  // 它的用量是按那之前的历史算的，也不认。回合进行中不在后台改持久化的历史：长工具循环中途改历史，会与 agent 手里的
  // 消息列表对不上
  hooks.middleware('agent:turn:after', async (data, next) => {
    await next();
    if (data.outcome === 'aborted' || data.outcome === 'error') return;
    const { sessionId } = data;
    const usage = turnUsages.get(sessionId);
    const start = turnStarts.get(data.turnId);
    if (usage?.turnId !== data.turnId || !start || start.cleared()) return;
    if (start.compressions !== (compressions.get(sessionId) ?? 0)) return;
    if (summarizing.has(sessionId)) return;
    const failure = failures.get(sessionId);
    if (failure && ++failure.turns < Math.min(2 ** failure.count, MAX_RETRY_INTERVAL_TURNS)) return;
    const amounts = {
      used: usage.used,
      contextWindow: usage.contextWindow,
      tokenBudget: usage.tokenBudget,
      compressible: usage.breakdown.history + usage.breakdown.toolResults,
    };
    if (!compressionDue(amounts, { compressAt: compressAt(sessionId, usage.platform) })) return;
    logger.info(`用量 ${usage.used}/${usage.contextWindow} 到了自动压缩线，后台压缩: session=${sessionId}`);
    const cleared = clearedSince(sessionId);
    compressHistory(sessionId).catch(() => {
      // 期间被清空的不记：清理已丢掉这个会话的记录，留下清理前的次数会让之后的压缩迟迟不来
      if (!cleared()) failures.set(sessionId, { count: (failures.get(sessionId)?.count ?? 0) + 1, turns: 0 });
    });
  });

  // 统一记忆清除：通过 memory:clear hook 参与编排（删除会话也走它）
  hooks.middleware('memory:clear', async (data, next) => {
    // 类型过滤：摘要是归档消息的压缩，随 context 一起清（也可单独选 summary）；两者都不含时跳过
    if (data.types && !data.types.includes('summary') && !data.types.includes('context')) {
      await next();
      return;
    }
    if (data.scope === 'all') {
      clearAllEpoch++;
      turnUsages.clear();
      windows.clear();
      failures.clear();
      compressions.clear();
    } else if (data.sessionId) {
      clearEpoch.set(data.sessionId, (clearEpoch.get(data.sessionId) ?? 0) + 1);
      turnUsages.delete(data.sessionId);
      windows.delete(data.sessionId);
      failures.delete(data.sessionId);
      compressions.delete(data.sessionId);
    }
    // 代数已变，之后不会再有压缩过比对；已在落库的等它落定（成败都算落定，失败由压缩自己上报）
    await Promise.allSettled(data.scope === 'all' ? committing.values() : [committing.get(data.sessionId ?? '')]);

    try {
      const store = new SummaryStore(memory.require());
      if (data.scope === 'all') {
        await store.clearAll(logger);
        data.results.push({ source: 'summary', type: 'summary', success: true, message: '所有会话摘要已清空' });
        logger.info('所有会话摘要已清空');
      } else if (data.sessionId) {
        await store.clearSession(data.sessionId);
        data.results.push({ source: 'summary', type: 'summary', success: true, message: '当前会话摘要已清空' });
        logger.info(`会话摘要已清空: session=${data.sessionId}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      data.results.push({ source: 'summary', type: 'summary', success: false, message: `摘要清空失败: ${msg}` });
      logger.warn('摘要清空失败:', err);
    }

    await next();
  });

  // 清理
  lifecycle.onDispose(() => {
    logger.info('会话摘要插件已卸载');
  });
}
