import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { commands } from '@aalis/api-commands';
import { contributions } from '@aalis/api-contributions';
import { hooks } from '@aalis/api-hooks';
import { lightestThinking, llm, resolveLLMModel } from '@aalis/api-llm';
import { clearMetadataNamespaces, type MemoryService, memory } from '@aalis/api-memory';
import { tools } from '@aalis/api-tools';
import { userRelation } from '@aalis/api-user-relation';
import { webuiServer } from '@aalis/api-webui';
import { type BoundOf, config, definePlugin, events, logger, optional } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import type { Message } from '@aalis/schema-message';
import { DIRECTIVE_KINDS, WellKnownMetadataKeys } from '@aalis/schema-message';
import { parseLLMJsonObject } from '@aalis/util-json-repair';

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
// 关系强度（relationScore, 0~100）计算规则：
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

const configSchema = defineConfig({
  extractEveryNMessages: {
    type: 'number',
    label: '每 N 条消息提取一次',
    description:
      '同一用户每发 N 条消息触发一次事实提取。无论 Aalis 是否回复都会计数，群聊中每人独立计数。设为 1 表示每条消息都尝试提取（不推荐）；设为 0 或负数则禁用提取（仍会注入已有档案）',
    default: 5,
  },
  historyForExtraction: {
    type: 'number',
    label: '提取参考历史条数',
    description: '触发提取时，喂给 LLM 的最近消息条数',
    default: 8,
  },
  maxFactsPerUser: {
    type: 'number',
    label: '单用户事实上限',
    description:
      '超出后按 updatedAt 升序淘汰最久未更新的，旧事实自动淘汰。最小有效值为 5（写入时自动下限），不支持设为 0 来禁用提取；若要禁用提取请将 extractEveryNMessages 设为 0',
    default: 30,
  },
  maxFactCharsPerItem: {
    type: 'number',
    label: '单条事实字数上限',
    description: '超出会被裁断，避免 LLM 输出长段落代替事实',
    default: 80,
  },
  maxOtherParticipants: {
    type: 'number',
    label: '群聊其他参与者档案上限',
    description: '群聊中除当前发言者外，最多加载多少人的档案摘要注入 LLM。0 表示禁用群聊多用户注入',
    default: 3,
  },
  maxFactsForOthers: {
    type: 'number',
    label: '其他参与者摘要条数上限',
    description: '群聊背景参与者每人只显示最近更新的 N 条事实，避免 prompt 过长',
    default: 5,
  },
  temporaryFactMaxAgeDays: {
    type: 'number',
    label: '临时事实保留天数',
    description:
      'temporality=temporary 的事实超过该天数未更新后不再主动注入 prompt（仍保留在档案中，等待后续 update/remove）。0 表示不淡出',
    default: 90,
  },
  relationScoreDecayPerDay: {
    type: 'number',
    label: '关系强度每日衰减',
    description: '用户长期未互动时，relationScore 每天衰减的分数。0 表示不衰减',
    default: 0.5,
  },
  relationIncrementDirect: {
    type: 'number',
    label: '私聊关系增量',
    description: 'direct 触发时每条消息增加的关系强度',
    default: 1,
  },
  relationIncrementImmediate: {
    type: 'number',
    label: '主动呼叫关系增量',
    description: '群聊 @/名字主动触发时每条消息增加的关系强度',
    default: 1.5,
  },
  relationIncrementInterval: {
    type: 'number',
    label: '群聊被动参与关系增量',
    description: '群聊频率/活跃度被动触发或普通入站消息增加的关系强度',
    default: 0.5,
  },
  relationIncrementWitness: {
    type: 'number',
    label: '旁观（不回复）关系增量',
    description:
      '每条入站消息无论 agent 是否回复都加上的最低档增量。若 agent 触发回复，会再叠加 direct/immediate/interval 之一。0 表示旁观不加分；互动次数与最近互动时戳仍照记（衰减基准与最近互动排序的唯一来源）',
    default: 0.1,
  },
  extractLLM: {
    type: 'llm-ref',
    label: '提取用模型',
    description:
      '留空则使用当前 LLM 服务的默认模型。事实提取是简单结构化任务，推荐选择廉价/快速模型（如 deepseek-chat）以降低成本',
  },
  allowGlobalBackfill: {
    type: 'boolean',
    onInvalid: 'error',
    label: '允许跨会话补齐副档案',
    description:
      '当前群/会话中的候选不足时，是否允许从其他群、私聊等跨会话中选取最近互动过的用户来补全「其他参与者背景摘要」。关闭后仅限当前上下文内出现过的用户',
    default: false,
  },
});

