import type { Context, ConfigSchema, Message, OutgoingMessage } from '@aalis/core';
import type { MemoryService, LLMService } from '@aalis/core';

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
  enabled: {
    type: 'boolean',
    label: '启用',
    description: '关闭后既不提取也不注入',
    default: true,
  },
  extractCooldownSec: {
    type: 'number',
    label: '提取冷却（秒）',
    description: '同一用户两次事实提取的最小时间间隔，避免每条消息都触发 LLM',
    default: 90,
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
};

export const defaultConfig = {
  enabled: true,
  extractCooldownSec: 90,
  historyForExtraction: 8,
  maxFactsPerUser: 30,
  maxFactCharsPerItem: 80,
};

/** 事实分类，用于 LLM 在同类下做覆写决策 */
type FactCategory = '兴趣爱好' | '职业身份' | '人际关系' | '近期处境' | '价值观' | '性格特征' | '偏好' | '忌讳' | '其他';
const KNOWN_CATEGORIES: FactCategory[] = ['兴趣爱好', '职业身份', '人际关系', '近期处境', '价值观', '性格特征', '偏好', '忌讳', '其他'];

interface Fact {
  /** 稳定短 ID，LLM 通过它精确指定要 update / remove 的事实 */
  id: string;
  /** 事实正文 */
  text: string;
  /** 事实分类，可空 */
  category?: FactCategory;
  /** 最近一次写入或更新的时间戳 */
  updatedAt: number;
}

interface UserProfile {
  /** 关于该用户的事实列表（最新更新的在末尾） */
  facts: Fact[];
  /** 上次提取/合并的时间戳 */
  updatedAt: number;
}

