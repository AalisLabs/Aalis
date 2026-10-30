import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { commands } from '@aalis/api-commands';
import { contributions } from '@aalis/api-contributions';
import { hooks } from '@aalis/api-hooks';
import { i18n, outputLanguageFor } from '@aalis/api-i18n';
import { type ChatResponse, chatModelPicker, lightestThinking, llm } from '@aalis/api-llm';
import { clearMetadataNamespaces, type MemoryService, memory } from '@aalis/api-memory';
import { persona } from '@aalis/api-persona';
import { tools } from '@aalis/api-tools';
import { userRelation } from '@aalis/api-user-relation';
import { webuiServer } from '@aalis/api-webui';
import { type BoundOf, config, definePlugin, events, logger, optional } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { TextError, type TextRef, textClauses, textLines, textOf } from '@aalis/schema-i18n';
import type { IncomingMessage, Message } from '@aalis/schema-message';
import { DIRECTIVE_KINDS, WellKnownMetadataKeys, wasAddressed } from '@aalis/schema-message';
import { parseLLMJsonObject } from '@aalis/util-json-repair';
import { t } from './texts.js';

// ════════════════════════════════════════════════════════════
// plugin-user-profile — 用户事实档案
//
// 通过 LLM 从对话中提取「关于用户的长期事实」（喜好、经历、关系、近况），
// 按 platform:userId 维度落库到 memory metadata 的 user:profile namespace。
// 在 LLM 调用前注入到系统提示，让 Aalis 真正「记得这个人」。
//
// 设计原则：
// - 单点落库：所有事实存在一个 metadata 文档，避免散落多处
// - 冷却节流：同一用户在 N 秒内不重复提取，避免 LLM 调用风暴
// - 渐进合并：每次提取由 LLM 输出 add/remove 两个数组，自然演化
// - 零侵入：通过 events + middleware 接入，不修改 agent / persona / memory
//
// 关系强度（relationScore, 0~100）计算规则（只算真人的话，带来源的注入不加）：
// - 每条入站消息（无论 agent 是否回复）：+ relationIncrementWitness（默认 0.1，旁观档）
// - 若 agent 触发回复，额外叠加：
//     direct（私聊）        + relationIncrementDirect    默认 1.0
//     immediate（@/呼名）   + relationIncrementImmediate 默认 1.5
//     interval（被动触发）  + relationIncrementInterval  默认 0.5
// - 每日衰减：(now - lastInteractionAt) 天数 × relationScoreDecayPerDay（默认 0.5/天）
// - 上限 100，下限 0
// 例：群聊纯旁观一条 = +0.1；群聊被 @ 并回复 = +0.1 + 1.5 = +1.6；私聊一条 = +0.1 + 1.0 = +1.1
// ════════════════════════════════════════════════════════════

const PROFILE_NS = 'user:profile';

/** 人设服务不在、或卡没取名时，提取提示里对机器人的称呼 */
const BOT_FALLBACK_NAME = '机器人';

const configSchema = defineConfig({
  extractEveryNMessages: {
    type: 'number',
    label: t('extractEveryLabel'),
    description: t('extractEveryDescription'),
    default: 5,
  },
  historyForExtraction: {
    type: 'number',
    label: t('historyLabel'),
    description: t('historyDescription'),
    default: 8,
  },
  maxFactsPerUser: {
    type: 'number',
    label: t('maxFactsLabel'),
    description: t('maxFactsDescription'),
    default: 30,
  },
  maxFactCharsPerItem: {
    type: 'number',
    label: t('maxFactCharsLabel'),
    description: t('maxFactCharsDescription'),
    default: 80,
  },
  maxOtherParticipants: {
    type: 'number',
    label: t('maxOthersLabel'),
    description: t('maxOthersDescription'),
    default: 3,
  },
  maxFactsForOthers: {
    type: 'number',
    label: t('maxFactsForOthersLabel'),
    description: t('maxFactsForOthersDescription'),
    default: 5,
  },
  temporaryFactMaxAgeDays: {
    type: 'number',
    label: t('temporaryMaxAgeLabel'),
    description: t('temporaryMaxAgeDescription'),
    default: 90,
  },
  relationScoreDecayPerDay: {
    type: 'number',
    label: t('decayLabel'),
    description: t('decayDescription'),
    default: 0.5,
  },
  relationIncrementDirect: {
    type: 'number',
    label: t('directLabel'),
    description: t('directDescription'),
    default: 1,
  },
  relationIncrementImmediate: {
    type: 'number',
    label: t('immediateLabel'),
    description: t('immediateDescription'),
    default: 1.5,
  },
  relationIncrementInterval: {
    type: 'number',
    label: t('intervalLabel'),
    description: t('intervalDescription'),
    default: 0.5,
  },
  relationIncrementWitness: {
    type: 'number',
    label: t('witnessLabel'),
    description: t('witnessDescription'),
    default: 0.1,
  },
  allowGlobalBackfill: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('backfillLabel'),
    description: t('backfillDescription'),
    default: false,
  },
});

/**
 * 事实分类，用于 LLM 在同类下做覆写决策。分类值是给模型的、落盘的标识，界面显示这里的名字；
 * 次序即提示词里列出与档案分组的次序
 */
const CATEGORY_NAMES = {
  兴趣爱好: t('categoryInterests'),
  职业身份: t('categoryOccupation'),
  人际关系: t('categoryRelationships'),
  近期处境: t('categorySituation'),
  价值观: t('categoryValues'),
  性格特征: t('categoryPersonality'),
  偏好: t('categoryPreferences'),
  忌讳: t('categoryTaboos'),
  其他: t('categoryOther'),
} as const;
type FactCategory = keyof typeof CATEGORY_NAMES;
const KNOWN_CATEGORIES = Object.keys(CATEGORY_NAMES) as FactCategory[];
type FactTemporality = 'permanent' | 'temporary';

interface Fact {
  /** 稳定短 ID，LLM 通过它精确指定要 update / remove 的事实 */
  id: string;
  /** 事实正文 */
  text: string;
  /** 事实分类，可空 */
  category?: FactCategory;
  /** 事实时效：temporary 会随时间淡出 prompt；permanent 长期有效 */
  temporality: FactTemporality;
  /** 首次学习到该事实的时间戳 */
  observedAt: number;
  /** LLM 提取出的自然语言时间线索，如“最近”“上周”“2026年4月” */
  timeHint?: string;
  /** 最近一次写入或更新的时间戳 */
  updatedAt: number;
}

interface UserProfile {
  /** 关于该用户的事实列表（最新更新的在末尾） */
  facts: Fact[];
  /** 0~100，基于持续互动累计并随时间衰减的关系强度 */
  relationScore?: number;
  /** 已观察到的入站互动次数 */
  interactionCount?: number;
  /** 最近一次互动时间 */
  lastInteractionAt?: number;
  /** 上次提取/合并的时间戳 */
  updatedAt: number;
}

type UserProfileConfig = ConfigOf<typeof configSchema>;

/** 生成事实的稳定短 ID（前缀 f 加 5 位 base36，对 30 条以内规模碰撞概率极低） */
function genShortId(existing: Set<string>): string {
  for (let i = 0; i < 8; i++) {
    const id = `f${Math.random().toString(36).slice(2, 7)}`;
    if (!existing.has(id)) return id;
  }
  // 极端兜底：加时间戳后缀
  return `f${Date.now().toString(36).slice(-5)}`;
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = String(value).toLowerCase();
  const exponentIndex = text.indexOf('e');
  if (exponentIndex >= 0) {
    const mantissa = text.slice(0, exponentIndex);
    const exponent = Number(text.slice(exponentIndex + 1));
    const mantissaDecimals = mantissa.split('.')[1]?.replace(/0+$/, '').length ?? 0;
    return Math.max(0, mantissaDecimals - exponent);
  }
  return text.split('.')[1]?.replace(/0+$/, '').length ?? 0;
}