/** 事实分类，用于 LLM 在同类下做覆写决策 */
type FactCategory =
  | '兴趣爱好'
  | '职业身份'
  | '人际关系'
  | '近期处境'
  | '价值观'
  | '性格特征'
  | '偏好'
  | '忌讳'
  | '其他';
const KNOWN_CATEGORIES: FactCategory[] = [
  '兴趣爱好',
  '职业身份',
  '人际关系',
  '近期处境',
  '价值观',
  '性格特征',
  '偏好',
  '忌讳',
  '其他',
];
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
 * 将文本标准化为可子串匹配的形式：去空白、去常见标点、toLowerCase。
 * 用于 sourceQuote 校验，容忍 LLM 轻微原词改写。
 */
function normalizeForQuoteMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[。，、；：？！“”‘’（）《》【】.,;:?!"'()[\]<>\-_~`*]/g, '');
}

/**
 * 拼接目标用户自己发言作为 sourceQuote 校验语料。
 * 只包含目标用户 role==='user' 且 metadata.userId 匹配的消息。
 */
function buildTargetUserCorpus(history: Message[], userId: string, platform: string): string {
  return history
    .filter(m => isTargetUserMessage(m, userId, platform))
    .map(m => m.content ?? '')
    .join('\n');
}

/**
 * 渲染完整会话历史供提取 LLM 作为消歧上下文：
 * 每行带身份标签区分「目标用户」与「其他用户」，
 * 不做 strip（引用原话不会在目标用户语料中出现，sourceQuote 校验能拦住）。
 */
