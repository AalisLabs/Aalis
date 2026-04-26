import type {
  Context,
  ConfigSchema,
  LLMService,
  MemoryService,
  PersonaService,
  PlatformManagerService,
  PlatformSessionCandidate,
  Message,
  ToolCallContext,
  ToolDefinition,
  ToolCall,
} from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-advisor';
export const displayName = '跨会话顾问';
export const provides = ['advisor'];

export const inject = {
  required: ['llm'],
  optional: [
    'memory',
    'persona',
    'semantic-memory',
    'tools',
    'platform-manager',
    'message-archive',
  ],
};

// ===== 配置 =====

export const configSchema: ConfigSchema = {
  model: {
    type: 'string',
    label: '模型 ID',
    default: '',
    description: '为顾问指定专属模型 ID（覆盖 llm 服务默认）。留空使用全局默认 LLM。',
  },
  maxIterations: {
    type: 'number',
    label: '最大工具迭代轮数',
    default: 3,
    description: '顾问内部 LLM ↔ 工具循环的最大轮数。',
  },
  maxRecommendations: {
    type: 'number',
    label: '最大建议数',
    default: 3,
    description: 'query() 返回的 recommendations 上限。',
  },
  recentMessageLimit: {
    type: 'number',
    label: '会话近况条数',
    default: 20,
    description: 'get_session_recent 工具默认返回的最大条数。',
  },
  idleEnabled: {
    type: 'boolean',
    label: '启用平台级空闲 tick',
    default: false,
    description:
      '启用后，按 idleTickMinutes 间隔轮询所有平台候选会话，由顾问决定是否要主动开聊。' +
      '通常配合 OneBot 适配器的 idleTriggerScope=platform 使用，避免双重触发。',
  },
  idleTickMinutes: {
    type: 'number',
    label: 'tick 间隔（分钟）',
    default: 30,
    description: '平台级 tick 的轮询间隔。建议 ≥ 10 分钟。',
  },
  systemPrompt: {
    type: 'textarea',
    label: '顾问系统提示词',
    default: '',
    description: '留空使用内置默认。该提示词会被附加在每次 query 的 system 消息中。',
  },
};

export const defaultConfig = {
  model: '',
  maxIterations: 3,
  maxRecommendations: 3,
  recentMessageLimit: 20,
  idleEnabled: false,
  idleTickMinutes: 30,
  systemPrompt: '',
};

interface AdvisorConfig {
  model: string;
  maxIterations: number;
  maxRecommendations: number;
  recentMessageLimit: number;
  idleEnabled: boolean;
  idleTickMinutes: number;
  systemPrompt: string;
}

// ===== 服务接口（导出供外部引用） =====

export interface AdvisorRecommendation {
  sessionId: string;
  score: number;
  reason: string;
  topicHint: string;
}

export interface AdvisorAnswer {
  answer: string;
  recommendations: AdvisorRecommendation[];
  shouldAct: boolean;
}

export interface AdvisorQueryArgs {
  /** 提给顾问的问题；'proactive' 模式下可省略 */
  question?: string;
  /** 决策模式：analyze=只分析回答；proactive=判断是否该主动开聊 */
  mode?: 'analyze' | 'proactive';
  /** 限定平台 */
  platform?: string;
  /** 限定到单个会话 */
  sessionId?: string;
}

export interface AdvisorService {
  query(args: AdvisorQueryArgs): Promise<AdvisorAnswer>;
}

// ===== 默认提示词 =====