interface UserProfileConfig {
  enabled: boolean;
  extractCooldownSec: number;
  historyForExtraction: number;
  maxFactsPerUser: number;
  maxFactCharsPerItem: number;
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
    enabled: (config.enabled as boolean) ?? true,
    extractCooldownSec: Math.max(10, (config.extractCooldownSec as number) ?? 90),
    historyForExtraction: Math.max(2, (config.historyForExtraction as number) ?? 8),
    maxFactsPerUser: Math.max(5, (config.maxFactsPerUser as number) ?? 30),
    maxFactCharsPerItem: Math.max(20, (config.maxFactCharsPerItem as number) ?? 80),
  };

  if (!cfg.enabled) {
    ctx.logger.info('用户事实档案已禁用');
    return;
  }

  /** 每用户上次提取时间，用于冷却 */
  const lastExtractAt = new Map<string, number>();
  /** 防止同一用户的提取并发触发 */
  const inflightExtractions = new Set<string>();

  function userKeyOf(platform: string | undefined, userId: string): string {
    return `${platform ?? ''}:${userId}`;
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
          facts.push({ id, text: item.trim(), updatedAt: 0 });
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
          facts.push({ id, text, category: cat, updatedAt });
        }
      }
      return { facts, updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0 };
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
      updatedAt: profile.updatedAt,
    });
  }

  interface ExtractAddItem { text: string; category?: FactCategory }
  interface ExtractUpdateItem { id: string; text: string; category?: FactCategory }
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
      + '\n1. 仅记录与该用户本人相关、值得长期记住的事实，不记闲聊话题或一次性话语'
      + '\n2. 在同一 category 下，如果新信息与已有事实在含义上重叠（例如已知"喜欢猫"，新信息"还喜欢狗"），应以 update 改写原 id 为更全面的版本，而不是 add 再加一条'
      + '\n3. 如果新对话明确推翻或修正了某条已知事实（如已知"在北京工作"，但用户说"我刚搬到上海"），用 update 替换或 remove 删除'
      + '\n4. 每条 text 用一句简洁中文，不超过 80 字，不带「用户」「他」等代词，直接陈述事实'
      + '\n5. 如果没有任何更新，三个数组都返回空'
      + `\n6. category 必须是以下之一：${KNOWN_CATEGORIES.join('、')}`
      + '\n\n输出严格的 JSON（不要其他文本）：'
      + '\n{"add": [{"text": "...", "category": "..."}], "update": [{"id": "已知事实的id", "text": "新表述", "category": "..."}], "remove": ["已知事实的id"]}';

    const factListText = existingFacts.length > 0
      ? existingFacts.map(f => `[${f.id}] (${f.category ?? '未分类'}) ${f.text}`).join('\n')
      : '（暂无）';
    const who = nickname ? `${nickname}（${userId}）` : userId;
    const user = `# 该用户标识\n${who}\n\n# 已知事实（带 id，请在 update/remove 中精确引用 id）\n${factListText}\n\n# 最近对话历史\n${renderHistoryForExtract(history)}`;

    try {
      const resp = await llm.chat({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        maxTokens: 800,
        think: false,
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
            return [{ text: t, category: normalizeCategory(o.category) }];
          })
        : [];
      const update: ExtractUpdateItem[] = Array.isArray(parsed.update)
        ? (parsed.update as unknown[]).flatMap(x => {
            if (!x || typeof x !== 'object') return [];
            const o = x as Record<string, unknown>;
            const id = typeof o.id === 'string' ? o.id.trim() : '';
            const t = typeof o.text === 'string' ? o.text.trim() : '';
            if (!id || !t) return [];
            return [{ id, text: t, category: normalizeCategory(o.category) }];
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
          updatedAt: now,
        });
      } else {
        const id = genFactId(usedIds);
        usedIds.add(id);
        byId.set(id, { id, text, category: u.category, updatedAt: now });
      }
    }

    // 3. add：新增（按 text 去重，避免 LLM 同 batch 重复加同一句）
    const textSet = new Set(Array.from(byId.values()).map(f => f.text));
    for (const a of ops.add) {
      const text = clipText(a.text);
      if (textSet.has(text)) continue;
      const id = genFactId(usedIds);
      usedIds.add(id);
      byId.set(id, { id, text, category: a.category, updatedAt: now });
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

  /** 后台触发一次事实提取（带冷却 + 并发互斥） */
  async function triggerExtractionAsync(sessionId: string): Promise<void> {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.getHistory) return;
    let history: Message[];
    try {
      history = await memory.getHistory(sessionId, cfg.historyForExtraction);
    } catch {
      return;
    }
    // 找最近一条 user 消息，从其 metadata 推断身份
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    if (!lastUser) return;
    const meta = (lastUser.metadata ?? {}) as Record<string, unknown>;
    const userId = typeof meta.userId === 'string' ? meta.userId : undefined;
    if (!userId) return;
    const platform = typeof meta.platform === 'string' ? meta.platform : '';
    const nickname = typeof meta.nickname === 'string' ? meta.nickname : undefined;

    const userKey = userKeyOf(platform, userId);
    const now = Date.now();
    if (now - (lastExtractAt.get(userKey) ?? 0) < cfg.extractCooldownSec * 1000) return;
    if (inflightExtractions.has(userKey)) return;
    lastExtractAt.set(userKey, now);
    inflightExtractions.add(userKey);

    try {
      const profile = (await loadProfile(userKey)) ?? { facts: [], updatedAt: 0 };
      const ops = await llmExtractFacts(history, profile.facts, nickname, userId);
      if (ops.add.length === 0 && ops.update.length === 0 && ops.remove.length === 0) return;
      const newFacts = mergeFacts(profile.facts, ops);
      await saveProfile(userKey, { facts: newFacts, updatedAt: Date.now() });
      ctx.logger.debug(
        `用户档案已更新 (${userKey}): +${ops.add.length} ~${ops.update.length} -${ops.remove.length} → ${newFacts.length} 条`,
      );
    } catch (err) {
      ctx.logger.debug(`事实提取失败 (${userKey}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inflightExtractions.delete(userKey);
    }
  }

  // ─── 事件触发：助手回复完后异步提取 ───
  ctx.on('message:send', (msg: OutgoingMessage) => {
    if (msg.source && msg.source !== 'agent') return;
    if (!msg.sessionId) return;
    void triggerExtractionAsync(msg.sessionId);
  });

  // ─── LLM 调用前注入：把当前用户的事实档案放进 system 消息 ───
  ctx.middleware('llm-call:before', async (
    data: { messages: Message[]; tools: unknown[]; sessionId?: string; userId?: string; platform?: string },
    next,
  ) => {
    if (!data.userId) {
      await next();
      return;
    }
    const userKey = userKeyOf(data.platform, data.userId);
    const profile = await loadProfile(userKey);
    if (profile && profile.facts.length > 0) {
      // 按 category 分组渲染，可读性更好
      const groups = new Map<string, string[]>();
      for (const f of profile.facts) {
        const key = f.category ?? '其他';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(f.text);
      }
      const sections: string[] = [];
      for (const cat of KNOWN_CATEGORIES) {
        const items = groups.get(cat);
        if (items && items.length > 0) sections.push(`## ${cat}\n` + items.map(t => `- ${t}`).join('\n'));
      }
      // 兜底：未在已知 category 列表中的项
      for (const [cat, items] of groups) {
        if (!(KNOWN_CATEGORIES as string[]).includes(cat) && items.length > 0) {
          sections.push(`## ${cat}\n` + items.map(t => `- ${t}`).join('\n'));
        }
      }
      const block = `# 关于当前对话者（${data.userId}）的已知事实\n`
        + '以下是你跨会话长期积累的关于该用户的事实，用于让回应更自然贴合其个性。'
        + '不要主动罗列这些事实，也不要让用户觉得你在「读档案」，而是让它自然影响你的语气和话题选择：\n\n'
        + sections.join('\n\n');
      // 插入到第一条 system 之后（保持 persona system 在最前）
      const idx = data.messages.findIndex(m => m.role === 'system');
      const insertAt = idx >= 0 ? idx + 1 : 0;
      data.messages.splice(insertAt, 0, { role: 'system', content: block });
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
    if (data.types && !data.types.includes('user-profile') && !data.types.includes('persona')) {
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
  }, 10);

  ctx.logger.info(
    `用户事实档案已启用 (cooldown=${cfg.extractCooldownSec}s, history=${cfg.historyForExtraction}, `
    + `maxFacts=${cfg.maxFactsPerUser}, namespace=${PROFILE_NS})`,
  );
}