function renderHistoryForExtract(history: Message[], userId: string, platform: string): string {
  return history
    .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'notice') && m.content)
    .map(m => {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
      const content = (m.content ?? '').trim();
      if (!content) return '';
      if (m.role === 'assistant') {
        // Aalis 的回复：加标签让 LLM 知道用户是在跟谁互动，用于判断「对 Aalis 的行为」
        return `[${time}] [Aalis]: ${content}`;
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
  /** 档案页；不在时照常记档案 */
  webui: optional(webuiServer),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-user-profile',
  displayName: '用户事实档案',
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
    extractLLM:
      parsed.extractLLM &&
      typeof parsed.extractLLM === 'object' &&
      parsed.extractLLM.provider &&
      parsed.extractLLM.model
        ? parsed.extractLLM
        : undefined,
  };

  /** 每会话每用户累计入站消息数（用于 extractEveryNMessages 计数），不随提取重置 */
  const userMessageCount = new Map<string, number>();
  /** 防止同一用户的提取并发触发 */
  const inflightExtractions = new Set<string>();
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
      throw new Error(`不认识的事实：${rowKey}`);
    }
    return ref as [string, string];
  }

  const page = webui.use.definePage({
    key: 'profiles',
    title: '用户档案',
    icon: 'contact',
    actions: {
      forgetFact: {
        label: '删除',
        effect: 'destructive',
        confirm: '删掉后，以后的对话里不再带上这条事实。',
        row: true,
        async handler({ rowKey }) {
          const [userKey, factId] = parseFactRef(rowKey);
          const mem = pinnedMemory();
          const profile = await loadProfile(mem, userKey);
          const hit = profile?.facts.find(f => f.id === factId);
          if (!profile || !hit) throw new Error('这条事实已经不在档案里了');
          await saveProfile(mem, userKey, {
            ...profile,
            facts: profile.facts.filter(f => f !== hit),
            updatedAt: Date.now(),
          });
          page.invalidate();
          return `已删除：${hit.text}`;
        },
      },
      clearProfile: {
        label: '清空档案',
        effect: 'destructive',
        confirm: '这个人的全部事实连同关系强度、互动次数一起清空。',
        row: true,
        async handler({ rowKey }) {
          const mem = pinnedMemory();
          if (!(await mem.getMetadata(PROFILE_NS, rowKey))) throw new Error(`${rowKey} 已经没有档案了`);
          await mem.deleteMetadata(PROFILE_NS, rowKey);
          page.invalidate();
          return `已清空 ${rowKey} 的档案`;
        },
      },
    },
    content: [
      {
        type: 'table',
        id: 'profiles',
        rowKey: 'key',
        description: '她从对话里记下的关于各人的事实，会带进以后的对话。这里只能删除，不能改写。',
        empty: '还没有人的档案',
        columns: [
          { key: 'key', label: '用户', primary: true },
          { key: 'facts', label: '事实', primary: true },
          { key: 'updatedAt', label: '最近记下', kind: 'time' },
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
            empty: '这个人的档案里没有事实了',
            columns: [
              { key: 'text', label: '事实', primary: true },
              { key: 'category', label: '分类' },
              { key: 'temporality', label: '时效' },
              { key: 'updatedAt', label: '记下', kind: 'time' },
            ],
            rowActions: [{ action: 'forgetFact' }],
            async data({ rowKey }) {
              const facts = (await loadProfile(memory.use, rowKey))?.facts ?? [];
              return facts
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map(f => ({
                  ref: JSON.stringify([rowKey, f.id]),
                  text: f.text,
                  category: f.category ?? '',
                  temporality: f.temporality === 'temporary' ? '近期' : '长期',
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
    sourceQuote?: string;
  }
  interface ExtractUpdateItem {
    id: string;
    text: string;
    category?: FactCategory;
    temporality?: FactTemporality;
    timeHint?: string;
    sourceQuote?: string;
  }
  interface ExtractResult {
    add: ExtractAddItem[];
    update: ExtractUpdateItem[];
    remove: string[];
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
          const t = typeof o.text === 'string' ? o.text.trim() : '';
          if (!t) return [];
          const category = normalizeCategory(o.category);
          const sourceQuote = typeof o.sourceQuote === 'string' ? o.sourceQuote.trim() : '';
          return [
            {
              text: t,
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
          const t = typeof o.text === 'string' ? o.text.trim() : '';
          if (!id || !t) return [];
          const category = normalizeCategory(o.category);
          const sourceQuote = typeof o.sourceQuote === 'string' ? o.sourceQuote.trim() : '';
          return [
            {
              id,
              text: t,
              category,
              temporality: normalizeTemporality(o.temporality, category),
              timeHint: normalizeTextField(o.timeHint),
              sourceQuote,
            },
          ];
        })
      : [];
    const remove: string[] = Array.isArray(obj.remove)
      ? (obj.remove as unknown[])
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map(s => s.trim())
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
  ): Promise<ExtractResult> {
    const empty: ExtractResult = {
      add: [],
      update: [],
      remove: [],
    };

    const sys =
      '你是用户档案管理员。输入是一段多用户会话历史，每行开头有身份标签：' +
      '`[目标用户 X(uid)]`、`[其他用户 Y(uid)]` 或 `[Aalis]`。上下文仅供消歧，' +
      '**只允许根据「目标用户」自己的发言写入事实**，不能根据其他用户、Aalis 的猜测或提问写入事实。' +
      '\n\n你可以执行三种操作（在一次输出里组合）：' +
      '\n- add: 添加新事实，需指定 text、category、sourceQuote' +
      '\n- update: 用 id 精确替换某条已知事实，同样需 sourceQuote（优先使用 update 而非 add 来避免重复）' +
      '\n- remove: 用 id 删除已被推翻、过时的事实（不需 sourceQuote）' +
      '\n\n规则：' +
      '\n1. 事实的**主语必须是「目标用户」本人**，不能是 ta 转述、讨论、评价的第三方。' +
      '即使 sourceQuote 出自目标用户原话，也要先在脑中追问：' +
      '\n   - 这是 ta 在说自己，还是在评价/复述别人？（比如目标用户说"小明会写檄文" → 这是关于小明的，不写）' +
      '\n   - 是认真陈述，还是反讽/否定/假设/角色扮演？（"我可不喜欢爵士" → 否定，不写；跑团扮演 NPC 的台词 → 不写）' +
      '\n   - 如果原始依据来自「其他用户」的发言，即使在说目标用户，也不允许写入（他人可能记错、说反话）' +
      '\n   **拿不准就不写。profile 漏几条没关系，写错才麻烦。**' +
      '\n   ⚠️ 例外——`人际关系` 类：除上述通用规则外，该类还允许记录目标用户**与 Aalis 之间长期可观察的关系模式**，' +
      '包含两种情况：' +
      '\n   (a) 行为身份类：用户在 Aalis 项目中扮演的角色或长期重复的行为' +
      '（示例 text：「是 Aalis 的开发维护者」「经常向 Aalis 提交功能建议」「常帮助测试和排查 Aalis 的故障」）' +
      '\n   (b) 长期情感模式类：用户对 Aalis 表现出的**反复出现的态度倾向**（不是单次情绪）' +
      '（示例 text：「常对 Aalis 表达依赖与喜爱」「习惯把日常烦恼向 Aalis 倾诉」「喜欢调侃 Aalis」）' +
      '\n   ❌ 严禁仅凭单次发言推断情感事实：一次抱怨/一次感谢/一次撒娇都不算"模式"，不写。' +
      '必须是已有事实佐证 + 本轮再次出现的同类行为才允许 update 强化，或会话历史多处反复出现才允许 add。' +
      '依据必须是「目标用户」发言中可直接推断的内容，sourceQuote 取目标用户发言原话。' +
      '\n2. **sourceQuote 必须是「目标用户」自己发言中的原话片段**，可以是某一句话的一部分，必须能一字不改在「目标用户」某行的原文中找到；不要采用「其他用户」的原话，不要自己总结改写' +
      '\n3. 在同一 category 下，如果新信息与已有事实在含义上重叠（例如已知"喜欢猫"，新信息"还喜欢狗"），应以 update 改写原 id 为更全面的版本，而不是 add 再加一条' +
      '\n4. 如果新对话明确推翻或修正了某条已知事实（如已知"在北京工作"，但用户说"我刚搬到上海"），用 update 替换或 remove 删除' +
      `\n5. 每条 text 用一句简洁中文，不超过 ${cfg.maxFactCharsPerItem} 字，不带「用户」「他」等代词，直接陈述事实` +
      '\n6. 如果没有任何更新，或所有候选都拿不准，三个数组都返回空——**保守优先**' +
      `\n7. category 必须是以下之一：${KNOWN_CATEGORIES.join('、')}` +
      '\n8. 每条 add/update 都必须给出 temporality：长期稳定偏好、性格、身份、人际关系用 permanent；近期状态、正在进行的事、短期计划用 temporary' +
      '\n9. 如果对话中出现明确或隐含时间（如“最近”“上周”“今年4月”“昨天”），用 timeHint 记录简短时间线索；没有就省略或用空字符串' +
      '\n\n输出严格的 JSON（不要其他文本）：' +
      '\n{"add": [{"text": "...", "category": "...", "temporality": "permanent|temporary", "timeHint": "...", "sourceQuote": "目标用户发言中的原话片段"}], "update": [{"id": "已知事实的id", "text": "新表述", "category": "...", "temporality": "permanent|temporary", "timeHint": "...", "sourceQuote": "目标用户发言中的原话片段"}], "remove": ["已知事实的id"]}';

    const factListText =
      existingFacts.length > 0
        ? existingFacts.map(f => `[${f.id}] (${f.category ?? '未分类'}) ${f.text}`).join('\n')
        : '（暂无）';
    const who = nickname ? `${nickname}（${userId}）` : userId;
    const renderedHistory = renderHistoryForExtract(history, userId, platform);
    const user =
      `# 提取目标\n${who}\n\n# 已知事实（带 id，请在 update/remove 中精确引用 id）\n${factListText}` +
      `\n\n# 会话历史（含多用户，仅供消歧；只能从「目标用户」发言中提取事实）\n${renderedHistory || '（暂无会话历史）'}`;

    // 优先用 cfg.extractLLM 指定的模型；否则取默认 chat-capable LLM。
    const entry = resolveLLMModel(llm, cfg.extractLLM, ['chat']);
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
      let text = (resp.content ?? '').trim();
      if (!text) return empty;
      let { parsed } = parseLLMJsonObject(text);
      if (!parsed) {
        // util-json-repair 已尝试剥 fence + 修裸引号 + 补括号；仍失败 → 模型多半
        // 写成了纯文本/markdown。给一次显式反馈再来一次，避免一次失败丢失整批事实。
        logger.use.warn(`[user-profile] LLM 输出无法解析为 JSON，尝试重试一次。原文前 200 字：${text.slice(0, 200)}`);
        const retryResp = await extractLlm.chat({
          messages: [
            ...baseMessages,
            { role: 'assistant', content: text },
            {
              role: 'user',
              content:
                '你上一条输出无法被 JSON.parse（很可能是包了 markdown 代码块、夹杂解释文字、或被截断）。' +
                '请只输出**一个**合法的 JSON 对象，第一个字符必须是 `{`、最后一个字符必须是 `}`，' +
                '禁止 ```json 围栏、禁止任何解释、禁止 markdown。如果实在没有可写入的事实，' +
                '就输出 `{"add":[],"update":[],"remove":[]}`。',
            },
          ],
          temperature: 0.2,
          maxTokens: 800,
          think: lightestThinking(extractLlm),
        });
        text = (retryResp.content ?? '').trim();
        ({ parsed } = parseLLMJsonObject(text));
        if (!parsed) {
          logger.use.warn(
            `[user-profile] LLM 重试后仍无法解析 JSON，放弃本批次。重试原文前 200 字：${text.slice(0, 200)}`,
          );
          return empty;
        }
        logger.use.debug('[user-profile] LLM 重试后解析成功');
      }
      const { add, update, remove } = parseFactOps(parsed);

      // sourceQuote 校验：quote 可能跨多条消息（LLM 用 \n 拼接），
      // 因此按行拆分，每行（非空）都必须能在「目标用户」语料中找到 normalize 后的子串。
      // 这样即使行与行之间夹着其他用户的消息也不会被错误拒收。
      const targetCorpus = normalizeForQuoteMatch(buildTargetUserCorpus(history, userId, platform));
      const validateSourceQuote = (item: { text: string; sourceQuote?: string }, kind: 'add' | 'update'): boolean => {
        const q = item.sourceQuote?.trim() ?? '';
        if (!q) {
          logger.use.warn(`[user-profile] 丢弃 ${kind} fact（未提供 sourceQuote）: ${item.text}`);
          return false;
        }
        const lines = q
          .split(/\r?\n/)
          .map(l => l.trim())
          .filter(l => l.length > 0);
        const fragments = lines.length > 0 ? lines : [q];
        for (const frag of fragments) {
          const normalized = normalizeForQuoteMatch(frag);
          if (!normalized) continue;
          if (!targetCorpus.includes(normalized)) {
            logger.use.warn(
              `[user-profile] 丢弃 ${kind} fact（sourceQuote 片段不在目标用户 ${userId} 发言中）: text="${item.text}" fragment="${frag}"`,
            );
            return false;
          }
        }
        return true;
      };
      const validatedAdd = add.filter(item => validateSourceQuote(item, 'add'));
      const validatedUpdate = update.filter(item => validateSourceQuote(item, 'update'));
      return { add: validatedAdd, update: validatedUpdate, remove };
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

  function relationIncrementFor(
    triggerType: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive' | 'witness' | undefined,
  ): number {
    if (triggerType === 'immediate') return cfg.relationIncrementImmediate;
    if (triggerType === 'interval') return cfg.relationIncrementInterval;
    if (triggerType === 'idle') return 0;
    if (triggerType === 'witness') return cfg.relationIncrementWitness;
    return cfg.relationIncrementDirect;
  }

  function applyRelationUpdate(
    profile: UserProfile,
    triggerType: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive' | 'witness' | undefined,
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
    const shouldCount = countInteraction && triggerType !== 'idle';
    return {
      ...profile,
      relationScore: nextScore,
      interactionCount: (profile.interactionCount ?? 0) + (shouldCount ? 1 : 0),
      lastInteractionAt: shouldCount ? now : profile.lastInteractionAt,
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
      const ops = await llmExtractFacts(history, snapshotFacts, nickname, userId, platform);
      const hasFactOps = ops.add.length > 0 || ops.update.length > 0 || ops.remove.length > 0;
      if (!hasFactOps) return;
      // 以 LLM 返回后重读的档案为合并基底：调用期间档案可能被清空或删了事实，以调用前的快照
      // 为基底会把删掉的内容整份写回；重读也保住期间写入的 relationScore 等字段
      const fresh = (await loadProfile(mem, userKey)) ?? { facts: [], updatedAt: 0 };
      const newFacts = mergeFactList(
        fresh.facts,
        ops.add,
        dropUpdatesOfDeletedFacts(ops.update, snapshotFacts, fresh.facts),
        ops.remove,
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
    triggerType: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive' | 'witness' | undefined,
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
  hooks.use.middleware('agent:input:before', async (data, next) => {
    const { userId, platform, triggerType } = data.message;
    if (userId) {
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
    if (!userId) return;

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

  /** 将一个用户的 Fact[] 渲染为分组文本块 */
  function renderProfileBlock(facts: Fact[], label: string, compact: boolean): string {
    const groups = new Map<string, string[]>();
    const activeFacts = facts.filter(isFactActive);
    // compact 模式（群聊背景参与者）：只取最近更新的 N 条，不分组
    const subset = compact
      ? [...activeFacts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, cfg.maxFactsForOthers)
      : activeFacts;
    for (const f of subset) {
      const key = f.category ?? '其他';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(renderFactLine(f, !compact));
    }
    if (compact) {
      // compact 模式：平铺，不加分组标题
      return `### ${label}\n${subset.map(f => renderFactLine(f, false)).join('\n')}`;
    }
    const sections: string[] = [];
    for (const cat of KNOWN_CATEGORIES) {
      const items = groups.get(cat);
      if (items && items.length > 0) sections.push(`## ${cat}\n${items.join('\n')}`);
    }
    for (const [cat, items] of groups) {
      if (!(KNOWN_CATEGORIES as string[]).includes(cat) && items.length > 0) {
        sections.push(`## ${cat}\n${items.join('\n')}`);
      }
    }
    return sections.join('\n\n');
  }

  function renderRelationLine(profile: UserProfile): string {
    const score = profile.relationScore ?? 0;
    const count = profile.interactionCount ?? 0;
    if (score <= 0 && count <= 0) return '';
    return `关系强度：${score.toFixed(relationScorePrecision)}/100；累计互动：${count} 次。`;
  }

  // ─── LLM 调用前注入（agent:prompt 贡献 / turn-context 槽——档案按当前发言者取材、换人即变，落历史后护前缀缓存）：根据 triggerType 区分主发言者语义 ───
  //   direct/immediate/undefined → view.userId 是主发言者，注入完整档案 + 其他参与者摘要
  //   interval                   → 无主发言者（只是恰好撞上频率），所有参与者一律 compact 摘要
  //   idle                       → 无 userId，只注入历史 messages 中出现的参与者 compact 摘要
  // 多块返回保序共键：主发言者档案 → 其他参与者。
  contributions.use.contribute('agent:prompt', {
    id: 'user-profile',
    anchor: 'turn-context',
    async build(data) {
      // 干跑(token 快照)跳过档案加载——该路径 userId 为空串,加载既昂贵又无意义
      if (data.dryRun) return null;

      const mem = memory.present ? memory.use : undefined;
      const blocksToInsert: string[] = [];
      const trigger = data.triggerType ?? 'direct';
      const hasPrimarySpeaker = trigger === 'direct' || trigger === 'immediate';

      // 1. 主发言者完整档案：仅在确实有人在「和 Aalis 对话」时注入
      if (hasPrimarySpeaker && data.userId) {
        const userKey = userKeyOf(data.platform, data.userId);
        const profile = await loadProfileLenient(mem, userKey);
        if (profile?.facts.some(isFactActive)) {
          const body = renderProfileBlock(profile.facts, data.userId, false);
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
            `# 关于当前对话者（${data.userId}）的已知事实\n` +
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
      //    - hasPrimarySpeaker 为 true 时排除主发言者
      //    - hasPrimarySpeaker 为 false 时（interval/idle）所有人平等显示
      if (cfg.maxOtherParticipants > 0) {
        const primaryKey = hasPrimarySpeaker && data.userId ? userKeyOf(data.platform, data.userId) : undefined;
        const others = new Map<string, { userId: string; nickname?: string; platform?: string }>();
        const candidateLimit = Math.max(cfg.maxOtherParticipants * 5, cfg.maxOtherParticipants + 10);

        function addOther(userId: string, platform?: string, nickname?: string): boolean {
          const uid = userId.trim();
          if (!uid) return false;
          const userKey = userKeyOf(platform, uid);
          if (primaryKey && userKey === primaryKey) return false;
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
  hooks.use.middleware('memory:clear', async (data, next) => {
    if (data.types && !data.types.includes('user-profile')) {
      await next();
      return;
    }
    if (data.scope !== 'all') {
      // 用户档案是跨会话的，会话级清除不动它
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
        message: `用户档案已清空 (${keys.length} 条)`,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      data.results.push({
        source: 'user-profile',
        type: 'user-profile',
        success: false,
        message: `用户档案清空失败: ${m}`,
      });
    }
    page.invalidate();
    await next();
  });

  // ─── 工具：user_profile_lookup ───
  // 让 Agent 在对话中主动查询任意用户的事实档案。
  // 设计要点：
  // - 全局可查（用户决定 C）：跨平台/跨群均可
  // - 两种调用方式：① user_key 直传；② platform+user_id 组合
  tools.use.registerGroup({
    name: 'user-profile',
    label: '用户档案',
    description: '查询 Aalis 已经积累的某人事实档案。',
  });
  tools.use.register({
    definition: {
      type: 'function',
      function: {
        name: 'user_profile_lookup',
        description:
          '查询 Aalis 已积累的某个用户的事实档案。当对话中提到某人、或你想回忆已知信息时使用。' +
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
  commands.use.command('profile', '查看你在 Aalis 中的事实档案').action(async argv => {
    const userId = argv.session.userId;
    if (!userId) return '当前会话未识别用户身份，无法查看档案。';
    const userKey = userKeyOf(argv.session.platform, userId);
    const profile = await loadProfileLenient(memory.present ? memory.use : undefined, userKey);
    if (!profile || profile.facts.length === 0) {
      return `📭 暂无档案数据 (${userKey})`;
    }
    const block = renderProfileBlock(profile.facts, userKey, false);
    const meta = `关系强度：${(profile.relationScore ?? 0).toFixed(relationScorePrecision)}/100，互动次数：${profile.interactionCount ?? 0}`;
    return `📇 你的档案 (${userKey})\n${meta}\n\n${block}`;
  });

  commands.use.command('profile.clear', '清除你自己的事实档案', { visibility: 'restricted' }).action(async argv => {
    const userId = argv.session.userId;
    if (!userId) return '当前会话未识别用户身份，无法清除档案。';
    const userKey = userKeyOf(argv.session.platform, userId);
    const mem = pinnedMemory();
    try {
      const existed = await mem.getMetadata(PROFILE_NS, userKey);
      if (!existed) return `📭 你当前没有档案数据 (${userKey})`;
      await mem.deleteMetadata(PROFILE_NS, userKey);
      page.invalidate();
      return `✅ 已清除你的档案 (${userKey})`;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return `❌ 清除失败：${m}`;
    }
  });

  // 定点除毒入口（2026-08 群主档案投毒事件的运维刚需）：此前删单条事实只能
  // mongosh 手术或 nuke 全清。dangerous → 等级 2 + confirm，与同族 nuke 对齐
  //（它改的是**他人**档案，且 target 含冒号时直传 key、可触及任意一份档案）。
  // id 未命中时列出前若干条供定位。
  commands.use
    .command('profile.forget <target:string> <factId:string>', '定点删除某用户档案中的一条事实（运维除毒）', {
      risk: 'dangerous',
    })
    .action(async (argv, targetArg, factIdArg) => {
      const target = String(targetArg ?? '');
      const factId = String(factIdArg ?? '');
      const userKey = target.includes(':') ? target : userKeyOf(argv.session.platform, target);
      const mem = memory.list().find(p => p.selected)?.use;
      try {
        const profile = await loadProfile(mem, userKey);
        if (!profile || profile.facts.length === 0) return `📭 无档案数据 (${userKey})`;
        const hit = profile.facts.find(f => f.id === factId);
        if (!hit) {
          const listing = profile.facts
            .slice(0, 20)
            .map(f => `  [${f.id}] ${f.text.slice(0, 50)}`)
            .join('\n');
          return `未找到事实 [${factId}]。${userKey} 现有 ${profile.facts.length} 条：\n${listing}`;
        }
        await saveProfile(mem, userKey, {
          ...profile,
          facts: profile.facts.filter(f => f.id !== factId),
          updatedAt: Date.now(),
        });
        page.invalidate();
        return `✅ 已删除 ${userKey} 的事实 [${factId}]：${hit.text.slice(0, 60)}`;
      } catch (err) {
        return `❌ 删除失败：${err instanceof Error ? err.message : String(err)}`;
      }
    });

  commands.use.command('profile.clear.nuke', '【危险】清空所有用户档案', { risk: 'dangerous' }).action(async () => {
    const mem = pinnedMemory();
    try {
      const [keys] = await clearMetadataNamespaces(mem, [PROFILE_NS], logger.use);
      page.invalidate();
      return `✅ 已清空全部用户档案（${keys.length} 条）`;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return `❌ 清空失败：${m}`;
    }
  });

  logger.use.info(
    `用户事实档案已启用 (every=${cfg.extractEveryNMessages <= 0 ? '禁用提取' : `${cfg.extractEveryNMessages}msgs`}, history=${cfg.historyForExtraction}, ` +
      `maxFacts=${cfg.maxFactsPerUser}, ` +
      `namespace=${PROFILE_NS})`,
  );
}