const DEFAULT_SYSTEM_PROMPT = `你是 Aalis 的「跨会话顾问 (advisor)」子智能体。

你的职责：
- 接受主智能体或调度器的问题，跨会话地汇总信息、给出结论或建议。
- 你只能调用提供给你的只读元数据/记忆工具，绝不能代替主智能体回复用户。
- 你不能直接发送消息到任何会话；最终是否发送由调用方决定。

工作步骤：
1. 先用 list_sessions 获取所有候选会话快照（含活跃度、是否禁言、限速余额、群名/对端昵称）。
2. 必要时用 get_session_recent / semantic_recall 召回内容片段。
3. 根据问题/模式得出结论。

最终输出：必须是单个 JSON 对象，符合以下 schema（不要带 \`\`\`json fence，不要附加多余文本）：
{
  "answer": string,                  // 一句话结论
  "recommendations": [               // 0~N 条建议
    {
      "sessionId": string,
      "score": number,               // 0~1，越高越推荐
      "reason": string,              // 简短原因
      "topicHint": string            // 若 shouldAct=true，此字段是推荐发起的话题/开场，主智能体会据此组织回复
    }
  ],
  "shouldAct": boolean               // proactive 模式下：是否建议主智能体真的去发起；analyze 模式下固定 false
}

约束：
- 跨会话内容仅做提炼，不要把别人会话的原文塞进 answer。
- 如果当前所有会话都不适合主动开聊（深夜、刚回过、被禁言、限速已满等），shouldAct=false。
- 推荐至多 ${'${maxRecommendations}'} 条，按 score 降序。
`;

// ===== 工具构造（顾问内部专用） =====

