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

interface UserProfile {
  /** 关于该用户的事实列表（最新写入的在末尾） */
  facts: string[];
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

  /** 读取一个用户的现有档案（不存在返回 undefined） */
  async function loadProfile(userKey: string): Promise<UserProfile | undefined> {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.getMetadata) return undefined;
    try {
      const doc = await memory.getMetadata(PROFILE_NS, userKey);
      if (!doc) return undefined;
      const facts = Array.isArray(doc.facts) ? (doc.facts as unknown[]).filter((x): x is string => typeof x === 'string') : [];
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

  /** 调用 LLM 从历史中提取/修订事实 */
  async function llmExtractFacts(
    history: Message[],
    existingFacts: string[],
    nickname: string | undefined,
    userId: string,
  ): Promise<{ add: string[]; remove: string[] }> {
    const llm = ctx.getService<LLMService>('llm');
    if (!llm?.chat) return { add: [], remove: [] };

    const sys = '你是用户档案管理员。请从给定的对话历史中识别「关于该用户值得长期记住」的事实，'
      + '包括但不限于：兴趣爱好、职业身份、人际关系、近期处境、价值观、明显的个性特征、'
      + '已表达过的偏好或忌讳。'
      + '\n\n规则：'
      + '\n1. 仅提取与该用户本人相关的事实，不要记录闲聊话题或一次性话语'
      + '\n2. 与已知事实重复的不要再加'
      + '\n3. 如果已知事实中有明显被新对话推翻或过时的，列入 remove'
      + '\n4. 每条事实用一句简洁中文，不超过 80 字，不带「用户」「他」等代词，直接陈述'
      + '\n5. 如果没有可提取的新事实，add 输出空数组'
      + '\n\n输出严格的 JSON：{"add": ["事实1", "事实2"], "remove": ["要删除的旧事实原文"]}';

    const factListText = existingFacts.length > 0
      ? existingFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '（暂无）';
    const who = nickname ? `${nickname}（${userId}）` : userId;
    const user = `# 该用户标识\n${who}\n\n# 已知事实\n${factListText}\n\n# 最近对话历史\n${renderHistoryForExtract(history)}`;

    try {
      const resp = await llm.chat({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        maxTokens: 600,
        think: false,
      });
      const text = (resp.content ?? '').trim();
      if (!text) return { add: [], remove: [] };
      const jsonStr = extractJsonBlock(text);
      const parsed = JSON.parse(jsonStr) as { add?: unknown; remove?: unknown };
      const add = Array.isArray(parsed.add)
        ? (parsed.add as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [];
      const remove = Array.isArray(parsed.remove)
        ? (parsed.remove as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [];
      return { add, remove };
    } catch (err) {
      ctx.logger.debug(`事实提取 LLM 调用失败：${err instanceof Error ? err.message : String(err)}`);
      return { add: [], remove: [] };
    }
  }

  /** 合并 add/remove 到现有事实，应用上限与单条裁剪 */
  function mergeFacts(existing: string[], add: string[], remove: string[]): string[] {
    const removeSet = new Set(remove.map(s => s.trim()));
    let merged = existing.filter(f => !removeSet.has(f.trim()));
    const existingSet = new Set(merged.map(s => s.trim()));
    for (const f of add) {
      const trimmed = f.trim();
      if (!trimmed || existingSet.has(trimmed)) continue;
      const clipped = trimmed.length > cfg.maxFactCharsPerItem
        ? trimmed.slice(0, cfg.maxFactCharsPerItem) + '…'
        : trimmed;
      merged.push(clipped);
      existingSet.add(trimmed);
    }
    if (merged.length > cfg.maxFactsPerUser) {
      // 保留最近写入的（数组尾部），淘汰最旧的
      merged = merged.slice(-cfg.maxFactsPerUser);
    }
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
      const { add, remove } = await llmExtractFacts(history, profile.facts, nickname, userId);
      if (add.length === 0 && remove.length === 0) return;
      const newFacts = mergeFacts(profile.facts, add, remove);
      await saveProfile(userKey, { facts: newFacts, updatedAt: Date.now() });
      ctx.logger.debug(`用户档案已更新 (${userKey}): +${add.length} -${remove.length} → ${newFacts.length} 条`);
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
      const block = `# 关于当前对话者（${data.userId}）的已知事实\n`
        + '以下是你跨会话长期积累的关于该用户的事实，用于让回应更自然贴合其个性。'
        + '不要主动罗列这些事实，也不要让用户觉得你在「读档案」，而是让它自然影响你的语气和话题选择：\n'
        + profile.facts.map(f => `- ${f}`).join('\n');
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