function metadataString(message: Message, key: string): string | undefined {
  const value = message.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getMessageUserId(message: Message): string | undefined {
  return metadataString(message, WellKnownMetadataKeys.UserId) ?? message.name;
}

function isTargetUserMessage(message: Message, userId: string, platform: string): boolean {
  if (message.role !== 'user' || !message.content) return false;
  const msgUserId = getMessageUserId(message);
  if (msgUserId !== userId) return false;
  const msgPlatform = metadataString(message, WellKnownMetadataKeys.Platform);
  return !msgPlatform || !platform || msgPlatform === platform;
}

/**
 * 核对原话的规整，原话与语料用同一份：NFKC（全角与半角、兼容写法归成同一个字）、小写，去掉 Unicode 标点、空白与不显示的字符
 * （表情里的变体选择符与连接符）；符号照留，「C++」不会只剩一个字母
 */
function normalizeForQuoteMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\s\p{Default_Ignorable_Code_Point}]+/gu, '');
}

/**
 * 目标用户各条发言规整后的语料，原话的片段要落在其中某一条里。只收发言人自己写的字（存档另记的 SpokenContent，没记就是归档
 * 正文本身）：被引用的原文、识图、语音转写、视频描述、文件正文与合并转发都不在发言人的话里
 */
function buildTargetUserCorpus(history: Message[], userId: string, platform: string): string[] {
  return history
    .filter(m => isTargetUserMessage(m, userId, platform))
    .map(m => {
      const spoken = m.metadata?.[WellKnownMetadataKeys.SpokenContent];
      return normalizeForQuoteMatch(typeof spoken === 'string' ? spoken : (m.content ?? ''));
    });
}

/**
 * 渲染完整会话历史供提取 LLM 作为消歧上下文：
 * 每行带身份标签区分「目标用户」「其他用户」与她自己（botName），
 * 不做 strip：给模型看的是归档正文（引用、附件描述与转发都在，消歧要用）；
 * 核对原话另取发言人自己写的话（buildTargetUserCorpus）。
 */
function renderHistoryForExtract(history: Message[], userId: string, platform: string, botName: string): string {
  return history
    .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'notice') && m.content)
    .map(m => {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
      const content = (m.content ?? '').trim();
      if (!content) return '';
      if (m.role === 'assistant') {
        // 她的回复：加标签让 LLM 知道用户是在跟谁互动，用于判断用户对她的行为
        return `[${time}] [${botName}]: ${content}`;
      }
      if (m.role === 'notice') {
        // 平台事件（群禁言 / 撤回 / 成员进出 / poke 等），供提取判断「用户被谁怎么了」之类上下文
        return `[${time}] [系统通知]: ${content}`;
      }
      const nickname = metadataString(m, WellKnownMetadataKeys.Nickname);
      const msgUserId = getMessageUserId(m) ?? '';
      const msgPlatform = metadataString(m, WellKnownMetadataKeys.Platform);
      const isTarget = msgUserId === userId && (!msgPlatform || !platform || msgPlatform === platform);
      const label = nickname ? `${nickname}(${msgUserId || '?'})` : msgUserId || '?';
      const tag = isTarget ? '目标用户' : '其他用户';
      return `[${time}] [${tag} ${label}]: ${content}`;
    })
    .filter(Boolean)
    .join('\n');
}

/** 解析一次提取的回复：在输出上限处停下的不完整，看着是合法 JSON 也不收。不能用时交回原因，写进日志与重试提示 */
function readExtractReply(resp: ChatResponse): { parsed: Record<string, unknown> } | { why: string } {
  if (resp.finishReason === 'length') return { why: '在长度上限处被截断，不完整' };
  const { parsed } = parseLLMJsonObject((resp.content ?? '').trim());
  return parsed ? { parsed } : { why: '不是合法的 JSON 对象' };
}

const uses = {
  memory,
  llm,
  events,
  hooks,
  contributions,
  config,
  logger,
  tools: optional(tools),
  commands: optional(commands),
  userRelation: optional(userRelation),
  /** 提取提示里机器人的称呼取人设名；缺席时用中性称呼 */
  persona: optional(persona),
  /** 事实的语言：取全局层的语言列表（读者是 owner），缺席时按中文 */
  i18n: optional(i18n),
  /** 档案页；不在时照常记档案 */
  webui: optional(webuiServer),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-user-profile',
  displayName: t('displayName'),
  subsystem: 'memory',
  configSchema,
  uses,
  apply: registerUserProfile,
});

