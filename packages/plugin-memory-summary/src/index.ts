import type { TokenUsageEvent } from '@aalis/api-agent'; // 也是本包 declaration merging 的激活点（agent:* 钩子、agent:prompt 贡献点、token:usage 事件与会话设置的 historyLimit）——删掉会丢键类型，不可删
import { authority } from '@aalis/api-authority';
import { contributions } from '@aalis/api-contributions';
import { hooks } from '@aalis/api-hooks';
import type { LLMModel } from '@aalis/api-llm';
import { estimateMsgTokens, estimateTextTokens, lightestThinking, llm, resolveLLMModel } from '@aalis/api-llm';
import type { CompressionLines, MemoryService } from '@aalis/api-memory';
import { clearMetadataNamespaces, compression, compressionDue, compressionLine, memory } from '@aalis/api-memory';
import { messageArchive } from '@aalis/api-message-archive';
import { roomClass, type SessionSetting, sessionManager } from '@aalis/api-session-manager';
import type { BoundOf, Logger } from '@aalis/core';
import { config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { toSource } from '@aalis/schema-i18n';
import type { Message } from '@aalis/schema-message';
import { WellKnownKinds, WellKnownMetadataKeys } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';
import { t } from './texts.js';

/** 工具相关条目与通知进摘要输入时的每条硬截断（工具参数、结果各自适用），工具名不参与截断 */
const ENTRY_MAX_CHARS = 200;

/** 摘要模型没声明输出上限时按这个数封顶，与对话代理对模型输出上限的缺省假设相同 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** 摘要预算的下限：压掉的内容很少时也留够写全各小节的篇幅 */
const MIN_BUDGET = 1000;

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

/**
 * 进摘要输入的消息：对话、工具回合与通知（宿主通知、编排或定时任务派来的指令、平台通知）。system 消息不进，压缩分隔
 * 这类事件标记因此也不进
 */
const entersSummary = (m: Message) =>
  m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'notice';

/**
 * 摘要用消息格式化：content 已含 [昵称(ID)] 前缀，故不再叠加 m.name（否则双重身份 用户[123]: [Alice(123)]:）。
 *
 * 工具回合必须留痕：带 toolCalls 的 assistant 行 content 常为空，直译成「助手: (空)」
 * 等于告诉摘要模型「这一轮什么也没发生」；tool 结果整条丢掉则连做了什么都看不见。
 * 故两者都渲染成可读一行，名字优先保住、正文按 ENTRY_MAX_CHARS 硬截断。通知同样按它截断。
 *
 * 工具名按 toolCallId 从 `nameByToolCallId` 反查（见 {@link buildToolNameMap}），
 * 查不到才回落消息自带的 `name`。形参必填，避免误写成 `.map(formatMsgForSummary)`
 * 把数组下标当成映射传进来。
 */
function formatMsgForSummary(m: Message, nameByToolCallId: ReadonlyMap<string, string>): string {
  if (m.role === 'notice') return `通知: ${truncateChars((m.content ?? '').trim(), ENTRY_MAX_CHARS, '…') || '(空)'}`;
  if (m.role === 'tool') {
    const body = truncateChars((m.content ?? '').trim(), ENTRY_MAX_CHARS, '…');
    const toolName = (m.toolCallId ? nameByToolCallId.get(m.toolCallId) : undefined) ?? m.name;
    return `工具结果${toolName ? `(${toolName})` : ''}: ${body || '(空)'}`;
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const calls = m.toolCalls
      .map(
        tc =>
          `${tc.function?.name ?? '未知工具'}(${truncateChars(tc.function?.arguments ?? '', ENTRY_MAX_CHARS, '…')})`,
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

/** 落定前核对：现在的活跃历史开头与归档段逐条相同（时间戳、角色、正文与工具调用 id） */
function samePrefix(span: Message[], current: Message[]): boolean {
  return span.every((m, i) => {
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

/** 摘要输入里能整体留下或整体不留的一块：一条不带工具调用的消息，或带工具调用的 assistant 连同紧随其后的全部工具结果 */
interface Unit {
  /** 在归档段里的下标（工具组是连续的几条；待办那一行没有） */
  at: number[];
  /** 进摘要输入的文字：各行同 formatMsgForSummary，以换行相接；有编号时开头加标注 */
  text: string;
  /** 原样留在上下文里要占的 token：各条消息的 estimateMsgTokens 之和，按落库的消息算，不按截断后的行 */
  cost: number;
  /** 形状完整：不带工具调用的消息，或工具组里的结果恰好对上调用的 id、每个一条（清洗会整组收下、一条不跳的形状） */
  whole: boolean;
  /** 能保留时的编号，这次压缩里从 1 起按时间先后连续编 */
  id?: number;
}

/** 形状完整（见 Unit.whole）：结果与组首调用的 id 一一对上，对上一个划掉一个，重复的、多余的都对不上；单独的工具结果不算 */
function isWhole([head, ...results]: Message[]): boolean {
  if (head.role === 'tool') return false;
  const ids = new Set(head.toolCalls?.map(call => call.id));
  return results.length === ids.size && results.every(m => m.toolCallId !== undefined && ids.delete(m.toolCallId));
}

/** 把归档段分成单位：不进摘要的（system）跳过，照常归档 */
function buildUnits(span: Message[]): Unit[] {
  const names = buildToolNameMap(span);
  const units: Unit[] = [];
  for (let i = 0; i < span.length; i++) {
    if (!entersSummary(span[i])) continue;
    let end = i + 1;
    if (span[i].role === 'assistant' && span[i].toolCalls?.length) {
      while (span[end]?.role === 'tool') end++;
    }
    const messages = span.slice(i, end);
    units.push({
      at: messages.map((_, k) => i + k),
      text: messages.map(m => formatMsgForSummary(m, names)).join('\n'),
      cost: messages.reduce((sum, m) => sum + estimateMsgTokens(m), 0),
      whole: isWhole(messages),
    });
    i = end - 1;
  }
  return units;
}

/**
 * 切段与编号（预算与容量定下之后）：文字超过 half 的单位切成每段不超过 half 的几段（代理对不拆开），都不编号；其余形状完整、
 * 原样留下要占的不超过保留上限、加上标注之后不超过 half 的，按时间从 1 起编号，开头加「#编号〔约 N token〕」，N 是 cost
 */
function numberUnits(units: Unit[], keepCap: number, half: number): Unit[] {
  const queue: Unit[] = [];
  let numbered = 0;
  for (const unit of units) {
    if (unit.text.length > half) {
      for (let rest = unit.text; rest; ) {
        const piece = truncateChars(rest, half);
        rest = rest.slice(piece.length);
        queue.push({ ...unit, text: piece });
      }
      continue;
    }
    const text = `#${numbered + 1}〔约 ${unit.cost} token〕${unit.text}`;
    if (unit.whole && unit.cost <= keepCap && text.length <= half) queue.push({ ...unit, id: ++numbered, text });
    else queue.push(unit);
  }
  return queue;
}

const KEEP_TITLE = '【保留原文】';

/** 认标题用：去掉行首的空白与 Markdown 标记（标题、加粗、列表、引用），不改正文 */
const bare = (line: string) => line.replace(/^[\s#*>-]+/, '');

/** 只列编号：去掉编号与「无」之后只剩空白、标点与符号 */
const listsIds = (text: string) => !text.replace(/[#＃]\d+|无/g, '').replace(/[\s\p{P}\p{S}]/gu, '');

/**
 * 拆开摘要模型的回复：以【保留原文】开头的标题行（取这一行余下的部分）连同紧随其后、只列编号的各行是一个保留段，遇到别的行
 * 就结束；其余各行是摘要。保留段在前在后都认得，摘要正文里的 #数字不在保留段里。有几个保留段时都不进摘要，编号认最后一个；
 * 没有这个标题时 keep 为 undefined
 */
function parseSummary(text: string): { summary: string; keep?: string } {
  const summary: string[] = [];
  let keep: string[] | undefined;
  let segment: string[] | undefined;
  for (const line of text.split('\n')) {
    if (bare(line).startsWith(KEEP_TITLE)) {
      segment = [bare(line).slice(KEEP_TITLE.length)];
      keep = segment;
    } else if (segment && listsIds(line)) {
      segment.push(line);
    } else {
      segment = undefined;
      summary.push(line);
    }
  }
  return { summary: summary.join('\n').trim(), keep: keep?.join('\n') };
}

/** 一次请求里这些单位占的字数：各自的文字加一个换行 */
const charsOf = (units: Unit[]) => units.reduce((sum, unit) => sum + unit.text.length + 1, 0);
const costOf = (units: Unit[]) => units.reduce((sum, unit) => sum + unit.cost, 0);

// ===== 插件元数据 =====

const configSchema = defineConfig({
  summaryBudgetRatio: {
    type: 'number',
    label: t('budgetRatioLabel'),
    default: 0.1,
    min: 0,
    max: 0.5,
    description: t('budgetRatioDescription', { min: MIN_BUDGET }),
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
    /** 自动压缩线：用量占上下文窗口的比例，0 到 1；0 表示不按用量压缩（条数线照样起作用） */
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
    description: '用量到上下文窗口的这个比例时压缩；0 表示不按用量压缩（条数线照样起作用）',
  },
  appliesTo: ['owner', 'room', 'task'],
  prominence: 'advanced',
  liveOnly: true,
};

// ===== 摘要模板 =====

/** 摘要模板：对话的场合，与摘要的各小节（标题、这一节写什么），小节按顺序输出 */
interface SummaryTemplate {
  scene: string;
  sections: ReadonlyArray<readonly [title: string, content: string]>;
}

/** 聊天模板：场所是聊天窗口的根会话（多方窗口与别人的私聊），记谁在聊什么、谁还在等回应、哪些原话要记住 */
const CHAT_TEMPLATE: SummaryTemplate = {
  scene:
    '对话来自一个聊天窗口。消息开头的 [昵称(ID)] 标注了发言人，摘要里提到人时一律写成「昵称(ID)」，之后才能凭 ID 或昵称认出同一个人。',
  sections: [
    ['最近在聊什么', '按话题分段，写明每段的发言人'],
    ['谁有问题没回应', '点名提问或请求、还没得到回答的人与问题'],
    ['关键原话要点', '值得原样记住的话：承诺、约定、数字、链接、对助手的请求，保留发言人与原文要点'],
  ],
};

/** 工作模板：其余会话（owner 自己的会话、内部会话与全部子会话），按任务记 */
const WORK_TEMPLATE: SummaryTemplate = {
  scene: '对话是助手在完成任务：请求、回复、工具调用与工具结果。',
  sections: [
    ['目标', '这段对话要做成什么；最近一次请求，照录原话'],
    ['做过的决定', '定下的方案、放弃的方案与理由'],
    ['改过的文件', '路径与改了什么，只依据工具调用记录，不推测'],
    ['未完成的事', '待办列表的状态（以对话末尾的「当前任务列表状态」为准）、下一步'],
  ],
};

/**
 * 摘要模型的系统提示：模板的场合与小节，挑原文的规则，加上预算（摘要与保留的原文合计）与保留上限。保留编号的那一行放第一行：
 * 输出被截断时伤的只是摘要末尾。摘要仍要覆盖全部对话：挑中的原文可能因超出上限、分块腾地方或后一块没按格式而被去掉、随之归档
 */
function instructions({ scene, sections }: SummaryTemplate, budget: number, keepCap: number): string {
  return [
    `你是对话摘要助手，把对话压缩成一份摘要，并挑出值得原样保留的原文。${scene}`,
    '对话里能原样保留的部分以「#编号〔约 N token〕」开头，工具调用连同它的全部结果是一个整体、共用一个编号；没有编号的不能保留。',
    '值得原样保留的典型：正在进行的话题、未完成的事项、用户的明确指令、代码或数据原文。不必因为是最近几条就保留，按内容取舍。',
    '保留的原文会按原来的顺序原样接在摘要之后，但摘要仍要覆盖全部对话：挑出保留的部分照常概括，不必逐字复述。',
    `第一行写${KEEP_TITLE}，后面列出要保留的编号，如 #3 #12；一条都不留时写「无」。`,
    '之后按下面的小节依次输出，每节以小节标题（连同【】）单独一行开头，标题照写、顺序不变；某一小节没有内容时写「无」。',
    ...sections.map(([title, content]) => `【${title}】${content}`),
    `摘要与保留的原文合计约 ${budget} tokens（约 ${budget * 4} 个英文字符，或约 ${Math.floor(budget / 1.5)} 个中文字符），其中保留的原文合计不超过 ${keepCap} tokens，按编号后标的 token 数计；摘要写多少、原文留多少由你权衡，每个小节都要完整输出。`,
  ].join('\n');
}

/** 摘要请求的正文：给了已有摘要时要求在它的同名小节上合并 */
function summaryRequest(previous: string | undefined, conversation: string): string {
  return previous === undefined
    ? `请为以下对话生成摘要：\n${conversation}`
    : `以下是之前的对话摘要：\n${previous}\n\n以下是新增的对话内容。在之前摘要的同名小节上合并更新，旧内容里仍然成立的不要丢；之前的摘要没有这些小节、或小节与本模板不同时，把这些内容按意思归入对应小节，不保留模板之外的小节。输出完整的新摘要：\n${conversation}`;
}

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
 * 绑定一个提供者实例，按次构造：一次压缩（读历史 → 调 LLM → 写摘要 → 核对 → 归档或回滚）全程只认开头取到的那一个。
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
  /**
   * 登记会话设置项「自动压缩线」，按会话解析它与条数线，读会话记录选摘要模板；不在场时压缩线按默认 0.8、不按条数压缩，
   * 摘要用工作模板
   */
  sessionManager: optional(sessionManager),
  /** 选摘要模板时判一对一窗口的对端是不是 owner；不在场时按不是 */
  authority: optional(authority),
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
  const {
    memory,
    llm,
    messageArchive,
    sessionManager,
    authority,
    logger,
    events,
    hooks,
    contributions,
    lifecycle,
    provide,
  } = caps;
  const parsed = parseConfig(configSchema, caps.config.use, logger.use);
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
  sessionManager.use.registerSetting(COMPRESS_AT_SETTING);

  logger.use.info('会话摘要插件已启动（摘要持久化经由 memory.metadata）');

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
   * 已过比对、正在落库（写摘要 → 重读核对 → 归档 → 写标记）的会话。比对与落库之间隔着数据库往返，清理在其间开始时
   * 比对拦不住：清理先等这一段落定再删，删掉的就包括它刚写进去的
   */
  const committing = new Map<string, Promise<unknown>>();

  /** 每个会话最近一条真实回合的用量（带 turnId）：回合结束时只认这一轮的那条做判定 */
  const turnUsages = new Map<string, TokenUsageEvent>();
  /** 每个会话最近一次用量（真实回合与 token:request 的快照都记），供摘要预算算压缩线 */
  const lastUsages = new Map<string, TokenUsageEvent>();
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

  /**
   * 这个会话的两条线：自动压缩线在会话设置的各层都没设（或没有会话管理）时为默认 0.8；条数线是 agent 登记的 historyLimit，
   * 没设时不按条数压缩。platform 是入口平台：没有出生平台的会话按它选平台档
   */
  function linesOf(sessionId: string, platform?: string): CompressionLines {
    const resolved = sessionManager.present ? sessionManager.use.resolveConfig(sessionId, platform) : undefined;
    return { compressAt: resolved?.compressAt ?? DEFAULT_COMPRESS_AT, historyLimit: resolved?.historyLimit };
  }

  /** 这个会话的压缩线（compressionLine），按最近一次用量算；还没有用量时为 Infinity（不封顶） */
  function usageLine(sessionId: string): number {
    const usage = lastUsages.get(sessionId);
    return usage ? compressionLine(usage, linesOf(sessionId, usage.platform).compressAt) : Infinity;
  }

  /**
   * 摘要预算（摘要与保留的原文合计）：这次重写的输入 × summaryBudgetRatio，越旧的内容每经一次压缩就再缩一次；不少于
   * MIN_BUDGET。不超过物理上限的三分之二，与这个会话压缩线的四分之一（有用量时，压过下限：摘要是每轮重发的常驻块，小窗口的
   * 会话里摘要一大，之后每轮都到线或被硬裁剪）
   */
  function summaryBudget(sessionId: string, physical: number, input: number): number {
    return Math.min(
      Math.floor(physical / 1.5),
      Math.floor(usageLine(sessionId) / 4),
      Math.max(MIN_BUDGET, Math.floor(cfg.summaryBudgetRatio * input)),
    );
  }

  /**
   * 选摘要模板：根会话且房间类别为 room（多方的聊天窗口，或对端不是 owner 的一对一）用聊天模板，其余用工作模板；
   * 子会话执行任务，根会话是群也用工作模板。没有会话管理时按工作模板，没有权限服务时一对一的对端按不是 owner
   */
  function templateOf(sessionId: string): SummaryTemplate {
    const sessions = sessionManager.present ? sessionManager.use : undefined;
    const info = sessions?.getSession(sessionId);
    if (!sessions || info?.parentId) return WORK_TEMPLATE;
    const isOwner = (platform: string, userId: string) =>
      authority.present ? authority.use.isOwner(platform, userId) : false;
    return roomClass(info, id => sessions.getSession(id), isOwner) === 'room' ? CHAT_TEMPLATE : WORK_TEMPLATE;
  }

  /**
   * 调一次摘要模型，拆出摘要与保留段（parseSummary）：模型失败、流式中途断开、写满了输出上限或摘要为空都以原因抛出。
   * 有已有摘要时要求在它的同名小节上合并
   */
  async function askSummaryModel(
    model: LLMModel,
    sessionId: string,
    system: string,
    maxTokens: number,
    previous: string | undefined,
    conversation: string,
  ): Promise<{ summary: string; keep?: string }> {
    const messages: Message[] = [
      { role: 'system', content: system },
      { role: 'user', content: summaryRequest(previous, conversation) },
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
    let completionTokens: number | undefined;
    try {
      const stream = model.chatStream?.(request);
      if (stream) {
        for await (const chunk of stream) {
          text += chunk.contentDelta ?? '';
          if (chunk.usage) completionTokens = chunk.usage.completionTokens;
        }
      } else {
        const response = await model.chat(request);
        text = response.content ?? '';
        completionTokens = response.usage?.completionTokens;
      }
    } catch (err) {
      // 半截流式输出一并丢弃：provider 超时常在吐出部分内容后中断流，截断的文本入库会成为之后所有增量摘要的基底
      throw new Error(`摘要模型调用失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    // 写满了输出上限的可能是被截断的，同样丢弃；服务商不报用量时查不出来
    if (completionTokens !== undefined && completionTokens >= maxTokens) {
      throw new Error('摘要模型写满了输出上限，输出可能不完整');
    }
    const reply = parseSummary(text);
    if (!reply.summary) throw new Error('摘要模型返回了空内容');
    return reply;
  }

  /**
   * 这一次请求挑中的单位（按时间排）。编号要在这次请求里出现过：不存在的丢掉、重复的算一次；合计超过 cap 时从最早的起去掉，
   * 直到不超或一个不剩（去掉的在这次的输入里，摘要按提示覆盖了它们）。没有保留段、或段里写了字却认不出编号时一个不留，记告警；
   * 段为空或写「无」时不告警；这次请求里没有编号可选时，没有保留段也不告警
   */
  function keptOf(keep: string | undefined, offered: Unit[], cap: number, sessionId: string): Unit[] {
    if (keep === undefined) {
      if (offered.some(unit => unit.id !== undefined)) {
        logger.use.warn(`摘要模型没有按格式列出保留原文的编号，这次只用摘要: session=${sessionId}`);
      }
      return [];
    }
    const ids = new Set([...keep.matchAll(/[#＃](\d+)/g)].map(match => Number(match[1])));
    if (ids.size === 0) {
      if (!listsIds(keep)) logger.use.warn(`没认出保留原文的编号，这次不保留原文: session=${sessionId}`);
      return [];
    }
    let kept = offered.filter(unit => unit.id !== undefined && ids.has(unit.id));
    if (kept.length < ids.size) {
      logger.use.debug(
        `摘要模型列出的保留编号有 ${ids.size - kept.length} 个不在这次的输入里，已丢掉: session=${sessionId}`,
      );
    }
    while (kept.length > 0 && costOf(kept) > cap) kept = kept.slice(1);
    return kept;
  }

  /**
   * 把归档段连同已有摘要交给摘要模型，得到新摘要与挑中、原样保留的单位。预算按这次重写的输入（已有摘要加各单位的文字，不计
   * 编号标注）算，摘要与保留的原文合计约为它；保留上限是 min(预算, ⌊比例 × 这次新压的对话⌋)，不算已有摘要：下限只托住摘要，
   * 已有摘要再长也撑不大它，新压的少时留得很少，压完不会仍在线上。
   * 请求的输出上限是预算的 1.5 倍：提示词按每 token 4 个英文字符换算，路径、代码这类文本的真实分词更密，推理模型的
   * 推理 token 也算在输出上限里。每次请求的输入加输出上限都要装进摘要模型的窗口：已有摘要按至多物理上限那么多 token 算（上一份
   * 可能是按更大的预算写的），系统提示、请求里的固定文字与对话按每字至多 2 token 保守折算，余下的折成每次放对话的字数（容量，
   * 编号标注与重发的保留单位都算在内）。放不下时分几次请求：每次是上一次挑中的单位（原样、带原编号）加按顺序放得下的新单位，
   * 上一次的摘要作为已有摘要，与跨压缩时把已保留的原文和新内容一起重挑是同一种做法；腾地方时去掉的保留单位在之前那次的输入里，
   * 摘要覆盖了它。任何一次失败整次失败；每次返回后会话被清空过的，整次作废
   */
  async function summarize(
    model: LLMModel,
    sessionId: string,
    span: Message[],
    previous: string | undefined,
    cleared: () => boolean,
  ): Promise<{ summary: string; kept: Unit[] }> {
    const template = templateOf(sessionId);
    const units = buildUnits(span);
    // 工作模板的「未完成的事」以待办为准：归档段里最后一次待办的参数作为最后一行，不能保留
    if (template === WORK_TEMPLATE) {
      const todo = span
        .flatMap(m => m.toolCalls ?? [])
        .filter(call => call.function.name === 'manage_todo_list')
        .at(-1)?.function.arguments;
      if (todo) units.push({ at: [], text: `当前任务列表状态：\n${todo}`, cost: 0, whole: false });
    }
    // 物理上限：摘要模型一次写得出的长度，至多它窗口的四分之一（请求里的已有摘要与输出各占至多四分之一，另一半留给提示词与对话）
    const physical = Math.min(model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(model.contextLength / 4));
    const added = units.reduce((sum, unit) => sum + estimateTextTokens(unit.text), 0);
    const budget = summaryBudget(sessionId, physical, added + estimateTextTokens(previous ?? ''));
    const keepCap = Math.min(budget, Math.floor(cfg.summaryBudgetRatio * added));
    // 预算不超过物理上限的三分之二，输出上限因此也不超过物理上限
    const maxTokens = Math.ceil(1.5 * budget);
    const system = instructions(template, budget, keepCap);
    // 请求里的固定文字按带已有摘要的那一种（较长）算
    const prompt = system.length + summaryRequest('', '').length;
    const capacity = Math.floor((model.contextLength - physical - maxTokens) / 2) - prompt;
    // 大单位切成至多容量一半的段：一半至少两个码元，每段才至少有一个字符（代理对不拆开），切分才能前进
    if (capacity < 4) {
      throw new Error(
        `摘要模型的上下文窗口（${model.contextLength}）装不下提示词、已有摘要与摘要的输出上限（${maxTokens}）`,
      );
    }
    const queue = numberUnits(units, keepCap, Math.floor(capacity / 2));
    let summary = previous;
    let kept: Unit[] = [];
    let next = 0;
    do {
      // 队首放不下时从最早的保留单位起去掉：队首至多占容量的一半，保留的去到不超过另一半时必能放下
      while (charsOf(kept) + queue[next].text.length + 1 > capacity) kept = kept.slice(1);
      const offered = [...kept];
      let room = capacity - charsOf(kept);
      while (next < queue.length && queue[next].text.length + 1 <= room) {
        room -= queue[next].text.length + 1;
        offered.push(queue[next++]);
      }
      const conversation = offered.map(unit => unit.text).join('\n');
      const reply = await askSummaryModel(model, sessionId, system, maxTokens, summary, conversation);
      if (cleared()) throw new Error('压缩期间会话被清空');
      summary = reply.summary;
      kept = keptOf(reply.keep, offered, Math.min(keepCap, budget - estimateTextTokens(summary)), sessionId);
    } while (next < queue.length);
    return { summary, kept };
  }

  /**
   * 落定：写摘要 → 重读活跃历史、核对开头与归档段逐条相同 → 归档这一段（keep 列出的位置不归档）→ 写分隔标记。核对在写摘要
   * 之后，与归档之间只隔这一次重读：回滚删了段里的消息、晚到的消息时间戳插进了这一段，位置就会错开，归档会归掉没进摘要的消息、
   * 拆开保留的工具组。核对不过时以「压缩期间历史被改动」失败；它与归档抛错都把摘要回滚到写入前，原样抛出
   */
  async function commitCompression(
    provider: MemoryService,
    store: SummaryStore,
    sessionId: string,
    span: Message[],
    keep: number[],
    previous: string | undefined,
    summary: string,
  ): Promise<void> {
    const at = Date.now();
    await store.upsertSummary(sessionId, summary);
    let archived: number;
    try {
      if (!samePrefix(span, await provider.getHistory(sessionId, Infinity))) throw new Error('压缩期间历史被改动');
      archived = await provider.archiveSpan(sessionId, { count: span.length, keep });
    } catch (err) {
      // 摘要已写、历史没归档：下一次压缩会把同一段历史再并进这份新摘要，故回滚到写入前
      try {
        if (previous) await store.upsertSummary(sessionId, previous);
        else await store.clearSession(sessionId);
      } catch (rollbackErr) {
        logger.use.warn('没落定，回滚摘要也失败（下一次压缩会把这一段再并进新摘要）:', rollbackErr);
      }
      throw err;
    }
    logger.use.info(`会话已压缩: session=${sessionId}, 归档 ${archived} 条，保留 ${keep.length} 条原文`);
    // 系统事件消息，供前端持久化显示压缩分隔线：正文是原文，文字对象另记，界面按读者语言显示
    if (!messageArchive.present) return;
    const compacted = t('compacted');
    await messageArchive.use.saveMessage(sessionId, {
      role: 'system',
      kind: WellKnownKinds.EventMarker,
      content: toSource(compacted),
      timestamp: at,
      metadata: { [WellKnownMetadataKeys.Text]: compacted },
    });
  }

  /**
   * 全量压缩一次（后台与手动共用）：快照全部活跃历史，切分点之前的全部（归档段）连同已有摘要压成一份新摘要，写摘要、核对快照
   * 前缀没被改过、归档这一段、写分隔标记；摘要模型挑出的单位与切分点之后的消息（快照之后到达的、没写全的工具调用组）原样留在
   * 活跃历史里。进度经 session:compressing 报 start、done、error，报 done 才算压成（界面据此插「对话已压缩」）。
   * 没压成（摘要模型不在、模型失败、期间被清空或历史被改动）时以原因拒绝，不留下写入（已写的摘要回滚）；待摘要部分没有对话时
   * 什么都不做、不报进度；开始之前就失败的（正在压缩、记忆不在、读不出历史）只拒绝，也不报
   */
  async function compressHistory(sessionId: string): Promise<void> {
    if (summarizing.has(sessionId)) throw new Error('这个会话正在压缩，稍后再试');
    summarizing.add(sessionId);
    const cleared = clearedSince(sessionId);
    const report = (status: 'start' | 'done' | 'error') =>
      void events.use.emit('session:compressing', { sessionId, status });

    let started = false;
    try {
      // 读快照、核对前缀到落定压缩固定同一家记忆后端：途中换了人也不会读一家、写另一家
      const provider = memory.list().find(p => p.selected)?.use;
      if (!provider) throw new Error('memory 服务不可用');
      const snapshot = await provider.getHistory(sessionId, Infinity);
      const span = snapshot.slice(0, cutPoint(snapshot));
      if (!span.some(entersSummary)) return;
      report('start');
      started = true;
      // global 按默认优先级选首个能对话的模型；custom 按 summaryLLM 精确匹配，常见的落空是它指向的 provider 被卸载或重载中
      const ref = cfg.summaryModelMode === 'custom' ? cfg.summaryLLM : undefined;
      const model = resolveLLMModel(llm, ref, ['chat'])?.use;
      if (!model) {
        throw new Error(
          ref
            ? `摘要模型解析失败（${ref.provider}/${ref.model} 不存在或未激活）`
            : '摘要模型解析失败（检查 summaryModelMode/summaryLLM 配置）',
        );
      }
      const store = new SummaryStore(provider);
      const previous = (await store.getSummary(sessionId))?.summary || undefined;
      const { summary, kept } = await summarize(model, sessionId, span, previous, cleared);
      if (cleared()) throw new Error('压缩期间会话被清空');
      const keep = kept.flatMap(unit => unit.at);
      const commit = commitCompression(provider, store, sessionId, span, keep, previous, summary);
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
      logger.use.warn(`压缩没有压成: session=${sessionId}`, err);
      if (started) report('error');
      throw err;
    } finally {
      summarizing.delete(sessionId);
    }
  }

  // === 贡献：在 LLM 调用前注入摘要（agent:prompt / context 槽）===
  // 不按预算截断：生成时的 maxTokens 已是上限；换了窗口更小的模型时，下一次压缩会重写摘要，期间由硬裁剪兜底
  contributions.use.contribute('agent:prompt', {
    id: 'memory-summary',
    anchor: 'context',
    async build(view) {
      if (!view.sessionId) return null;
      const existing = await new SummaryStore(memory.use).getSummary(view.sessionId);
      return existing?.summary
        ? `以下是之前对话的摘要，包含了较早的对话上下文。压缩时原样保留的原文（如果有）按原来的时间顺序排在之后的历史开头，内容已在摘要里概括过：\n${existing.summary}`
        : null;
    },
  });

  provide.use(
    compression,
    {
      compress(sessionId, request) {
        logger.use.info(`收到压缩请求: session=${sessionId}, reason=${request.reason}`);
        return compressHistory(sessionId);
      },
      compressAt: (sessionId, platform) => linesOf(sessionId, platform).compressAt || undefined,
    },
    { label: '会话压缩' },
  );

  events.use.on('token:usage', usage => {
    lastUsages.set(usage.sessionId, usage);
    if (usage.turnId) turnUsages.set(usage.sessionId, usage);
  });

  // 回合从开始（agent:input:before）到它的 next 返回为止：记下开始时的压缩代数与清空代数，被下游拦下、出错的一轮同样在 finally 里丢掉
  hooks.use.middleware('agent:input:before', async (data, next) => {
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
  // 消息列表对不上。可压缩部分按硬裁剪之前的历史算：裁掉的仍在会话里，全量压缩一并压掉。会话条数是回合结束时的：
  // 结局为 replied 时最终回复在最后一次调用之后落库，加上这一条
  hooks.use.middleware('agent:turn:after', async (data, next) => {
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
      compressible: usage.untrimmedHistory,
      trimmed: usage.trimmed,
      historyMessages: usage.historyMessages + (data.outcome === 'replied' ? 1 : 0),
    };
    if (!compressionDue(amounts, linesOf(sessionId, usage.platform))) return;
    logger.use.info(
      `到了压缩线（用量 ${usage.used}/${usage.contextWindow}${usage.trimmed ? '，被硬裁剪过' : ''}，会话条数 ${amounts.historyMessages}），后台压缩: session=${sessionId}`,
    );
    const cleared = clearedSince(sessionId);
    compressHistory(sessionId).catch(() => {
      // 期间被清空的不记：清理已丢掉这个会话的记录，留下清理前的次数会让之后的压缩迟迟不来
      if (!cleared()) failures.set(sessionId, { count: (failures.get(sessionId)?.count ?? 0) + 1, turns: 0 });
    });
  });

  // 统一记忆清除：通过 memory:clear hook 参与编排（删除会话也走它）
  hooks.use.middleware('memory:clear', async (data, next) => {
    // 类型过滤：摘要是归档消息的压缩，随 context 一起清（也可单独选 summary）；两者都不含时跳过
    if (data.types && !data.types.includes('summary') && !data.types.includes('context')) {
      await next();
      return;
    }
    if (data.scope === 'all') {
      clearAllEpoch++;
      turnUsages.clear();
      lastUsages.clear();
      failures.clear();
      compressions.clear();
    } else if (data.sessionId) {
      clearEpoch.set(data.sessionId, (clearEpoch.get(data.sessionId) ?? 0) + 1);
      turnUsages.delete(data.sessionId);
      lastUsages.delete(data.sessionId);
      failures.delete(data.sessionId);
      compressions.delete(data.sessionId);
    }
    // 代数已变，之后不会再有压缩过比对；已在落库的等它落定（成败都算落定，失败由压缩自己上报）
    await Promise.allSettled(data.scope === 'all' ? committing.values() : [committing.get(data.sessionId ?? '')]);

    try {
      const store = new SummaryStore(memory.use);
      if (data.scope === 'all') {
        await store.clearAll(logger.use);
        data.results.push({ source: 'summary', type: 'summary', success: true, message: '所有会话摘要已清空' });
        logger.use.info('所有会话摘要已清空');
      } else if (data.sessionId) {
        await store.clearSession(data.sessionId);
        data.results.push({ source: 'summary', type: 'summary', success: true, message: '当前会话摘要已清空' });
        logger.use.info(`会话摘要已清空: session=${data.sessionId}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      data.results.push({ source: 'summary', type: 'summary', success: false, message: `摘要清空失败: ${msg}` });
      logger.use.warn('摘要清空失败:', err);
    }

    await next();
  });

  // 清理
  lifecycle.use.onDispose(() => {
    logger.use.info('会话摘要插件已卸载');
  });
}