function buildAdvisorToolDefs(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_sessions',
        description:
          '列出当前所有可发送消息的平台会话快照（仅元数据：活跃度、群名/对端、禁言/限速状态）。' +
          '不会返回任何消息内容。' +
          '调用一次即可获得全局视野；之后再用 get_session_recent / semantic_recall 取细节。',
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', description: '可选：限定平台名（如 onebot）。' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_session_recent',
        description: '获取指定会话最近 N 条消息（含 user/assistant/system，按时间升序）。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: '目标会话 ID（含平台前缀）。' },
            limit: { type: 'number', description: '条数，默认 20，最多 50。' },
          },
          required: ['sessionId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'semantic_recall',
        description:
          '在长期向量记忆中按关键词检索片段，必要时用于回忆某人/某话题的历史。' +
          '若 semantic-memory 未启用则返回空结果。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词或自然语言问题。' },
            sessionId: { type: 'string', description: '可选：限定到某会话内召回。' },
            topK: { type: 'number', description: '默认 5，最多 15。' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_persona_state',
        description: '获取当前人设的简要信息（名称、昵称列表、禁言关键词），用于判断主动开聊的语气边界。',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

// ===== 顾问服务实现 =====

class AdvisorImpl implements AdvisorService {
  /** 防并发：同一 advisor 实例同时只跑一个 query */
  private inflight = false;

  constructor(
    private readonly ctx: Context,
    private readonly cfg: AdvisorConfig,
  ) {}

  async query(args: AdvisorQueryArgs): Promise<AdvisorAnswer> {
    if (this.inflight) {
      return {
        answer: '顾问正忙（已有一次 query 在进行），请稍后再试。',
        recommendations: [],
        shouldAct: false,
      };
    }
    this.inflight = true;
    try {
      return await this.runQuery(args);
    } finally {
      this.inflight = false;
    }
  }

  private async runQuery(args: AdvisorQueryArgs): Promise<AdvisorAnswer> {
    const llm = this.ctx.getService<LLMService>('llm');
    if (!llm) {
      return { answer: 'LLM 服务不可用', recommendations: [], shouldAct: false };
    }

    const mode = args.mode ?? 'analyze';
    const tools = buildAdvisorToolDefs();
    const systemPrompt = this.buildSystemPrompt(mode);
    const userMessage = this.buildUserMessage(args, mode);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    let iter = 0;
    while (iter <= this.cfg.maxIterations) {
      const resp = await llm.chat({
        messages,
        tools,
        model: this.cfg.model || undefined,
      });

      const toolCalls = resp.toolCalls ?? [];
      // 把 assistant 这一轮加入历史
      messages.push({
        role: 'assistant',
        content: resp.content ?? '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (toolCalls.length === 0) {
        return this.parseFinal(resp.content ?? '', mode);
      }

      if (iter === this.cfg.maxIterations) {
        // 已用尽迭代预算，强制收尾：让模型基于现有信息直接产出结论
        messages.push({
          role: 'user',
          content: '已达到工具调用上限，请基于以上信息直接给出最终 JSON 结果，不要再调用任何工具。',
        });
        const finalResp = await llm.chat({
          messages,
          tools: [],
          model: this.cfg.model || undefined,
        });
        return this.parseFinal(finalResp.content ?? '', mode);
      }

      // 执行工具调用
      for (const call of toolCalls) {
        const result = await this.dispatchTool(call, args);
        messages.push({
          role: 'tool',
          content: result,
          toolCallId: call.id,
          name: call.function.name,
        });
      }
      iter++;
    }

    return { answer: '迭代异常退出', recommendations: [], shouldAct: false };
  }

  private buildSystemPrompt(mode: 'analyze' | 'proactive'): string {
    const base = (this.cfg.systemPrompt && this.cfg.systemPrompt.trim())
      ? this.cfg.systemPrompt
      : DEFAULT_SYSTEM_PROMPT.replace('${maxRecommendations}', String(this.cfg.maxRecommendations));
    const suffix = mode === 'proactive'
      ? '\n\n当前模式：proactive。任务是判断「现在是否该主动找某个会话开聊」。务必谨慎：宁可 shouldAct=false，也不要在不合适的时机打扰用户。'
      : '\n\n当前模式：analyze。仅做分析回答，shouldAct 固定为 false。';
    return base + suffix;
  }

  private buildUserMessage(args: AdvisorQueryArgs, mode: 'analyze' | 'proactive'): string {
    const lines: string[] = [];
    if (args.question) {
      lines.push(`问题：${args.question}`);
    } else if (mode === 'proactive') {
      lines.push('问题：在当前所有平台会话中，是否有任何一个适合此刻主动开聊？如果有，请给出最佳候选与开场话题。');
    } else {
      lines.push('问题：请综合所有会话状态给出当前整体观察。');
    }
    if (args.platform) lines.push(`限定平台：${args.platform}`);
    if (args.sessionId) lines.push(`限定会话：${args.sessionId}`);
    lines.push(`maxRecommendations=${this.cfg.maxRecommendations}`);
    return lines.join('\n');
  }

  private parseFinal(raw: string, mode: 'analyze' | 'proactive'): AdvisorAnswer {
    const text = raw.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 尝试从代码块或包裹文本中抽取 JSON
      const m = text.match(/\{[\s\S]*\}$/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { parsed = undefined; }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { answer: text || '顾问未给出结构化结果', recommendations: [], shouldAct: false };
    }
    const obj = parsed as Record<string, unknown>;
    const rawRecs = Array.isArray(obj.recommendations) ? obj.recommendations : [];
    const recommendations: AdvisorRecommendation[] = rawRecs
      .map((r): AdvisorRecommendation | null => {
        if (!r || typeof r !== 'object') return null;
        const rr = r as Record<string, unknown>;
        const sessionId = typeof rr.sessionId === 'string' ? rr.sessionId : '';
        if (!sessionId) return null;
        return {
          sessionId,
          score: Number(rr.score) || 0,
          reason: String(rr.reason ?? ''),
          topicHint: String(rr.topicHint ?? ''),
        };
      })
      .filter((r): r is AdvisorRecommendation => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.cfg.maxRecommendations);
    return {
      answer: String(obj.answer ?? ''),
      recommendations,
      shouldAct: mode === 'proactive' ? Boolean(obj.shouldAct) : false,
    };
  }

  private async dispatchTool(call: ToolCall, args: AdvisorQueryArgs): Promise<string> {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return JSON.stringify({ error: 'invalid arguments JSON' });
    }
    try {
      switch (call.function.name) {
        case 'list_sessions':
          return await this.toolListSessions(parsed, args);
        case 'get_session_recent':
          return await this.toolGetSessionRecent(parsed);
        case 'semantic_recall':
          return await this.toolSemanticRecall(parsed, args);
        case 'get_persona_state':
          return this.toolGetPersonaState();
        default:
          return JSON.stringify({ error: `unknown tool: ${call.function.name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: String(err instanceof Error ? err.message : err) });
    }
  }

  private async toolListSessions(parsed: Record<string, unknown>, args: AdvisorQueryArgs): Promise<string> {
    const platform = (parsed.platform as string) || args.platform;
    let candidates: PlatformSessionCandidate[] = [];
    const mgr = this.ctx.getService<PlatformManagerService>('platform-manager');
    if (mgr?.listSessionCandidates) {
      candidates = mgr.listSessionCandidates(platform);
    } else {
      candidates = this.ctx.getPlatformSessionCandidates(platform);
    }
    return JSON.stringify({
      count: candidates.length,
      sessions: candidates,
    });
  }

  private async toolGetSessionRecent(parsed: Record<string, unknown>): Promise<string> {
    const sessionId = String(parsed.sessionId ?? '');
    if (!sessionId) return JSON.stringify({ error: 'sessionId required' });
    const limit = Math.min(50, Math.max(1, Number(parsed.limit) || this.cfg.recentMessageLimit));
    const memory = this.ctx.getService<MemoryService>('memory');
    if (!memory) return JSON.stringify({ error: 'memory service not available' });
    const msgs = await memory.getHistory(sessionId, limit);
    const rendered = msgs.map(m => ({
      role: m.role,
      ts: m.timestamp,
      content: typeof m.content === 'string' ? m.content.slice(0, 400) : '',
    }));
    return JSON.stringify({ sessionId, count: rendered.length, messages: rendered });
  }

  private async toolSemanticRecall(parsed: Record<string, unknown>, _args: AdvisorQueryArgs): Promise<string> {
    const query = String(parsed.query ?? '').trim();
    if (!query) return JSON.stringify({ error: 'query required' });
    const tools = this.ctx.tools;
    if (!tools) return JSON.stringify({ error: 'tools service unavailable' });
    const all = tools.getAll();
    if (!all.some(t => t.name === 'memory_recall')) {
      return JSON.stringify({ available: false, hits: [] });
    }
    const callCtx: ToolCallContext = {
      sessionId: (parsed.sessionId as string) || 'advisor:internal',
    };
    const result = await tools.execute('memory_recall', {
      query,
      ...(parsed.topK !== undefined ? { topK: parsed.topK } : {}),
    }, callCtx);
    return result;
  }

  private toolGetPersonaState(): string {
    const persona = this.ctx.getService<PersonaService>('persona');
    if (!persona) return JSON.stringify({ available: false });
    return JSON.stringify({
      available: true,
      personaName: persona.getPersonaName(),
      nickNames: persona.getNickNames?.() ?? [],
      muteKeywords: persona.getMuteKeywords?.() ?? [],
    });
  }
}

// ===== 平台级空闲 tick =====

function startIdleTick(ctx: Context, advisor: AdvisorImpl, cfg: AdvisorConfig): () => void {
  if (!cfg.idleEnabled) return () => {};
  const intervalMs = Math.max(60_000, cfg.idleTickMinutes * 60_000);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const platforms = ctx.getPlatformNames();
      for (const platform of platforms) {
        const candidates = ctx.getPlatformSessionCandidates(platform);
        if (candidates.length === 0) continue;
        // 仅当至少存在一个 sendable 候选时才询问 advisor
        const sendable = candidates.filter(c =>
          !c.isMuted &&
          !c.isOnCooldown &&
          (c.replyBudgetRemaining === undefined || c.replyBudgetRemaining > 0));
        if (sendable.length === 0) continue;

        let result: AdvisorAnswer;
        try {
          result = await advisor.query({ mode: 'proactive', platform });
        } catch (err) {
          ctx.logger.warn(`advisor tick query 失败 (${platform}): ${err}`);
          continue;
        }
        if (!result.shouldAct || result.recommendations.length === 0) {
          ctx.logger.debug(`advisor tick (${platform}): shouldAct=false, ${result.recommendations.length} 候选`);
          continue;
        }
        const top = result.recommendations[0];
        const candidate = sendable.find(c => c.sessionId === top.sessionId);
        if (!candidate) {
          ctx.logger.debug(`advisor 推荐了不可发送的会话 ${top.sessionId}，跳过`);
          continue;
        }
        ctx.logger.info(
          `advisor tick (${platform}): 主动开聊 → ${top.sessionId} (score=${top.score.toFixed(2)}) reason=${top.reason}`,
        );
        const promptHint = top.topicHint
          || `请根据人设主动开启一个轻松的话题。原因：${top.reason}`;
        await ctx.emit('message:received', {
          content: promptHint,
          sessionId: top.sessionId,
          platform,
          source: 'idle-trigger',
        });
      }
    } catch (err) {
      ctx.logger.warn(`advisor tick 异常: ${err}`);
    } finally {
      running = false;
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

// ===== 入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: AdvisorConfig = {
    model: (config.model as string) ?? '',
    maxIterations: Math.max(1, (config.maxIterations as number) ?? 3),
    maxRecommendations: Math.max(1, (config.maxRecommendations as number) ?? 3),
    recentMessageLimit: Math.max(1, (config.recentMessageLimit as number) ?? 20),
    idleEnabled: (config.idleEnabled as boolean) ?? false,
    idleTickMinutes: Math.max(1, (config.idleTickMinutes as number) ?? 30),
    systemPrompt: (config.systemPrompt as string) ?? '',
  };

  const advisor = new AdvisorImpl(ctx, cfg);
  ctx.provide('advisor', advisor);

  ctx.logger.info(
    `跨会话顾问已启动: model=${cfg.model || '默认 LLM'}, maxIter=${cfg.maxIterations}, ` +
    `idle=${cfg.idleEnabled ? `每 ${cfg.idleTickMinutes} 分钟` : '关闭'}`,
  );

  // 注册「主智能体可调用的 advisor_query 工具」（独立分组，需在会话/平台
  // 配置中显式启用 advisor-call 才会暴露给主 agent）。
  ctx.registerToolGroup({
    name: 'advisor-call',
    label: '顾问调用',
    description: '允许主智能体调用 advisor 子智能体做跨会话聚合分析。',
  });

  ctx.registerTool({
    groups: ['advisor-call'],
    definition: {
      type: 'function',
      function: {
        name: 'advisor_query',
        description:
          '调用「跨会话顾问」子智能体做跨会话聚合分析。' +
          '仅在确实需要跨多个会话聚合信息（例如「有没有谁今天找过我」「最近哪个群最活跃」' +
          '「我承诺过的事情都跟谁说过」）时调用，普通问题请勿使用。' +
          '返回 JSON 字符串，含 answer / recommendations / shouldAct 字段。',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '具体的跨会话问题。' },
            scope: { type: 'string', description: '可选：限定平台名（如 onebot）。' },
          },
          required: ['question'],
        },
      },
    },
    handler: async (args): Promise<string> => {
      const question = String(args.question ?? '').trim();
      if (!question) return JSON.stringify({ error: 'question required' });
      const result = await advisor.query({
        question,
        platform: typeof args.scope === 'string' ? args.scope : undefined,
        mode: 'analyze',
      });
      return JSON.stringify(result);
    },
  });

  // 平台级 idle tick（启动后才开始）
  let stopTick: (() => void) | null = null;
  ctx.on('app:started', () => {
    stopTick = startIdleTick(ctx, advisor, cfg);
  });
  ctx.on('app:stopping', () => {
    stopTick?.();
    stopTick = null;
  });
}