function registerUserProfile({
  memory,
  llm,
  events,
  hooks,
  contributions,
  config,
  logger,
  tools,
  commands,
  userRelation,
  persona,
  i18n,
  webui,
}: Caps): void {
  const parsed = parseConfig(configSchema, config.use, logger.use);
  const cfg: UserProfileConfig = {
    ...parsed,
    historyForExtraction: Math.max(2, parsed.historyForExtraction),
    maxFactsPerUser: Math.max(5, parsed.maxFactsPerUser),
    maxFactCharsPerItem: Math.max(20, parsed.maxFactCharsPerItem),
    maxOtherParticipants: Math.max(0, parsed.maxOtherParticipants),
    maxFactsForOthers: Math.max(1, parsed.maxFactsForOthers),
    temporaryFactMaxAgeDays: Math.max(0, parsed.temporaryFactMaxAgeDays),
    relationScoreDecayPerDay: Math.max(0, parsed.relationScoreDecayPerDay),
    relationIncrementDirect: Math.max(0, parsed.relationIncrementDirect),
    relationIncrementImmediate: Math.max(0, parsed.relationIncrementImmediate),
    relationIncrementInterval: Math.max(0, parsed.relationIncrementInterval),
    relationIncrementWitness: Math.max(0, parsed.relationIncrementWitness),
  };

  /** 每会话每用户累计入站消息数（用于 extractEveryNMessages 计数），不随提取重置 */
  const userMessageCount = new Map<string, number>();
  /** 防止同一用户的提取并发触发 */
  const inflightExtractions = new Set<string>();
  /** 提取模型：llm 服务给本插件挑的能对话的那一个（见 chatModelPicker） */
  const pickChatModel = chatModelPicker(llm, () => logger.use.warn('没有可用的对话模型，事实提取跳过'));
  const relationScorePrecision = Math.min(
    6,
    Math.max(
      decimalPlaces(cfg.relationScoreDecayPerDay),
      decimalPlaces(cfg.relationIncrementDirect),
      decimalPlaces(cfg.relationIncrementImmediate),
      decimalPlaces(cfg.relationIncrementInterval),
    ),
  );

  function userKeyOf(platform: string | undefined, userId: string): string {
    return `${platform ?? ''}:${userId}`;
  }

  function extractionCountKeyOf(sessionId: string, platform: string | undefined, userId: string): string {
    return `${sessionId}:${userKeyOf(platform, userId)}`;
  }

  function normalizeTemporality(v: unknown, category?: FactCategory): FactTemporality {
    if (v === 'permanent' || v === 'temporary') return v;
    return category === '近期处境' ? 'temporary' : 'permanent';
  }

  function normalizeTextField(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    return s.length > 0 ? s.slice(0, 40) : undefined;
  }

  /** 解析 metadata 中的事实数组；缺正文、id、时效或时间戳的条目跳过 */
  function parseFactArray(raw: unknown[]): Fact[] {
    const usedIds = new Set<string>();
    const facts: Fact[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const text = typeof obj.text === 'string' ? obj.text.trim() : '';
      if (
        !text ||
        typeof obj.id !== 'string' ||
        !obj.id.trim() ||
        (obj.temporality !== 'permanent' && obj.temporality !== 'temporary') ||
        typeof obj.observedAt !== 'number' ||
        typeof obj.updatedAt !== 'number'
      ) {
        continue;
      }
      let id = obj.id.trim();
      while (usedIds.has(id)) id = genShortId(usedIds);
      usedIds.add(id);
      const cat =
        typeof obj.category === 'string' && (KNOWN_CATEGORIES as string[]).includes(obj.category)
          ? (obj.category as FactCategory)
          : undefined;
      facts.push({
        id,
        text,
        category: cat,
        temporality: obj.temporality,
        observedAt: obj.observedAt,
        timeHint: normalizeTextField(obj.timeHint),
        updatedAt: obj.updatedAt,
      });
    }
    return facts;
  }

  /** 一段先读后写或先查后删的操作固定在开头选中的那一家（见 {@link loadProfile}）；选不到时访问抛错，同 memory.use */
  const pinnedMemory = (): MemoryService => memory.list().find(p => p.selected)?.use ?? memory.use;

  /**
   * 读取一个用户的现有档案（getMetadata 返回空才算不存在，返回 undefined）。
   *
   * 读失败原样抛出：先读后改再写的一方（关系分、事实提取、定点删事实）据此中止本次写入。
   * 若把「读不出」当成「不存在」，调用方会用默认值覆盖写回，一次瞬时读错就清空整份档案。
   * 只读渲染走 {@link loadProfileLenient}。
   *
   * 档案的读写函数都由调用方传入 mem，一次操作（读 → 调 LLM → 重读 → 覆盖写）全程只认
   * 开头取到的实例：memory 胜者可能在 LLM 调用期间换人而本插件不重启，每步现取胜者会把 A 上
   * 合并出的整张表覆盖写进 B，B 原有的条目被删。
   */
  async function loadProfile(mem: MemoryService | undefined, userKey: string): Promise<UserProfile | undefined> {
    if (!mem) return undefined;
    const doc = await mem.getMetadata(PROFILE_NS, userKey);
    return doc ? profileFrom(doc) : undefined;
  }

  /** 存着的档案文档按类型取出，读不懂的事实跳过 */
  function profileFrom(doc: Record<string, unknown>): UserProfile {
    return {
      facts: Array.isArray(doc.facts) ? parseFactArray(doc.facts as unknown[]) : [],
      relationScore: typeof doc.relationScore === 'number' ? Math.min(100, Math.max(0, doc.relationScore)) : 0,
      interactionCount: typeof doc.interactionCount === 'number' ? Math.max(0, Math.floor(doc.interactionCount)) : 0,
      lastInteractionAt: typeof doc.lastInteractionAt === 'number' ? doc.lastInteractionAt : undefined,
      updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0,
    };
  }

  /** 只读渲染用：读失败按「暂无档案」处理，只记 debug（结果不会被写回） */
  async function loadProfileLenient(mem: MemoryService | undefined, userKey: string): Promise<UserProfile | undefined> {
    try {
      return await loadProfile(mem, userKey);
    } catch (err) {
      logger.use.debug(`加载用户档案失败 (${userKey}): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** 保存档案（覆盖式） */
  async function saveProfile(mem: MemoryService | undefined, userKey: string, profile: UserProfile): Promise<void> {
    if (!mem) return;
    const payload: Record<string, unknown> = {
      facts: profile.facts,
      relationScore: profile.relationScore ?? 0,
      interactionCount: profile.interactionCount ?? 0,
      lastInteractionAt: profile.lastInteractionAt,
      updatedAt: profile.updatedAt,
    };
    await mem.saveMetadata(PROFILE_NS, userKey, payload);
  }

  // ─── 档案页：插件详情里查看与删除，只删不改。事实变了（这里、指令、提取、全局清理）就 invalidate ───
  /** 事实那一行的 rowKey 是 [用户键, 事实 id] 的 JSON：行动作只收 rowKey，靠它找回是谁的哪一条 */
  function parseFactRef(rowKey: string): [string, string] {
    let ref: unknown;
    try {
      ref = JSON.parse(rowKey);
    } catch {
      ref = undefined;
    }
    if (!Array.isArray(ref) || ref.length !== 2 || !ref.every(part => typeof part === 'string')) {
      throw new TextError(t('unknownFact', { rowKey }));
    }
    return ref as [string, string];
  }

  const page = webui.use.definePage({
    key: 'profiles',
    title: t('profiles'),
    icon: 'contact',
    actions: {
      forgetFact: {
        label: t('forgetLabel'),
        effect: 'destructive',
        confirm: t('forgetConfirm'),
        row: true,
        async handler({ rowKey }) {
          const [userKey, factId] = parseFactRef(rowKey);
          const mem = pinnedMemory();
          const profile = await loadProfile(mem, userKey);
          const hit = profile?.facts.find(f => f.id === factId);
          if (!profile || !hit) throw new TextError(t('factGone'));
          await saveProfile(mem, userKey, {
            ...profile,
            facts: profile.facts.filter(f => f !== hit),
            updatedAt: Date.now(),
          });
          page.invalidate();
          return t('forgotten', { text: hit.text });
        },
      },
      clearProfile: {
        label: t('clearProfileLabel'),
        effect: 'destructive',
        confirm: t('clearProfileConfirm'),
        row: true,
        async handler({ rowKey }) {
          const mem = pinnedMemory();
          if (!(await mem.getMetadata(PROFILE_NS, rowKey))) throw new TextError(t('profileGone', { key: rowKey }));
          await mem.deleteMetadata(PROFILE_NS, rowKey);
          page.invalidate();
          return t('profileCleared', { key: rowKey });
        },
      },
    },
    content: [
      {
        type: 'table',
        id: 'profiles',
        rowKey: 'key',
        description: t('pageDescription'),
        empty: t('pageEmpty'),
        columns: [
          { key: 'key', label: t('columnUser'), primary: true },
          { key: 'facts', label: t('columnFacts'), primary: true },
          { key: 'updatedAt', label: t('columnLastNoted'), kind: 'time' },
        ],
        async data() {
          const entries = await memory.use.listMetadata(PROFILE_NS);
          return entries
            .flatMap(({ key, data }) => {
              const { facts } = profileFrom(data);
              if (facts.length === 0) return [];
              return [{ key, facts: facts.length, updatedAt: Math.max(...facts.map(f => f.updatedAt)) }];
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
        },
        detail: [
          {
            type: 'table',
            id: 'facts',
            rowKey: 'ref',
            empty: t('factsEmpty'),
            columns: [
              { key: 'text', label: t('columnFact'), primary: true },
              { key: 'category', label: t('columnCategory') },
              { key: 'temporality', label: t('columnTerm') },
              { key: 'updatedAt', label: t('columnNoted'), kind: 'time' },
            ],
            rowActions: [{ action: 'forgetFact' }],
            async data({ rowKey }) {
              const facts = (await loadProfile(memory.use, rowKey))?.facts ?? [];
              return facts
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map(f => ({
                  ref: JSON.stringify([rowKey, f.id]),
                  text: f.text,
                  category: f.category ? CATEGORY_NAMES[f.category] : '',
                  temporality: f.temporality === 'temporary' ? t('termShort') : t('termLong'),
                  updatedAt: f.updatedAt,
                }));
            },
          },
          { type: 'actions', actions: ['clearProfile'] },
        ],
      },
    ],
  });

  interface ExtractAddItem {
    text: string;
    category?: FactCategory;
    temporality?: FactTemporality;
    timeHint?: string;
    sourceQuote: string;
  }
  interface ExtractUpdateItem {
    id: string;
    text: string;
    category?: FactCategory;
    temporality?: FactTemporality;
    timeHint?: string;
    sourceQuote: string;
  }
  interface ExtractRemoveItem {
    id: string;
    sourceQuote: string;
  }
  interface ExtractResult {
    add: ExtractAddItem[];
    update: ExtractUpdateItem[];
    remove: ExtractRemoveItem[];
  }

  function normalizeCategory(v: unknown): FactCategory | undefined {
    if (typeof v !== 'string') return undefined;
    return (KNOWN_CATEGORIES as string[]).includes(v) ? (v as FactCategory) : undefined;
  }

  /** 解析 LLM 输出里的 add / update / remove 三类事实操作。sourceQuote 原样带出，由调用方校验；它不入库（mergeFactList 逐字段构造 Fact） */
  function parseFactOps(parsed: unknown): ExtractResult {
    const obj = parsed as { add?: unknown; update?: unknown; remove?: unknown };
    const add: ExtractAddItem[] = Array.isArray(obj.add)
      ? (obj.add as unknown[]).flatMap(x => {
          if (!x || typeof x !== 'object') return [];
          const o = x as Record<string, unknown>;
          const text = typeof o.text === 'string' ? o.text.trim() : '';
          if (!text) return [];
          const category = normalizeCategory(o.category);
          const sourceQuote = typeof o.sourceQuote === 'string' ? o.sourceQuote.trim() : '';
          return [
            {
              text,
              category,
              temporality: normalizeTemporality(o.temporality, category),
              timeHint: normalizeTextField(o.timeHint),
              sourceQuote,
            },
          ];
        })
      : [];
    const update: ExtractUpdateItem[] = Array.isArray(obj.update)
      ? (obj.update as unknown[]).flatMap(x => {
          if (!x || typeof x !== 'object') return [];
          const o = x as Record<string, unknown>;
          const id = typeof o.id === 'string' ? o.id.trim() : '';
          const text = typeof o.text === 'string' ? o.text.trim() : '';
          if (!id || !text) return [];
          const category = normalizeCategory(o.category);
          const sourceQuote = typeof o.sourceQuote === 'string' ? o.sourceQuote.trim() : '';
          return [
            {
              id,
              text,
              category,
              temporality: normalizeTemporality(o.temporality, category),
              timeHint: normalizeTextField(o.timeHint),
              sourceQuote,
            },
          ];
        })
      : [];
    // 只给 id 的字符串没有原话：当成只有 id 的一项，校验时按没给原话丢弃并 warn，不静默放过
    const remove: ExtractRemoveItem[] = Array.isArray(obj.remove)
      ? (obj.remove as unknown[]).flatMap(x => {
          const item = typeof x === 'string' ? { id: x } : x;
          if (!item || typeof item !== 'object') return [];
          const o = item as Record<string, unknown>;
          const id = typeof o.id === 'string' ? o.id.trim() : '';
          if (!id) return [];
          const sourceQuote = typeof o.sourceQuote === 'string' ? o.sourceQuote.trim() : '';
          return [{ id, sourceQuote }];
        })
      : [];
    return { add, update, remove };
  }

  /** 调用 LLM 从历史中提取/修订事实，返回 add / update / remove 三类操作。 */
  async function llmExtractFacts(
    history: Message[],
    existingFacts: Fact[],
    nickname: string | undefined,
    userId: string,
    platform: string,
    sessionId: string,
  ): Promise<ExtractResult> {
    const empty: ExtractResult = {
      add: [],
      update: [],
      remove: [],
    };

    // 她在提示里的称呼取这个会话的人设名，标签、规则与例句同一个名字
    const botName = (persona.present ? persona.use.getPersonaName({ sessionId, platform }) : '') || BOT_FALLBACK_NAME;
    const sys =
      '你是用户档案管理员。输入是一段多用户会话历史，每行开头有身份标签：' +
      `\`[目标用户 X(uid)]\`、\`[其他用户 Y(uid)]\` 或 \`[${botName}]\`。上下文仅供消歧，` +
      `**只允许根据「目标用户」自己的发言写入事实**，不能根据其他用户、${botName} 的猜测或提问写入事实。` +
      '\n\n你可以执行三种操作（在一次输出里组合）：' +
      '\n- add: 添加新事实，需指定 text、category、sourceQuote' +
      '\n- update: 用 id 精确替换某条已知事实，同样需 sourceQuote（优先使用 update 而非 add 来避免重复）' +
      '\n- remove: 用 id 删除已被目标用户推翻的事实，同样需 sourceQuote（目标用户推翻它的那句原话）' +
      '\n\n规则：' +
      '\n1. 事实的**主语必须是「目标用户」本人**，不能是 ta 转述、讨论、评价的第三方。' +
      '即使 sourceQuote 出自目标用户原话，也要先在脑中追问：' +
      '\n   - 这是 ta 在说自己，还是在评价/复述别人？（比如目标用户说"小明会写檄文" → 这是关于小明的，不写）' +
      '\n   - 是认真陈述，还是反讽/否定/假设/角色扮演？（"我可不喜欢爵士" → 否定，不写；跑团扮演 NPC 的台词 → 不写）' +
      '\n   - 如果原始依据来自「其他用户」的发言，即使在说目标用户，也不允许写入（他人可能记错、说反话）' +
      '\n   **拿不准就不写。profile 漏几条没关系，写错才麻烦。**' +
      `\n   ⚠️ 例外——\`人际关系\` 类：除上述通用规则外，该类还允许记录目标用户**与 ${botName} 之间长期可观察的关系模式**，` +
      '包含两种情况：' +
      `\n   (a) 行为身份类：用户围绕 ${botName} 扮演的角色或长期重复的行为` +
      `（示例 text：「是 ${botName} 的开发维护者」「经常向 ${botName} 提交功能建议」「常帮助测试和排查 ${botName} 的故障」）` +
      `\n   (b) 长期情感模式类：用户对 ${botName} 表现出的**反复出现的态度倾向**（不是单次情绪）` +
      `（示例 text：「常对 ${botName} 表达依赖与喜爱」「习惯把日常烦恼向 ${botName} 倾诉」「喜欢调侃 ${botName}」）` +
      '\n   ❌ 严禁仅凭单次发言推断情感事实：一次抱怨/一次感谢/一次撒娇都不算"模式"，不写。' +
      '必须是已有事实佐证 + 本轮再次出现的同类行为才允许 update 强化，或会话历史多处反复出现才允许 add。' +
      '依据必须是「目标用户」发言中可直接推断的内容，sourceQuote 取目标用户发言原话。' +
      '\n2. **sourceQuote 必须是「目标用户」自己发言中的原话片段**，可以是某一句话的一部分，必须能一字不改在「目标用户」某行的原文中找到；不要采用「其他用户」的原话，不要自己总结改写；' +
      '只算 ta 自己写的字：行首的发送者前缀、行里附带的「[引用 … 的消息: …]」、图片与语音视频的描述、文件内容、合并转发都不算' +
      '\n3. 在同一 category 下，如果新信息与已有事实在含义上重叠（例如已知"喜欢猫"，新信息"还喜欢狗"），应以 update 改写原 id 为更全面的版本，而不是 add 再加一条' +
      '\n4. 如果新对话明确推翻或修正了某条已知事实（如已知"在北京工作"，但用户说"我刚搬到上海"），用 update 替换或 remove 删除' +
      `\n5. 每条 text 用一句简洁的 ${outputLanguageFor(i18n, { host: true }, 'zh-CN')}，不超过 ${cfg.maxFactCharsPerItem} 个字符，不带「用户」「他」等代词，直接陈述事实` +
      '\n6. 如果没有任何更新，或所有候选都拿不准，三个数组都返回空——**保守优先**' +
      `\n7. category 必须是以下之一：${KNOWN_CATEGORIES.join('、')}` +
      '\n8. 每条 add/update 都必须给出 temporality：长期稳定偏好、性格、身份、人际关系用 permanent；近期状态、正在进行的事、短期计划用 temporary' +
      '\n9. 如果对话中出现明确或隐含时间（如“最近”“上周”“今年4月”“昨天”），用 timeHint 记录简短时间线索；没有就省略或用空字符串' +
      '\n\n输出严格的 JSON（不要其他文本）：' +
      '\n{"add": [{"text": "...", "category": "...", "temporality": "permanent|temporary", "timeHint": "...", "sourceQuote": "目标用户发言中的原话片段"}], "update": [{"id": "已知事实的id", "text": "新表述", "category": "...", "temporality": "permanent|temporary", "timeHint": "...", "sourceQuote": "目标用户发言中的原话片段"}], "remove": [{"id": "已知事实的id", "sourceQuote": "目标用户发言中的原话片段"}]}';

    const factListText =
      existingFacts.length > 0
        ? existingFacts.map(f => `[${f.id}] (${f.category ?? '未分类'}) ${f.text}`).join('\n')
        : '（暂无）';
    const who = nickname ? `${nickname}（${userId}）` : userId;
    const renderedHistory = renderHistoryForExtract(history, userId, platform, botName);
    const user =
      `# 提取目标\n${who}\n\n# 已知事实（带 id，请在 update/remove 中精确引用 id）\n${factListText}` +
      `\n\n# 会话历史（含多用户，仅供消歧；只能从「目标用户」发言中提取事实）\n${renderedHistory || '（暂无会话历史）'}`;

    const entry = pickChatModel();
    if (!entry) return empty;
    const extractLlm = entry.use;

    try {
      const baseMessages: Message[] = [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ];
      const resp = await extractLlm.chat({
        messages: baseMessages,
        temperature: 0.2,
        maxTokens: 800,
        think: lightestThinking(extractLlm),
      });
      const text = (resp.content ?? '').trim();
      let reply = readExtractReply(resp);
      if ('why' in reply) {
        // 截断，或 util-json-repair 剥过围栏、修过裸引号仍不是合法 JSON（空回复也算：提示词要求没有事实也回三个空数组）：给一次
        // 显式反馈再来一次，避免一次失败丢失整批事实
        logger.use.warn(`[user-profile] LLM 输出${reply.why}，尝试重试一次。原文前 200 字：${text.slice(0, 200)}`);
        const retryResp = await extractLlm.chat({
          messages: [
            ...baseMessages,
            { role: 'assistant', content: text },
            {
              role: 'user',
              content:
                `你上一条输出${reply.why}。` +
                '请只输出**一个**合法的 JSON 对象，第一个字符必须是 `{`、最后一个字符必须是 `}`，' +
                '禁止 ```json 围栏、禁止任何解释、禁止 markdown。如果实在没有可写入的事实，' +
                '就输出 `{"add":[],"update":[],"remove":[]}`。',
            },
          ],
          temperature: 0.2,
          maxTokens: 800,
          think: lightestThinking(extractLlm),
        });
        reply = readExtractReply(retryResp);
        if ('why' in reply) {
          logger.use.warn(
            `[user-profile] LLM 重试后输出仍${reply.why}，放弃本批次。重试原文前 200 字：${(retryResp.content ?? '').trim().slice(0, 200)}`,
          );
          return empty;
        }
        logger.use.debug('[user-profile] LLM 重试后解析成功');
      }
      const { add, update, remove } = parseFactOps(reply.parsed);

      // 增改删都要附原话：按行拆开（quote 可能跨多条消息，LLM 用 \n 拼接），每行规整后（normalizeForQuoteMatch）要落在目标用户
      // 自己写的某一条话里（见 buildTargetUserCorpus），任一片段找不到整条丢弃并 warn；规整后不含字母或数字的行不算片段，一个
      // 片段都没有的按没给原话。模型会凭空编事实，也会把别人的话、图上的字记到他头上，核对原话挡的是这两种。不设字数下限：接在
      // 问句后面的「是的」是合法的原话；也不核对事实能不能从原话推出来：每次提取要多一次调用
      const targetCorpus = buildTargetUserCorpus(history, userId, platform);
      const validateSourceQuote = (quote: string, kind: 'add' | 'update' | 'remove', what: string): boolean => {
        const fragments = quote
          .split(/\r?\n/)
          .map(line => ({ line, normalized: normalizeForQuoteMatch(line) }))
          .filter(({ normalized }) => /[\p{L}\p{N}]/u.test(normalized));
        if (fragments.length === 0) {
          logger.use.warn(`[user-profile] 丢弃 ${kind} fact（未提供 sourceQuote）: ${what}`);
          return false;
        }
        for (const { line, normalized } of fragments) {
          if (!targetCorpus.some(spoken => spoken.includes(normalized))) {
            logger.use.warn(
              `[user-profile] 丢弃 ${kind} fact（sourceQuote 片段不在目标用户 ${userId} 发言中）: ${what} fragment="${line.trim()}"`,
            );
            return false;
          }
        }
        return true;
      };
      const validatedAdd = add.filter(item => validateSourceQuote(item.sourceQuote, 'add', item.text));
      const validatedUpdate = update.filter(item => validateSourceQuote(item.sourceQuote, 'update', item.text));
      const validatedRemove = remove.filter(item => validateSourceQuote(item.sourceQuote, 'remove', `id=${item.id}`));
      return { add: validatedAdd, update: validatedUpdate, remove: validatedRemove };
    } catch (err) {
      logger.use.debug(`事实提取 LLM 调用失败：${err instanceof Error ? err.message : String(err)}`);
      return empty;
    }
  }

  function clipText(s: string): string {
    return s.length > cfg.maxFactCharsPerItem ? `${s.slice(0, cfg.maxFactCharsPerItem)}…` : s;
  }

  function clampRelationScore(score: number): number {
    const factor = 10 ** relationScorePrecision;
    return Math.min(100, Math.max(0, Math.round(score * factor) / factor));
  }

  function relationIncrementFor(triggerType: IncomingMessage['triggerType'] | 'witness'): number {
    if (triggerType === 'immediate') return cfg.relationIncrementImmediate;
    if (triggerType === 'interval') return cfg.relationIncrementInterval;
    if (triggerType === 'witness') return cfg.relationIncrementWitness;
    return cfg.relationIncrementDirect;
  }

  function applyRelationUpdate(
    profile: UserProfile,
    triggerType: IncomingMessage['triggerType'] | 'witness',
    options: { countInteraction?: boolean } = {},
  ): UserProfile {
    // countInteraction：是否计入互动计数与更新 lastInteractionAt。
    // 同一条入站消息会先走 witness 路径，若被触发插件判为需回复又会走
    // agent:input:before 路径。为避免 interactionCount/lastInteractionAt 被同一条
    // 消息计两次，计数与时戳只由 witness 路径负责，agent:input:before 仅叠加 score。
    const countInteraction = options.countInteraction ?? true;
    const now = Date.now();
    const last = profile.lastInteractionAt;
    const daysSinceLast = last ? Math.max(0, (now - last) / 86_400_000) : 0;
    const decayed = clampRelationScore((profile.relationScore ?? 0) - daysSinceLast * cfg.relationScoreDecayPerDay);
    const nextScore = clampRelationScore(decayed + relationIncrementFor(triggerType));
    return {
      ...profile,
      relationScore: nextScore,
      interactionCount: (profile.interactionCount ?? 0) + (countInteraction ? 1 : 0),
      lastInteractionAt: countInteraction ? now : profile.lastInteractionAt,
      updatedAt: now,
    };
  }

  /** 把 add/update/remove 应用到 existing，应用单用户上限与单条裁剪 */
  function mergeFactList(
    existing: Fact[],
    add: ExtractAddItem[],
    update: ExtractUpdateItem[],
    remove: string[],
  ): Fact[] {
    const now = Date.now();
    const byId = new Map<string, Fact>();
    for (const f of existing) byId.set(f.id, f);

    // 1. remove
    for (const id of remove) byId.delete(id);

    // 2. update
    const usedIds = new Set(byId.keys());
    for (const u of update) {
      const text = clipText(u.text);
      if (byId.has(u.id)) {
        const old = byId.get(u.id)!;
        byId.set(u.id, {
          id: u.id,
          text,
          category: u.category ?? old.category,
          temporality: u.temporality ?? old.temporality,
          observedAt: old.observedAt,
          timeHint: u.timeHint ?? old.timeHint,
          updatedAt: now,
        });
      } else {
        const id = genShortId(usedIds);
        usedIds.add(id);
        byId.set(id, {
          id,
          text,
          category: u.category,
          temporality: u.temporality ?? normalizeTemporality(undefined, u.category),
          observedAt: now,
          timeHint: u.timeHint,
          updatedAt: now,
        });
      }
    }

    // 3. add（按 text 去重）
    const textSet = new Set(Array.from(byId.values()).map(f => f.text));
    for (const a of add) {
      const text = clipText(a.text);
      if (textSet.has(text)) continue;
      const id = genShortId(usedIds);
      usedIds.add(id);
      byId.set(id, {
        id,
        text,
        category: a.category,
        temporality: a.temporality ?? normalizeTemporality(undefined, a.category),
        observedAt: now,
        timeHint: a.timeHint,
        updatedAt: now,
      });
      textSet.add(text);
    }

    // 4. 总量上限：按 updatedAt 升序淘汰最久未更新的
    let merged = Array.from(byId.values());
    if (merged.length > cfg.maxFactsPerUser) {
      merged.sort((a, b) => a.updatedAt - b.updatedAt);
      merged = merged.slice(merged.length - cfg.maxFactsPerUser);
    }
    merged.sort((a, b) => a.updatedAt - b.updatedAt);
    return merged;
  }

  /**
   * LLM 的 update 针对调用前快照里的 id。快照里有、重读后已不在的，说明调用期间被删（清空或定点删除），
   * 丢弃：否则 mergeFactList 把未知 id 当新增，删掉的事实换个 id 写回。快照里本就没有的 id 照旧按新增处理
   */
  function dropUpdatesOfDeletedFacts(
    update: ExtractUpdateItem[],
    snapshot: Fact[],
    fresh: Fact[],
  ): ExtractUpdateItem[] {
    const snapshotIds = new Set(snapshot.map(f => f.id));
    const freshIds = new Set(fresh.map(f => f.id));
    return update.filter(u => !snapshotIds.has(u.id) || freshIds.has(u.id));
  }

  /**
   * 后台触发一次事实提取（并发互斥）。
   * userId/platform/nickname 直接由调用方传入，不再从 history 里猜。
   */
  async function triggerExtractionForUser(
    sessionId: string,
    userId: string,
    platform: string,
    nickname: string | undefined,
  ): Promise<void> {
    const userKey = userKeyOf(platform, userId);
    // 若同一用户已有提取在飞，跳过（消息计数继续累加，下次 N 条后再尝试）
    if (inflightExtractions.has(userKey)) return;
    inflightExtractions.add(userKey);
    // 读档案、等模型、重读再写回固定同一家记忆后端：途中换了人也不会读一家、写另一家
    const mem = memory.list().find(p => p.selected)?.use;
    try {
      if (!mem) return;
      const rawHistory = await mem.getHistory(sessionId, cfg.historyForExtraction);
      // 指令类消息（proactive 代发任务、宿主通知）是宿主或系统撰写的，不是任何人的发言，
      // 不能作为用户存档的提取语料
      const history = rawHistory.filter(m => !DIRECTIVE_KINDS.includes(m.kind ?? ''));
      // 序列中至少需要一条目标用户发言，否则没有可提取语料
      if (!history.some(m => isTargetUserMessage(m, userId, platform))) return;
      const snapshotFacts = (await loadProfile(mem, userKey))?.facts ?? [];
      const ops = await llmExtractFacts(history, snapshotFacts, nickname, userId, platform, sessionId);
      const hasFactOps = ops.add.length > 0 || ops.update.length > 0 || ops.remove.length > 0;
      if (!hasFactOps) return;
      // 以 LLM 返回后重读的档案为合并基底：调用期间档案可能被清空或删了事实，以调用前的快照
      // 为基底会把删掉的内容整份写回；重读也保住期间写入的 relationScore 等字段
      const fresh = (await loadProfile(mem, userKey)) ?? { facts: [], updatedAt: 0 };
      const newFacts = mergeFactList(
        fresh.facts,
        ops.add,
        dropUpdatesOfDeletedFacts(ops.update, snapshotFacts, fresh.facts),
        ops.remove.map(r => r.id),
      );
      await saveProfile(mem, userKey, {
        ...fresh,
        facts: newFacts,
        updatedAt: Date.now(),
      });
      page.invalidate();
      logger.use.debug(
        `用户档案已更新 (${userKey}): facts +${ops.add.length} ~${ops.update.length} -${ops.remove.length} → ${newFacts.length} 条`,
      );
    } catch (err) {
      logger.use.debug(`事实提取失败 (${userKey}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inflightExtractions.delete(userKey);
    }
  }

  async function updateRelationForUser(
    userKey: string,
    triggerType: IncomingMessage['triggerType'] | 'witness',
    options?: { countInteraction?: boolean },
  ): Promise<void> {
    const mem = memory.list().find(p => p.selected)?.use;
    const profile = (await loadProfile(mem, userKey)) ?? {
      facts: [],
      relationScore: 0,
      interactionCount: 0,
      updatedAt: 0,
    };
    await saveProfile(mem, userKey, applyRelationUpdate(profile, triggerType, options));
  }

  // ─── 关系分数：在 agent 触发回复路径上更新 ───
  // 注:钩子无优先级机制,同相位 handler 按插件激活序执行;本 handler 只做副作用
  // (更新关系分数)不改消息,与其它 handler 顺序无关。
  // 关系强度与"是否触发回复"绑定，因此仍走 agent:input:before 中间件。
  // 只算真人的话，与旁观那一路同一个判据：带来源的注入（子任务的任务消息、好友申请通知等）不是谁在跟她说话，不加
  hooks.use.middleware('agent:input:before', async (data, next) => {
    const { userId, platform, triggerType, source } = data.message;
    if (userId && !source) {
      const userKey = userKeyOf(platform, userId);
      try {
        // 仅叠加 score，互动计数与时戳由 witness 路径统一负责，
        // 避免同一条入站消息被计两次 interactionCount。
        await updateRelationForUser(userKey, triggerType, { countInteraction: false });
      } catch (err) {
        logger.use.debug(`关系强度更新异常 (${userKey}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await next();
  });

  // ─── 事实提取触发：每条入站消息落库后立即计数，与 agent 是否回复无关 ───
  // 监听 message-archive 在 archiveIncoming 落库成功后发出的 inbound:message:archived 事件，
  // 确保缓冲消息（onebot saveBufferedMessage 等不触发 agent 回复的路径）也能纳入计数。
  events.use.on('inbound:message:archived', data => {
    const { sessionId, incoming } = data;
    const { userId, platform, nickname } = incoming;
    // 带来源的注入不是这个账号说的话：不计旁观、不计提取，也就不为它带的账号（如子任务的 parent:<父会话>）建档
    if (!userId || incoming.source) return;

    // 旁观档位：每条入站消息都加 witness 增量（默认 0.1），与 agent 是否回复无关。
    // agent:input:before 中间件在触发回复时会再叠加 direct/immediate/interval 增量。
    // 刻意不按 relationIncrementWitness > 0 设门：本路径同时是 interactionCount 与
    // lastInteractionAt 的唯一写点，设门会连带关掉计数与时戳（衰减基准、最近互动
    // 排序全失效）。增量为 0 时 relationIncrementFor 自然返回 0，不加分即可。
    const userKey = userKeyOf(platform, userId);
    void updateRelationForUser(userKey, 'witness').catch((err: unknown) =>
      logger.use.debug(`witness 关系更新异常 (${userKey}): ${err instanceof Error ? err.message : String(err)}`),
    );

    const countKey = extractionCountKeyOf(sessionId, platform, userId);
    const count = (userMessageCount.get(countKey) ?? 0) + 1;
    userMessageCount.set(countKey, count);
    if (cfg.extractEveryNMessages > 0 && count % cfg.extractEveryNMessages === 0) {
      void triggerExtractionForUser(sessionId, userId, platform ?? '', nickname).catch((err: unknown) =>
        logger.use.debug(`事实提取异常 (${countKey}): ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  });

  function isFactActive(fact: Fact): boolean {
    if (fact.temporality !== 'temporary') return true;
    if (cfg.temporaryFactMaxAgeDays <= 0) return true;
    return Date.now() - fact.updatedAt <= cfg.temporaryFactMaxAgeDays * 86_400_000;
  }

  function renderFactLine(fact: Fact, includeMeta: boolean): string {
    if (!includeMeta) return `- ${fact.text}`;
    const meta: string[] = [];
    if (fact.timeHint) meta.push(`时间线索：${fact.timeHint}`);
    meta.push(`记录于：${new Date(fact.observedAt).toLocaleDateString('zh-CN')}`);
    if (fact.temporality === 'temporary') meta.push('临时状态');
    return `- ${fact.text}（${meta.join('；')}）`;
  }

  /** 生效的事实按分类分组，次序同 KNOWN_CATEGORIES；没有分类的归「其他」。给模型的档案块与 /profile 共用 */
  function groupFacts(facts: Fact[]): Array<[FactCategory, Fact[]]> {
    const active = facts.filter(isFactActive);
    return KNOWN_CATEGORIES.flatMap(cat => {
      const items = active.filter(f => (f.category ?? '其他') === cat);
      return items.length > 0 ? [[cat, items] as [FactCategory, Fact[]]] : [];
    });
  }

  /** 将一个用户的 Fact[] 渲染为分组文本块（给模型的） */
  function renderProfileBlock(facts: Fact[], label: string, compact: boolean): string {
    if (compact) {
      // compact 模式（群聊背景参与者）：只取最近更新的 N 条，平铺，不加分组标题
      const subset = facts
        .filter(isFactActive)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, cfg.maxFactsForOthers);
      return `### ${label}\n${subset.map(f => renderFactLine(f, false)).join('\n')}`;
    }
    return groupFacts(facts)
      .map(([cat, items]) => `## ${cat}\n${items.map(f => renderFactLine(f, true)).join('\n')}`)
      .join('\n\n');
  }

  /** /profile 的回复：与给模型的档案块同一分组与版式，分类名与说明按读者语言 */
  function profileText(profile: UserProfile, userKey: string): TextRef {
    const factText = (fact: Fact) =>
      t('factLine', {
        text: fact.text,
        meta: textClauses([
          ...(fact.timeHint ? [t('factTimeHint', { hint: fact.timeHint })] : []),
          t('factObserved', { at: fact.observedAt }),
          ...(fact.temporality === 'temporary' ? [t('factTemporary')] : []),
        ]),
      });
    return textLines([
      t('profileHead', { key: userKey }),
      t('profileMeta', {
        score: (profile.relationScore ?? 0).toFixed(relationScorePrecision),
        count: profile.interactionCount ?? 0,
      }),
      ...groupFacts(profile.facts).flatMap(([cat, items]) => [
        '',
        t('section', { name: CATEGORY_NAMES[cat] }),
        ...items.map(factText),
      ]),
    ]);
  }

  function renderRelationLine(profile: UserProfile): string {
    const score = profile.relationScore ?? 0;
    const count = profile.interactionCount ?? 0;
    if (score <= 0 && count <= 0) return '';
    return `关系强度：${score.toFixed(relationScorePrecision)}/100；累计互动：${count} 次。`;
  }

  // ─── LLM 调用前注入（agent:prompt 贡献 / turn-context 槽——档案按当前发言者取材、换人即变，落历史后护前缀缓存）：按这一轮各条输入的 triggerType 区分主发言者语义 ───
  //   direct/immediate/undefined → 点名的输入（带来源的注入不算，见 wasAddressed），它的发言者是主发言者：各注入完整档案，其余参与者给摘要
  //   interval                   → 无主发言者（只是恰好撞上频率），所有参与者一律 compact 摘要
  //   idle                       → 无 userId，只注入历史 messages 中出现的参与者 compact 摘要
  // 没有一条点名的输入时没有主发言者。多块返回保序共键：各主发言者档案（按输入先后）→ 其他参与者。
  contributions.use.contribute('agent:prompt', {
    id: 'user-profile',
    anchor: 'turn-context',
    async build(data) {
      // 干跑(token 快照)跳过档案加载——该路径没有输入,加载既昂贵又无意义
      if (data.dryRun) return null;

      const mem = memory.present ? memory.use : undefined;
      const blocksToInsert: string[] = [];
      const addressed = data.inputs.map(({ message }) => message).filter(wasAddressed);
      const hasPrimarySpeaker = addressed.length > 0;
      /** 主发言者：点名的输入里有账号的发言者，按 userKey 去重、按输入先后 */
      const primaries = new Map<string, string>();
      for (const { platform, userId } of addressed) {
        if (userId) primaries.set(userKeyOf(platform, userId), userId);
      }

      // 1. 主发言者完整档案：仅在确实有人在「和 Aalis 对话」时注入
      for (const [userKey, userId] of primaries) {
        const profile = await loadProfileLenient(mem, userKey);
        if (profile?.facts.some(isFactActive)) {
          const body = renderProfileBlock(profile.facts, userId, false);
          const relationLine = renderRelationLine(profile);
          // 可选：从 user-relation 服务取「同社群活跃成员」（按配置的社群发现算法所得标签 + PageRank 排序）。
          // 服务不存在 / 节点没社群标签 / 报错都静默跳过；该字段是锦上添花，不破坏档案主体。
          let communityLine = '';
          try {
            const relation = userRelation.present ? userRelation.use : undefined;
            if (relation) {
              const r = await relation.getCommunityPeers(userKey, 5);
              if (r.peers.length > 0) {
                const names = r.peers.map(p => p.displayName).join('、');
                communityLine = `同社群活跃成员（共 ${r.communitySize} 人）：${names}。`;
              }
            }
          } catch (err) {
            logger.use.debug(`读取 community peers 失败: ${err instanceof Error ? err.message : String(err)}`);
          }
          const block =
            `# 关于当前对话者（${userId}）的已知事实\n` +
            '以下是你跨会话长期积累的关于该用户的事实，用于让回应更自然贴合其个性。' +
            '不要主动罗列这些事实，也不要让用户觉得你在「读档案」，而是让它自然影响你的语气和话题选择。' +
            '这些事实来自零散对话的推断，未必完全准确；也不要把它们与对话历史片段拼接成新的强陈述，' +
            '若用户否认应坦然接受、不要硬撑：\n\n' +
            (relationLine ? `${relationLine}\n` : '') +
            (communityLine ? `${communityLine}\n` : '') +
            (relationLine || communityLine ? '\n' : '') +
            body;
          blocksToInsert.push(block);
        }
      }

      // 2. 群聊其他参与者：按最近互动优先加载档案
      //    - 先从当前 LLM 上下文的 messages 中倒序收集最近发言者
      //    - 再从跨会话 user:profile metadata 中按 lastInteractionAt 倒序补齐
      //    - 排除主发言者；没有主发言者时（interval/idle）所有人平等显示
      if (cfg.maxOtherParticipants > 0) {
        const others = new Map<string, { userId: string; nickname?: string; platform?: string }>();
        const candidateLimit = Math.max(cfg.maxOtherParticipants * 5, cfg.maxOtherParticipants + 10);

        function addOther(userId: string, platform?: string, nickname?: string): boolean {
          const uid = userId.trim();
          if (!uid) return false;
          const userKey = userKeyOf(platform, uid);
          if (primaries.has(userKey)) return false;
          if (others.has(userKey)) return false;
          others.set(userKey, { userId: uid, nickname, platform });
          return others.size >= candidateLimit;
        }

        for (let i = data.messages.length - 1; i >= 0; i--) {
          const msg = data.messages[i];
          if (msg.role !== 'user') continue;
          const uid = metadataString(msg, WellKnownMetadataKeys.UserId);
          if (!uid) continue;
          const plat = metadataString(msg, WellKnownMetadataKeys.Platform) ?? data.platform ?? '';
          const nick = metadataString(msg, WellKnownMetadataKeys.Nickname);
          if (addOther(uid, plat, nick)) break;
        }

        if (cfg.allowGlobalBackfill && others.size < candidateLimit) {
          if (mem) {
            try {
              const globalRecent = await mem.listMetadata(PROFILE_NS);
              globalRecent.sort((a, b) => {
                const at = typeof a.data.lastInteractionAt === 'number' ? a.data.lastInteractionAt : 0;
                const bt = typeof b.data.lastInteractionAt === 'number' ? b.data.lastInteractionAt : 0;
                return bt - at;
              });
              for (const item of globalRecent) {
                if (others.size >= candidateLimit) break;
                const sep = item.key.indexOf(':');
                if (sep < 0) continue;
                const platform = item.key.slice(0, sep);
                // 平台段以 __ 开头的是保留键（如旧版本留下的人格档案），不是真实用户
                if (platform.startsWith('__')) continue;
                addOther(item.key.slice(sep + 1), platform);
              }
            } catch (err) {
              logger.use.debug(`加载最近互动用户失败: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        if (others.size > 0) {
          const snippets: string[] = [];
          for (const [key, info] of others) {
            const profile = await loadProfileLenient(mem, key);
            if (!profile?.facts.some(isFactActive)) continue;
            const label = info.nickname ? `${info.nickname}（${info.userId}）` : info.userId;
            const relationLine = renderRelationLine(profile);
            const snippet =
              renderProfileBlock(profile.facts, label, true) + (relationLine ? `\n- ${relationLine}` : '');
            snippets.push(snippet);
            if (snippets.length >= cfg.maxOtherParticipants) break;
          }
          if (snippets.length > 0) {
            // 标题根据语义切换：有主发言者 → 「其他参与者」；无主发言者 → 「在场参与者」
            const title = hasPrimarySpeaker ? '群聊其他参与者背景摘要' : '在场参与者背景摘要';
            const intro = hasPrimarySpeaker
              ? '以下是同一会话中其他参与者的基本档案，供你在群聊语境中参考，了解他们是谁。'
              : '当前没有人直接呼叫你，以下是会话中近期出现过的参与者档案，供你判断要不要插话以及和谁互动。';
            const block = `# ${title}\n${intro}不要主动透露这些信息，只在自然相关时使用：\n\n${snippets.join('\n\n')}`;
            blocksToInsert.push(block);
          }
        }
      }

      return blocksToInsert.length > 0 ? blocksToInsert : null;
    },
  });

  // ─── 参与统一的 memory:clear ───
  // 用户档案是跨会话的，只在清理全部会话时清：会话级清理不动它，显式选了 user-profile 时回一行未清理（不带类型的会话级清理，
  // 含删除会话，不出这一行）
  contributions.use.contribute('memory:clear-type', { id: 'user-profile', label: t('clearType') });
  hooks.use.middleware('memory:clear', async (data, next) => {
    if (data.types && !data.types.includes('user-profile')) {
      await next();
      return;
    }
    if (data.scope !== 'all') {
      if (data.types)
        data.results.push({ source: 'user-profile', type: 'user-profile', success: false, message: t('clearSkipped') });
      await next();
      return;
    }
    if (!memory.present) {
      await next();
      return;
    }
    const mem = pinnedMemory();
    try {
      // 批量提交：逐条 delete 中途失败会留下「删了一半」的档案，而用户看到的是报了成功。
      // 注意 commitMetadata 的原子性**按后端分档**（见 api-memory 契约）——sqlite/inmemory
      // 是真原子，mongodb 只保证按序执行遇错即停，仍可能停在半新半旧。批量的确定收益是
      // 一次往返 + 遇错即停，不是无条件的「要么全成」。读不出的条目一并删除，计入条数。
      const [keys] = await clearMetadataNamespaces(mem, [PROFILE_NS], logger.use);
      data.results.push({
        source: 'user-profile',
        type: 'user-profile',
        success: true,
        message: t('clearDone', { count: keys.length }),
      });
    } catch (err) {
      data.results.push({
        source: 'user-profile',
        type: 'user-profile',
        success: false,
        message: t('clearFailed', { error: textOf(err) }),
      });
    }
    page.invalidate();
    await next();
  });

  // ─── 工具：user_profile_lookup ───
  // 让 Agent 在对话中主动查询任意用户的事实档案。
  // 设计要点：
  // - 全局可查：跨平台/跨群均可
  // - 两种调用方式：① user_key 直传；② platform+user_id 组合
  tools.use.registerGroup({
    name: 'user-profile',
    label: t('profiles'),
    summary: t('groupSummary'),
    description: '查询已经积累的某人事实档案。',
  });
  tools.use.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_profile_lookup',
        description:
          '查询你已积累的某个用户的事实档案。当对话中提到某人、或你想回忆已知信息时使用。' +
          '可通过 user_key（"<platform>:<userId>"）直查，或用 platform + user_id 组合。',
        parameters: {
          type: 'object',
          properties: {
            user_key: {
              type: 'string',
              description: '完整的 userKey，例如 "onebot:123456789"。优先级最高。',
            },
            platform: {
              type: 'string',
              description: '平台名（如 onebot/webui）。与 user_id 搭配使用。',
            },
            user_id: {
              type: 'string',
              description: '平台用户 ID。与 platform 搭配使用。',
            },
          },
        },
      },
    },
    groups: ['user-profile'],
    handler: async args => {
      const a = args as {
        user_key?: string;
        platform?: string;
        user_id?: string;
      };
      let userKey = '';
      if (a.user_key && typeof a.user_key === 'string') {
        userKey = a.user_key.trim();
      } else if (a.platform && a.user_id) {
        userKey = userKeyOf(String(a.platform), String(a.user_id));
      }
      if (!userKey) {
        return JSON.stringify({
          ok: false,
          error: '需提供 user_key 或 (platform + user_id)。',
        });
      }
      const profile = await loadProfileLenient(memory.present ? memory.use : undefined, userKey);
      if (!profile || profile.facts.length === 0) {
        return JSON.stringify({ ok: true, userKey, found: false, message: '该用户暂无档案数据。' });
      }
      const factsBlock = renderProfileBlock(profile.facts, userKey, false);
      const relationLine = renderRelationLine(profile);
      const result: Record<string, unknown> = {
        ok: true,
        userKey,
        found: true,
        factCount: profile.facts.length,
        relationScore: profile.relationScore ?? 0,
        interactionCount: profile.interactionCount ?? 0,
        lastInteractionAt: profile.lastInteractionAt ?? null,
        facts: factsBlock,
      };
      if (relationLine) result.relationSummary = relationLine;
      return JSON.stringify(result);
    },
  });

  // ─── /profile 指令族 ───
  // /profile              查看自己的档案
  // /profile clear        清除自己的档案（authority=2，自己删自己的）
  // /profile clear nuke   清空所有用户档案（authority=3，dangerous）
  commands.use.command('profile', t('profileDescription')).action(async argv => {
    const userId = argv.session.userId;
    if (!userId) return t('noIdentityView');
    const userKey = userKeyOf(argv.session.platform, userId);
    const profile = await loadProfileLenient(memory.present ? memory.use : undefined, userKey);
    if (!profile || profile.facts.length === 0) {
      return t('noProfileYet', { key: userKey });
    }
    return profileText(profile, userKey);
  });

  commands.use.command('profile.clear', t('clearDescription'), { visibility: 'restricted' }).action(async argv => {
    const userId = argv.session.userId;
    if (!userId) return t('noIdentityClear');
    const userKey = userKeyOf(argv.session.platform, userId);
    const mem = pinnedMemory();
    try {
      const existed = await mem.getMetadata(PROFILE_NS, userKey);
      if (!existed) return t('noOwnProfile', { key: userKey });
      await mem.deleteMetadata(PROFILE_NS, userKey);
      page.invalidate();
      return t('ownCleared', { key: userKey });
    } catch (err) {
      return t('ownClearFailed', { error: textOf(err) });
    }
  });

  // 定点除毒入口（2026-08 群主档案投毒事件的运维刚需）：此前删单条事实只能
  // mongosh 手术或 nuke 全清。dangerous → 等级 2 + confirm，与同族 nuke 对齐
  //（它改的是**他人**档案，且 target 含冒号时直传 key、可触及任意一份档案）。
  // id 未命中时列出前若干条供定位。
  commands.use
    .command('profile.forget <target:string> <factId:string>', t('forgetDescription'), {
      risk: 'dangerous',
    })
    .action(async (argv, targetArg, factIdArg) => {
      const target = String(targetArg ?? '');
      const factId = String(factIdArg ?? '');
      const userKey = target.includes(':') ? target : userKeyOf(argv.session.platform, target);
      const mem = memory.list().find(p => p.selected)?.use;
      try {
        const profile = await loadProfile(mem, userKey);
        if (!profile || profile.facts.length === 0) return t('noProfile', { key: userKey });
        const hit = profile.facts.find(f => f.id === factId);
        if (!hit) {
          const listing = profile.facts
            .slice(0, 20)
            .map(f => `  [${f.id}] ${f.text.slice(0, 50)}`)
            .join('\n');
          return t('factNotFound', { factId, key: userKey, count: profile.facts.length, listing });
        }
        await saveProfile(mem, userKey, {
          ...profile,
          facts: profile.facts.filter(f => f.id !== factId),
          updatedAt: Date.now(),
        });
        page.invalidate();
        return t('factForgotten', { key: userKey, factId, text: hit.text.slice(0, 60) });
      } catch (err) {
        return t('forgetFailed', { error: textOf(err) });
      }
    });

  commands.use.command('profile.clear.nuke', t('nukeDescription'), { risk: 'dangerous' }).action(async () => {
    const mem = pinnedMemory();
    try {
      const [keys] = await clearMetadataNamespaces(mem, [PROFILE_NS], logger.use);
      page.invalidate();
      return t('nukeDone', { count: keys.length });
    } catch (err) {
      return t('nukeFailed', { error: textOf(err) });
    }
  });

  logger.use.info(
    `用户事实档案已启用 (every=${cfg.extractEveryNMessages <= 0 ? '禁用提取' : `${cfg.extractEveryNMessages}msgs`}, history=${cfg.historyForExtraction}, ` +
      `maxFacts=${cfg.maxFactsPerUser}, ` +
      `namespace=${PROFILE_NS})`,
  );
}
