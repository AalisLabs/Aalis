import type { Context, ConfigSchema, Message } from '@aalis/core';
import type { MemoryService, LLMService, LLMRouterService } from '@aalis/core';

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
// ════════════════════════════════════════════════════════════

export const name = '@aalis/plugin-user-profile';
export const displayName = '用户事实档案';
export const inject = {
  required: ['memory', 'llm'],
};

const PROFILE_NS = 'user:profile';

export const configSchema: ConfigSchema = {
  extractEveryNMessages: {
    type: 'number',
    label: '每 N 条消息提取一次',
    description: '同一用户每发 N 条消息触发一次事实提取。无论 Aalis 是否回复都会计数，群聊中每人独立计数。设为 1 表示每条消息都尝试提取（不推荐）；设为 0 或负数则禁用提取（仍会注入已有档案）',
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
    description: '超出后保留最近写入的若干条，旧事实自动淘汰',
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
    description: 'temporality=temporary 的事实超过该天数未更新后不再主动注入 prompt（仍保留在档案中，等待后续 update/remove）。0 表示不淡出',
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
  extractModel: {
    type: 'select',
    label: '提取用模型',
    description: '留空则使用当前 LLM 服务的默认模型。事实提取是简单结构化任务，推荐选择廉价/快速模型（如 deepseek-chat）以降低成本',
    default: '',
    dynamicOptions: 'llm',
  },
  allowGlobalBackfill: {
    type: 'boolean',
    label: '允许跨会话补齐副档案',
    description: '当前群/会话中的候选不足时，是否允许从其他群、私聊等跨会话中选取最近互动过的用户来补全「其他参与者背景摘要」。关闭后仅限当前上下文内出现过的用户',
    default: false,
  },
};

export const defaultConfig = {
  extractEveryNMessages: 5,
  historyForExtraction: 8,
  maxFactsPerUser: 30,
  maxFactCharsPerItem: 80,
  maxOtherParticipants: 3,
  maxFactsForOthers: 5,
  temporaryFactMaxAgeDays: 90,
  relationScoreDecayPerDay: 0.5,
  relationIncrementDirect: 1,
  relationIncrementImmediate: 1.5,
  relationIncrementInterval: 0.5,
  extractModel: '',
  allowGlobalBackfill: false,
};

/** 事实分类，用于 LLM 在同类下做覆写决策 */
type FactCategory = '兴趣爱好' | '职业身份' | '人际关系' | '近期处境' | '价值观' | '性格特征' | '偏好' | '忌讳' | '其他';
const KNOWN_CATEGORIES: FactCategory[] = ['兴趣爱好', '职业身份', '人际关系', '近期处境', '价值观', '性格特征', '偏好', '忌讳', '其他'];
type FactTemporality = 'permanent' | 'temporary';

interface Fact {
  /** 稳定短 ID，LLM 通过它精确指定要 update / remove 的事实 */
  id: string;
  /** 事实正文 */
  text: string;
  /** 事实分类，可空 */
  category?: FactCategory;
  /** 事实时效：temporary 会随时间淡出 prompt；permanent 长期有效 */
  temporality?: FactTemporality;
  /** 首次学习到该事实的时间戳 */
  observedAt?: number;
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

interface UserProfileConfig {
  extractEveryNMessages: number;
  historyForExtraction: number;
  maxFactsPerUser: number;
  maxFactCharsPerItem: number;
  maxOtherParticipants: number;
  maxFactsForOthers: number;
  temporaryFactMaxAgeDays: number;
  relationScoreDecayPerDay: number;
  relationIncrementDirect: number;
  relationIncrementImmediate: number;
  relationIncrementInterval: number;
  extractModel: string;
  allowGlobalBackfill: boolean;
}

/** 生成稳定短 ID（6 字符 base36，对 30 条以内规模碰撞概率极低） */
function genFactId(existing: Set<string>): string {
  for (let i = 0; i < 8; i++) {
    const id = 'f' + Math.random().toString(36).slice(2, 7);
    if (!existing.has(id)) return id;
  }
  // 极端兜底：加时间戳后缀
  return 'f' + Date.now().toString(36).slice(-5);
}

/** 从形如 ```json ... ``` 的文本里抠出 JSON 子串 */
function extractJsonBlock(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
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

/** 渲染历史消息为「时间 + 角色 + 文本」的简洁形式，喂给提取 LLM */
function renderHistoryForExtract(history: Message[]): string {
  return history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map(m => {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
      const role = m.role === 'user' ? '用户' : 'Aalis';
      return `[${time}] ${role}: ${m.content}`;
    })
    .join('\n');
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: UserProfileConfig = {
    extractEveryNMessages: (config.extractEveryNMessages as number) ?? 5,
    historyForExtraction: Math.max(2, (config.historyForExtraction as number) ?? 8),
    maxFactsPerUser: Math.max(5, (config.maxFactsPerUser as number) ?? 30),
    maxFactCharsPerItem: Math.max(20, (config.maxFactCharsPerItem as number) ?? 80),
    maxOtherParticipants: Math.max(0, (config.maxOtherParticipants as number) ?? 3),
    maxFactsForOthers: Math.max(1, (config.maxFactsForOthers as number) ?? 5),
    temporaryFactMaxAgeDays: Math.max(0, (config.temporaryFactMaxAgeDays as number) ?? 90),
    relationScoreDecayPerDay: Math.max(0, (config.relationScoreDecayPerDay as number) ?? 0.5),
    relationIncrementDirect: Math.max(0, (config.relationIncrementDirect as number) ?? 1),
    relationIncrementImmediate: Math.max(0, (config.relationIncrementImmediate as number) ?? 1.5),
    relationIncrementInterval: Math.max(0, (config.relationIncrementInterval as number) ?? 0.5),
    extractModel: typeof config.extractModel === 'string' ? config.extractModel.trim() : '',
    allowGlobalBackfill: (config.allowGlobalBackfill as boolean) ?? false,
  };

  /** 每用户累计入站消息数（用于 extractEveryNMessages 计数），不随提取重置 */
  const userMessageCount = new Map<string, number>();
  /** 防止同一用户的提取并发触发 */
  const inflightExtractions = new Set<string>();
  const relationScorePrecision = Math.min(6, Math.max(
    decimalPlaces(cfg.relationScoreDecayPerDay),
    decimalPlaces(cfg.relationIncrementDirect),
    decimalPlaces(cfg.relationIncrementImmediate),
    decimalPlaces(cfg.relationIncrementInterval),
  ));

  function userKeyOf(platform: string | undefined, userId: string): string {
    return `${platform ?? ''}:${userId}`;
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

  /** 读取一个用户的现有档案（不存在返回 undefined）。兼容旧格式 string[]，自动迁移 */
  async function loadProfile(userKey: string): Promise<UserProfile | undefined> {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.getMetadata) return undefined;
    try {
      const doc = await memory.getMetadata(PROFILE_NS, userKey);
      if (!doc) return undefined;
      const raw = Array.isArray(doc.facts) ? (doc.facts as unknown[]) : [];
      const usedIds = new Set<string>();
      const facts: Fact[] = [];
      for (const item of raw) {
        if (typeof item === 'string' && item.trim()) {
          // 旧格式：string → 包装为 Fact
          const id = genFactId(usedIds);
          usedIds.add(id);
          facts.push({ id, text: item.trim(), temporality: 'permanent', updatedAt: 0 });
        } else if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          const text = typeof obj.text === 'string' ? obj.text.trim() : '';
          if (!text) continue;
          let id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : genFactId(usedIds);
          // 去重 id
          while (usedIds.has(id)) id = genFactId(usedIds);
          usedIds.add(id);
          const cat = typeof obj.category === 'string' && (KNOWN_CATEGORIES as string[]).includes(obj.category)
            ? (obj.category as FactCategory)
            : undefined;
          const updatedAt = typeof obj.updatedAt === 'number' ? obj.updatedAt : 0;
          const observedAt = typeof obj.observedAt === 'number' ? obj.observedAt : (updatedAt || undefined);
          facts.push({
            id,
            text,
            category: cat,
            temporality: normalizeTemporality(obj.temporality, cat),
            observedAt,
            timeHint: normalizeTextField(obj.timeHint),
            updatedAt,
          });
        }
      }
      return {
        facts,
        relationScore: typeof doc.relationScore === 'number' ? Math.min(100, Math.max(0, doc.relationScore)) : 0,
        interactionCount: typeof doc.interactionCount === 'number' ? Math.max(0, Math.floor(doc.interactionCount)) : 0,
        lastInteractionAt: typeof doc.lastInteractionAt === 'number' ? doc.lastInteractionAt : undefined,
        updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0,
      };
    } catch (err) {
      ctx.logger.debug(`加载用户档案失败 (${userKey}): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** 保存档案（覆盖式） */
  async function saveProfile(userKey: string, profile: UserProfile): Promise<void> {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.saveMetadata) return;
    await memory.saveMetadata(PROFILE_NS, userKey, {
      facts: profile.facts,
      relationScore: profile.relationScore ?? 0,
      interactionCount: profile.interactionCount ?? 0,
      lastInteractionAt: profile.lastInteractionAt,
      updatedAt: profile.updatedAt,
    });
  }

  interface ExtractAddItem { text: string; category?: FactCategory; temporality?: FactTemporality; timeHint?: string }
  interface ExtractUpdateItem { id: string; text: string; category?: FactCategory; temporality?: FactTemporality; timeHint?: string }
  interface ExtractResult { add: ExtractAddItem[]; update: ExtractUpdateItem[]; remove: string[] }

  function normalizeCategory(v: unknown): FactCategory | undefined {
    if (typeof v !== 'string') return undefined;
    return (KNOWN_CATEGORIES as string[]).includes(v) ? (v as FactCategory) : undefined;
  }

  /** 调用 LLM 从历史中提取/修订事实，返回 add / update / remove 三类操作 */
  async function llmExtractFacts(
    history: Message[],
    existingFacts: Fact[],
    nickname: string | undefined,
    userId: string,
  ): Promise<ExtractResult> {
    const llm = ctx.getService<LLMService>('llm');
    const empty: ExtractResult = { add: [], update: [], remove: [] };
    if (!llm?.chat) return empty;

    const sys = '你是用户档案管理员。请从给定的对话历史中识别「关于该用户值得长期记住」的事实，'
      + '维护一份精炼、准确、不冗余的档案。'
      + '\n\n你可以执行三种操作（在一次输出里组合）：'
      + '\n- add: 添加新事实，需指定 text 与 category'
      + '\n- update: 用 id 精确替换某条已知事实（用于含义重叠或表述需要修正的情况，**优先使用 update 而非 add 来避免重复**）'
      + '\n- remove: 用 id 删除已被推翻、过时、或确认错误的事实'
      + '\n\n规则：'
      + `\n1. 仅记录与「该用户」本人相关、值得长期记住的事实，不记闲聊话题或一次性话语；群聊历史中可能含多人发言（以发送者前缀区分），只关注目标用户自身的发言`
      + '\n2. 在同一 category 下，如果新信息与已有事实在含义上重叠（例如已知"喜欢猫"，新信息"还喜欢狗"），应以 update 改写原 id 为更全面的版本，而不是 add 再加一条'
      + '\n3. 如果新对话明确推翻或修正了某条已知事实（如已知"在北京工作"，但用户说"我刚搬到上海"），用 update 替换或 remove 删除'
      + `\n4. 每条 text 用一句简洁中文，不超过 ${cfg.maxFactCharsPerItem} 字，不带「用户」「他」等代词，直接陈述事实`
      + '\n5. 如果没有任何更新，三个数组都返回空'
      + `\n6. category 必须是以下之一：${KNOWN_CATEGORIES.join('、')}`
      + '\n7. 每条 add/update 都必须给出 temporality：长期稳定偏好、性格、身份、人际关系用 permanent；近期状态、正在进行的事、短期计划用 temporary'
      + '\n8. 如果对话中出现明确或隐含时间（如“最近”“上周”“今年4月”“昨天”），用 timeHint 记录简短时间线索；没有就省略或用空字符串'
      + '\n\n输出严格的 JSON（不要其他文本）：'
      + '\n{"add": [{"text": "...", "category": "...", "temporality": "permanent|temporary", "timeHint": "..."}], "update": [{"id": "已知事实的id", "text": "新表述", "category": "...", "temporality": "permanent|temporary", "timeHint": "..."}], "remove": ["已知事实的id"]}';

    const factListText = existingFacts.length > 0
      ? existingFacts.map(f => `[${f.id}] (${f.category ?? '未分类'}) ${f.text}`).join('\n')
      : '（暂无）';
    const who = nickname ? `${nickname}（${userId}）` : userId;
    const user = `# 该用户标识\n${who}\n\n# 已知事实（带 id，请在 update/remove 中精确引用 id）\n${factListText}\n\n# 最近对话历史\n${renderHistoryForExtract(history)}`;

    // 若指定了提取模型，通过路由器找到正确的 provider 实例；否则使用默认 LLM
    let extractLlm: LLMService | undefined = llm;
    let extractModelId: string | undefined;
    if (cfg.extractModel) {
      const routed = await ctx.getService<LLMRouterService>('llm', ['router'])?.resolveModelProvider(cfg.extractModel);
      if (routed) {
        extractLlm = routed.instance as LLMService;
        extractModelId = routed.model;
      } else {
        ctx.logger.warn(`用户档案提取：找不到模型 "${cfg.extractModel}" 的提供者，回退到默认 LLM`);
      }
    }

    try {
      const resp = await extractLlm!.chat({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        maxTokens: 800,
        think: false,
        ...(extractModelId ? { model: extractModelId } : {}),
      });
      const text = (resp.content ?? '').trim();
      if (!text) return empty;
      const jsonStr = extractJsonBlock(text);
      const parsed = JSON.parse(jsonStr) as { add?: unknown; update?: unknown; remove?: unknown };
      const add: ExtractAddItem[] = Array.isArray(parsed.add)
        ? (parsed.add as unknown[]).flatMap(x => {
            if (!x || typeof x !== 'object') return [];
            const o = x as Record<string, unknown>;
            const t = typeof o.text === 'string' ? o.text.trim() : '';
            if (!t) return [];
            const category = normalizeCategory(o.category);
            return [{
              text: t,
              category,
              temporality: normalizeTemporality(o.temporality, category),
              timeHint: normalizeTextField(o.timeHint),
            }];
          })
        : [];
      const update: ExtractUpdateItem[] = Array.isArray(parsed.update)
        ? (parsed.update as unknown[]).flatMap(x => {
            if (!x || typeof x !== 'object') return [];
            const o = x as Record<string, unknown>;
            const id = typeof o.id === 'string' ? o.id.trim() : '';
            const t = typeof o.text === 'string' ? o.text.trim() : '';
            if (!id || !t) return [];
            const category = normalizeCategory(o.category);
            return [{
              id,
              text: t,
              category,
              temporality: normalizeTemporality(o.temporality, category),
              timeHint: normalizeTextField(o.timeHint),
            }];
          })
        : [];
      const remove: string[] = Array.isArray(parsed.remove)
        ? (parsed.remove as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim())
        : [];
      return { add, update, remove };
    } catch (err) {
      ctx.logger.debug(`事实提取 LLM 调用失败：${err instanceof Error ? err.message : String(err)}`);
      return empty;
    }
  }

  function clipText(s: string): string {
    return s.length > cfg.maxFactCharsPerItem
      ? s.slice(0, cfg.maxFactCharsPerItem) + '…'
      : s;
  }

  function clampRelationScore(score: number): number {
    const factor = 10 ** relationScorePrecision;
    return Math.min(100, Math.max(0, Math.round(score * factor) / factor));
  }

  function relationIncrementFor(triggerType: 'direct' | 'immediate' | 'interval' | 'idle' | undefined): number {
    if (triggerType === 'immediate') return cfg.relationIncrementImmediate;
    if (triggerType === 'interval') return cfg.relationIncrementInterval;
    if (triggerType === 'idle') return 0;
    return cfg.relationIncrementDirect;
  }

  function applyRelationUpdate(profile: UserProfile, triggerType: 'direct' | 'immediate' | 'interval' | 'idle' | undefined): UserProfile {
    const now = Date.now();
    const last = profile.lastInteractionAt;
    const daysSinceLast = last ? Math.max(0, (now - last) / 86_400_000) : 0;
    const decayed = clampRelationScore((profile.relationScore ?? 0) - daysSinceLast * cfg.relationScoreDecayPerDay);
    const nextScore = clampRelationScore(decayed + relationIncrementFor(triggerType));
    return {
      ...profile,
      relationScore: nextScore,
      interactionCount: (profile.interactionCount ?? 0) + (triggerType === 'idle' ? 0 : 1),
      lastInteractionAt: triggerType === 'idle' ? profile.lastInteractionAt : now,
      updatedAt: now,
    };
  }

  /** 合并 add/update/remove 到现有事实，应用上限与单条裁剪 */
  function mergeFacts(existing: Fact[], ops: ExtractResult): Fact[] {
    const now = Date.now();
    const byId = new Map<string, Fact>();
    for (const f of existing) byId.set(f.id, f);

    // 1. remove：精确按 id
    for (const id of ops.remove) byId.delete(id);

    // 2. update：按 id 替换（id 不存在则降级为 add）
    const usedIds = new Set(byId.keys());
    for (const u of ops.update) {
      const text = clipText(u.text);
      if (byId.has(u.id)) {
        const old = byId.get(u.id)!;
        byId.set(u.id, {
          id: u.id,
          text,
          category: u.category ?? old.category,
          temporality: u.temporality ?? old.temporality ?? normalizeTemporality(undefined, u.category ?? old.category),
          observedAt: old.observedAt ?? now,
          timeHint: u.timeHint ?? old.timeHint,
          updatedAt: now,
        });
      } else {
        const id = genFactId(usedIds);
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

    // 3. add：新增（按 text 去重，避免 LLM 同 batch 重复加同一句）
    const textSet = new Set(Array.from(byId.values()).map(f => f.text));
    for (const a of ops.add) {
      const text = clipText(a.text);
      if (textSet.has(text)) continue;
      const id = genFactId(usedIds);
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
    // 输出按 updatedAt 升序，最近更新的排在尾部（注入 prompt 时一致）
    merged.sort((a, b) => a.updatedAt - b.updatedAt);
    return merged;
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
    const memory = ctx.getService<MemoryService>('memory');
    try {
      if (!memory?.getHistory) return;
      const history = await memory.getHistory(sessionId, cfg.historyForExtraction);
      const profile = (await loadProfile(userKey)) ?? { facts: [], relationScore: 0, interactionCount: 0, updatedAt: 0 };
      const ops = await llmExtractFacts(history, profile.facts, nickname, userId);
      if (ops.add.length === 0 && ops.update.length === 0 && ops.remove.length === 0) return;
      const newFacts = mergeFacts(profile.facts, ops);
      // 重新读取最新档案，避免覆盖提取期间（LLM 调用时）已写入的 relationScore 等字段
      const freshProfile = (await loadProfile(userKey)) ?? profile;
      await saveProfile(userKey, { ...freshProfile, facts: newFacts, updatedAt: Date.now() });
      ctx.logger.debug(
        `用户档案已更新 (${userKey}): +${ops.add.length} ~${ops.update.length} -${ops.remove.length} → ${newFacts.length} 条`,
      );
    } catch (err) {
      ctx.logger.debug(`事实提取失败 (${userKey}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inflightExtractions.delete(userKey);
    }
  }

  async function updateRelationForUser(
    userKey: string,
    triggerType: 'direct' | 'immediate' | 'interval' | 'idle' | undefined,
  ): Promise<void> {
    const profile = (await loadProfile(userKey)) ?? { facts: [], relationScore: 0, interactionCount: 0, updatedAt: 0 };
    await saveProfile(userKey, applyRelationUpdate(profile, triggerType));
  }

  // ─── 关系分数：在 agent 触发回复路径上更新 ───
  // priority=800：低于 persona(999)，避免干扰主流程，但在 agent 之前执行
  // 关系强度与"是否触发回复"绑定，因此仍走 agent:input:before 中间件。
  ctx.middleware('agent:input:before', async (
    data: { message: { sessionId: string; userId?: string; platform?: string; nickname?: string; triggerType?: 'direct' | 'immediate' | 'interval' | 'idle' } },
    next,
  ) => {
    const { userId, platform, triggerType } = data.message;
    if (userId) {
      const userKey = userKeyOf(platform, userId);
      try {
        await updateRelationForUser(userKey, triggerType);
      } catch (err) {
        ctx.logger.debug(`关系强度更新异常 (${userKey}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await next();
  });

  // ─── 事实提取触发：每条入站消息落库后立即计数，与 agent 是否回复无关 ───
  // 监听 message-archive 在 archiveIncoming 落库成功后发出的 inbound:message:archived 事件，
  // 确保缓冲消息（onebot saveBufferedMessage 等不触发 agent 回复的路径）也能纳入计数。
  ctx.on('inbound:message:archived', (...args: unknown[]) => {
    const data = args[0] as { sessionId: string; incoming: { userId?: string; platform?: string; nickname?: string } };
    const { sessionId, incoming } = data;
    const { userId, platform, nickname } = incoming;
    if (!userId) return;

    const userKey = userKeyOf(platform, userId);
    const count = (userMessageCount.get(userKey) ?? 0) + 1;
    userMessageCount.set(userKey, count);
    if (cfg.extractEveryNMessages <= 0 || count % cfg.extractEveryNMessages !== 0) return;

    void triggerExtractionForUser(sessionId, userId, platform ?? '', nickname).catch(
      (err: unknown) => ctx.logger.debug(
        `事实提取异常 (${userKey}): ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  });

  function isFactActive(fact: Fact): boolean {
    if (fact.temporality !== 'temporary') return true;
    if (cfg.temporaryFactMaxAgeDays <= 0) return true;
    const base = fact.updatedAt || fact.observedAt || 0;
    if (!base) return true;
    return Date.now() - base <= cfg.temporaryFactMaxAgeDays * 86_400_000;
  }

  function renderFactLine(fact: Fact, includeMeta: boolean): string {
    if (!includeMeta) return `- ${fact.text}`;
    const meta: string[] = [];
    if (fact.timeHint) meta.push(`时间线索：${fact.timeHint}`);
    const observed = fact.observedAt || fact.updatedAt;
    if (observed) meta.push(`记录于：${new Date(observed).toLocaleDateString('zh-CN')}`);
    if (fact.temporality === 'temporary') meta.push('临时状态');
    return meta.length > 0 ? `- ${fact.text}（${meta.join('；')}）` : `- ${fact.text}`;
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
      return `### ${label}\n` + subset.map(f => renderFactLine(f, false)).join('\n');
    }
    const sections: string[] = [];
    for (const cat of KNOWN_CATEGORIES) {
      const items = groups.get(cat);
      if (items && items.length > 0) sections.push(`## ${cat}\n` + items.join('\n'));
    }
    for (const [cat, items] of groups) {
      if (!(KNOWN_CATEGORIES as string[]).includes(cat) && items.length > 0) {
        sections.push(`## ${cat}\n` + items.join('\n'));
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

  // ─── LLM 调用前注入：根据 triggerType 区分主发言者语义 ───
  //   direct/immediate/undefined → data.userId 是主发言者，注入完整档案 + 其他参与者摘要
  //   interval                   → 无主发言者（只是恰好撞上频率），所有参与者一律 compact 摘要
  //   idle                       → 无 userId，只注入历史 messages 中出现的参与者 compact 摘要
  ctx.middleware('agent:llm:before', async (
    data: {
      messages: Message[];
      tools: unknown[];
      sessionId?: string;
      userId?: string;
      platform?: string;
      triggerType?: 'direct' | 'immediate' | 'interval' | 'idle';
    },
    next,
  ) => {
    if (data.messages.some(m => m.role === 'system' && m.metadata?.source === 'user-profile')) {
      await next();
      return;
    }

    const blocksToInsert: string[] = [];
    const trigger = data.triggerType ?? 'direct';
    const hasPrimarySpeaker = trigger === 'direct' || trigger === 'immediate';

    // 1. 主发言者完整档案：仅在确实有人在「和 Aalis 对话」时注入
    if (hasPrimarySpeaker && data.userId) {
      const userKey = userKeyOf(data.platform, data.userId);
      const profile = await loadProfile(userKey);
      if (profile && profile.facts.some(isFactActive)) {
        const body = renderProfileBlock(profile.facts, data.userId, false);
        const relationLine = renderRelationLine(profile);
        const block = `# 关于当前对话者（${data.userId}）的已知事实\n`
          + '以下是你跨会话长期积累的关于该用户的事实，用于让回应更自然贴合其个性。'
          + '不要主动罗列这些事实，也不要让用户觉得你在「读档案」，而是让它自然影响你的语气和话题选择：\n\n'
          + (relationLine ? `${relationLine}\n\n` : '')
          + body;
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
        const meta = (msg.metadata ?? {}) as Record<string, unknown>;
        const uid = typeof meta.userId === 'string' ? meta.userId.trim() : undefined;
        if (!uid) continue;
        const plat = typeof meta.platform === 'string' ? meta.platform : data.platform ?? '';
        const nick = typeof meta.nickname === 'string' ? meta.nickname : undefined;
        if (addOther(uid, plat, nick)) break;
      }

      if (cfg.allowGlobalBackfill && others.size < candidateLimit) {
        const memory = ctx.getService<MemoryService>('memory');
        if (memory?.listMetadata) {
          try {
            const globalRecent = await memory.listMetadata(PROFILE_NS);
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
              const uid = item.key.slice(sep + 1);
              addOther(uid, platform);
            }
          } catch (err) {
            ctx.logger.debug(`加载最近互动用户失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (others.size > 0) {
        const snippets: string[] = [];
        for (const [key, info] of others) {
          let profile: UserProfile | undefined;
          try { profile = await loadProfile(key); } catch { /* 静默跳过 */ }
          if (!profile || !profile.facts.some(isFactActive)) continue;
          const label = info.nickname ? `${info.nickname}（${info.userId}）` : info.userId;
          const relationLine = renderRelationLine(profile);
          snippets.push(renderProfileBlock(profile.facts, label, true) + (relationLine ? `\n- ${relationLine}` : ''));
          if (snippets.length >= cfg.maxOtherParticipants) break;
        }
        if (snippets.length > 0) {
          // 标题根据语义切换：有主发言者 → 「其他参与者」；无主发言者 → 「在场参与者」
          const title = hasPrimarySpeaker ? '群聊其他参与者背景摘要' : '在场参与者背景摘要';
          const intro = hasPrimarySpeaker
            ? '以下是同一会话中其他参与者的基本档案，供你在群聊语境中参考，了解他们是谁。'
            : '当前没有人直接呼叫你，以下是会话中近期出现过的参与者档案，供你判断要不要插话以及和谁互动。';
          const block = `# ${title}\n${intro}不要主动透露这些信息，只在自然相关时使用：\n\n` + snippets.join('\n\n');
          blocksToInsert.push(block);
        }
      }
    }

    if (blocksToInsert.length > 0) {
      const idx = data.messages.findIndex(m => m.role === 'system');
      const insertAt = idx >= 0 ? idx + 1 : 0;
      data.messages.splice(insertAt, 0, ...blocksToInsert.map(content => ({
        role: 'system' as const,
        content,
        metadata: { source: 'user-profile' },
      })));
    }

    await next();
  });

  // ─── 参与统一的 memory:clear ───
  ctx.middleware('memory:clear', async (data: {
    scope: 'session' | 'all';
    types?: string[];
    sessionId?: string;
    results: Array<{ source: string; success: boolean; message: string }>;
  }, next) => {
    if (data.types && !data.types.includes('user-profile')) {
      await next();
      return;
    }
    if (data.scope !== 'all') {
      // 用户档案是跨会话的，会话级清除不动它
      await next();
      return;
    }
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.listMetadata || !memory?.deleteMetadata) {
      await next();
      return;
    }
    try {
      const items = await memory.listMetadata(PROFILE_NS);
      for (const it of items) await memory.deleteMetadata(PROFILE_NS, it.key);
      data.results.push({ source: 'user-profile', success: true, message: `用户档案已清空 (${items.length} 条)` });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      data.results.push({ source: 'user-profile', success: false, message: `用户档案清空失败: ${m}` });
    }
    await next();
  });

  // ─── /profile 指令族 ───
  // /profile              查看自己的档案
  // /profile clear        清除自己的档案（authority=2，自己删自己的）
  // /profile clear nuke   清空所有用户档案（authority=3，dangerous）
  ctx.command(
    'profile',
    '查看你在 Aalis 中的事实档案',
    async (cmdCtx) => {
      if (!cmdCtx.userId) return '当前会话未识别用户身份，无法查看档案。';
      const userKey = userKeyOf(cmdCtx.platform, cmdCtx.userId);
      const profile = await loadProfile(userKey);
      if (!profile || profile.facts.length === 0) {
        return `📭 暂无档案数据 (${userKey})`;
      }
      const block = renderProfileBlock(profile.facts, userKey, false);
      const meta = `关系强度：${(profile.relationScore ?? 0).toFixed(relationScorePrecision)}/100，互动次数：${profile.interactionCount ?? 0}`;
      return `📇 你的档案 (${userKey})\n${meta}\n\n${block}`;
    },
    {
      subcommands: [
        {
          name: 'clear',
          description: '清除你自己的事实档案',
          authority: 2,
          action: async (cmdCtx) => {
            if (!cmdCtx.userId) return '当前会话未识别用户身份，无法清除档案。';
            const userKey = userKeyOf(cmdCtx.platform, cmdCtx.userId);
            const memory = ctx.getService<MemoryService>('memory');
            if (!memory?.deleteMetadata || !memory.getMetadata) return '记忆服务不支持档案删除。';
            try {
              const existed = await memory.getMetadata(PROFILE_NS, userKey);
              if (!existed) return `📭 你当前没有档案数据 (${userKey})`;
              await memory.deleteMetadata(PROFILE_NS, userKey);
              return `✅ 已清除你的档案 (${userKey})`;
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              return `❌ 清除失败：${m}`;
            }
          },
          subcommands: [
            {
              name: 'nuke',
              description: '【危险】清空所有用户档案',
              authority: 3,
              safety: 'dangerous',
              action: async () => {
                const memory = ctx.getService<MemoryService>('memory');
                if (!memory?.listMetadata || !memory?.deleteMetadata) {
                  return '记忆服务不支持档案批量删除。';
                }
                try {
                  const items = await memory.listMetadata(PROFILE_NS);
                  for (const it of items) await memory.deleteMetadata(PROFILE_NS, it.key);
                  return `✅ 已清空全部用户档案（${items.length} 条）`;
                } catch (err) {
                  const m = err instanceof Error ? err.message : String(err);
                  return `❌ 清空失败：${m}`;
                }
              },
            },
          ],
        },
      ],
    },
  );

  ctx.logger.info(
    `用户事实档案已启用 (every=${cfg.extractEveryNMessages <= 0 ? '禁用提取' : cfg.extractEveryNMessages + 'msgs'}, history=${cfg.historyForExtraction}, `
    + `maxFacts=${cfg.maxFactsPerUser}, namespace=${PROFILE_NS})`,
  );
}
