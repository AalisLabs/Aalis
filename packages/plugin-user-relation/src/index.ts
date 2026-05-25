/**
 * plugin-user-relation —— 人物关系与事件图
 *
 * 状态三段：
 * - **卸载插件**：服务、提取、注入、工具全部无；不读不写。
 * - **extractionEnabled = false**：服务/查询/注入仍在，只是不再产生新关系（保留历史读取）。
 * - **agentInjection = false**：仍抽取/仍可查询/Agent 工具仍可手动调用，只是不自动注入 system。
 * - **toolsEnabled = false**：不向 Agent 暴露 dig 工具。
 *
 * 触发：自有 Map<sessionId, count> 计数器，达到 triggerEveryNMessages 触发；
 * 读窗口 readWindowSize 设计上大于触发步长，制造层叠重叠让 LLM 跨批次稳定识别同一事件。
 *
 * 多层遍历参数分三场景：
 * - injection.*：middleware 注入用，token 敏感，默认深度浅、宽度窄。
 * - digTool.*：Agent 工具调用用，允许更深；hardMax 防 Agent 一次拉满。
 * - view.*：WebUI / actions 查询用，给人看，可中等深度。
 */
import type { ConfigSchema, Context, PluginModule } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import { useWebuiService, type WebuiPage } from '@aalis/plugin-webui-api';
import { actions as baseActions } from './actions.js';
import { registerRelationCommands } from './commands.js';
import { RelationExtractor } from './extractor.js';
import { registerRelationMiddleware } from './middleware.js';
import { RelationService } from './service.js';
import { RELATION_NAMESPACE, RelationStore } from './store.js';
import { registerRelationTools } from './tools.js';

export const name = '@aalis/plugin-user-relation';
export const displayName = '人物关系图';
export const subsystem = 'memory';
export const provides = ['user-relation'];
export const inject = {
  required: ['memory'],
  optional: ['llm', 'webui-server', 'agent', 'tools'],
};

export const configSchema: ConfigSchema = {
  // ────── 抽取（写入）侧 ──────
  extractionEnabled: {
    type: 'boolean',
    label: '允许从对话中提取新关系（写入总开关）',
    description:
      '**写入总开关**：关闭后插件停止生成任何新关系节点/边（自动触发、手动 /relation extract、Agent upsert_* 工具全部失效）；但 middleware 仍读取并注入旧关系、actions 仍可查/删。若只想停掉"自动触发"而保留手动命令，请用 triggerEveryNMessages=0 而非关此项。彻底卸载请整体停用该插件。',
    default: true,
  },
  triggerEveryNMessages: {
    type: 'number',
    label: '自动触发阈值（每 N 条消息）',
    description:
      '**仅控制"自动触发"**：每会话累计 N 条入站消息后自动跑一次 LLM 提取。0=**仅手动**（slash 命令 /relation extract 仍可触发，Agent 工具仍可用——与 extractionEnabled 不同）。',
    default: 20,
  },
  readWindowSize: {
    type: 'number',
    label: '提取读取窗口大小',
    description:
      '每次提取时回读的最近消息数。建议略大于触发阈值（如阈值 20、窗口 30），让相邻批次窗口重叠 10 条左右、便于 LLM 跨批次稳定识别同一事件与关系',
    default: 30,
  },
  mode: {
    type: 'select',
    label: '提取模式',
    description: 'incremental: 固定窗口；all-new: 一次性读所有累积（注意 context 上限）',
    options: [
      { value: 'incremental', label: '增量窗口（推荐）' },
      { value: 'all-new', label: '全量累积（慎用）' },
    ],
    default: 'incremental',
  },
  allNewMaxMessages: {
    type: 'number',
    label: 'all-new 模式下的最大消息数',
    description: '仅 mode=all-new 时生效；硬上限以防 context 溢出',
    default: 200,
  },
  readScope: {
    type: 'select',
    label: '提取读取范围',
    description:
      '决定每次提取从哪些会话拉取消息送给 LLM：\n- same-session（默认）：只读当前 sessionId（同群/同私聊），证据 100% 在原 session 内；\n- same-platform：把同 platform 下所有会话最近消息合并送 LLM，每行带 [sid:xxx] 前缀，evidence 按真实来源记录；适合识别跨群共享话题；\n- cross-platform：跨所有平台聚合（同上），适合识别跨平台同一用户/同一事件。\n跨会话模式仅在 memory 后端实现 getRecentMessagesAcrossSessions 时生效，否则自动降级到 same-session。',
    options: [
      { value: 'same-session', label: '仅当前会话（默认）' },
      { value: 'same-platform', label: '同平台跨会话' },
      { value: 'cross-platform', label: '全平台跨会话' },
    ],
    default: 'same-session',
  },
  crossSessionMaxAgeMinutes: {
    type: 'number',
    label: '跨会话拉取最大时间窗口（分钟）',
    description: '仅 readScope!=same-session 时生效；只取最近 N 分钟内的消息。0=不限',
    default: 60,
  },
  candidateEventDays: {
    type: 'number',
    label: '候选事件回溯天数',
    description: '提取时把最近 N 天的活跃事件作为候选清单交给 LLM，避免重复创建同名事件',
    default: 7,
  },
  candidateEventLimit: {
    type: 'number',
    label: '候选事件最大数量',
    description: '控制 prompt 体积',
    default: 20,
  },
  senderNeighborhoodEdgeLimit: {
    type: 'number',
    label: '候选人 1 跳邻居展示上限',
    description:
      '提取时，对窗口内每位已知发言人附带其 1 跳邻居子图（已关联的事件/实体/人际关系，按权重降序），上限条数。0 = 关闭',
    default: 8,
  },
  extractionModel: {
    type: 'llm-ref',
    label: '提取使用的 LLM',
    description: '建议挑一个具备 chat 能力的便宜模型；留空则使用默认 llm 服务',
  },
  extractionDisableThinking: {
    type: 'boolean',
    label: '提取：禁用思考模式',
    description:
      '提取是结构化输出任务，思考型模型（如 deepseek-v4-flash）开启思考后可能把 token budget 全花在 reasoning 上、返回空内容。默认禁用',
    default: true,
  },

  // ────── Consolidate（图整理 + 自动别名合并 + 可选 LLM 增强）──────
  consolidationModel: {
    type: 'llm-ref',
    label: 'Consolidate 使用的 LLM',
    description:
      '可选。配置后 /relation.consolidate 与淘汰后自动整理会调用该模型做 (A) 别名候选语义核验、(B) 合并后摘要重写、(C) 实体层级推断。推荐选大上下文模型（如 GPT-4o、Claude Opus），留空则保持纯算法行为。',
  },
  consolidationDisableThinking: {
    type: 'boolean',
    label: 'Consolidate LLM：禁用思考模式',
    description: '同 extractionDisableThinking。默认禁用',
    default: true,
  },
  consolidationAutoLink: {
    type: 'boolean',
    label: 'Consolidate autoLink',
    description:
      '为 true 时自动合并别名实体、建层级边（结合 consolidationModel 可由 LLM 核验）；false 仅打印候选不动数据。',
    default: false,
  },
  consolidationSkipLowScorePairs: {
    type: 'boolean',
    label: 'Consolidate：跳过低权候选 pair',
    description:
      '启用后，宽召回阶段双方 compositeScore 均低于阈值的候选不送 LLM 核验（两端都是 edge tier，合并价值低）。默认启用以节省 LLM 调用。',
    default: true,
  },
  consolidationLowScoreThreshold: {
    type: 'number',
    label: 'Consolidate：低权阈值',
    description:
      'compositeScore 阈值（0~1，与 scoreToTier 的 edge 边界一致，默认 0.2）。设 0 等同关闭跳过；仅在 consolidationSkipLowScorePairs=true 时生效。',
    default: 0.2,
  },
  consolidateAfterEviction: {
    type: 'boolean',
    label: '淘汰后自动 consolidate',
    description:
      '每次发生容量淘汰后自动运行一次 consolidate（去重 / 整理 / 层级推断）。取代旧的定时 consolidate 调度器。',
    default: true,
  },

  // ────── 自动老化（写后顺手扫，profile 风格，不开独立调度器）──────
  evictionEnabled: {
    type: 'boolean',
    label: '启用自动老化',
    description:
      '每次提取完成后扫一遍当前图：先删孤儿节点（无任何边），再按"超出配额"逐项删除"老旧 + 低权重"的事件/实体/边。evidence ≥3 或 weight ≥0.8 的节点受保护不会被删。',
    default: true,
  },
  maxEvents: {
    type: 'number',
    label: '事件总数上限',
    description: '超过则按 (now - lastReinforcedAt) / weight 排序，先删老旧低权重事件。0=不限。',
    default: 500,
  },
  maxEntities: {
    type: 'number',
    label: '实体总数上限',
    description: '同上策略。0=不限。',
    default: 300,
  },
  maxEdges: {
    type: 'number',
    label: '边总数上限',
    description: '超过则保留 weight 最高的边。0=不限。',
    default: 2000,
  },
  pagerankDamping: {
    type: 'number',
    label: 'PageRank 阻尼系数',
    description: '淘汰打分用。常用 0.85。',
    default: 0.85,
  },
  pagerankIterations: {
    type: 'number',
    label: 'PageRank 最大迭代次数',
    description: '20 通常够用；图较大、邻接稠密可调到 30~50。',
    default: 20,
  },
  pagerankEpsilon: {
    type: 'number',
    label: 'PageRank 收敛阈值',
    description: 'L1 误差小于该值即提前停止迭代。',
    default: 0.0001,
  },
  evictHysteresisPct: {
    type: 'number',
    label: '淘汰滞回 (0~1)',
    description: 'count > quota·(1+该值) 才触发淘汰；设为 0.2 时，quota=500 在 600 触发。用以避免"写一条删一条"。',
    default: 0.2,
  },
  evictTargetPct: {
    type: 'number',
    label: '淘汰回落目标 (0~1)',
    description:
      '触发后裁到 floor(quota·该值)；配合 hysteresisPct=0.2 与该值=0.8，单次裁 ~40% quota（quota=500 → 一次裁 ~200 条）。',
    default: 0.8,
  },
  weightDecayHalfLifeDays: {
    type: 'number',
    label: 'Weight 时间衰减半衰期（天）',
    description:
      '淘汰/排序时把 weight 按半衰期折算：effW = raw × max(0.5^(天数/halfLife), floor)。让长期不被强化的"老高 weight"自动让出保护名额。0 = 关闭衰减。',
    default: 180,
  },
  weightDecayFloor: {
    type: 'number',
    label: 'Weight 衰减下限因子 (0~1)',
    description: 'effW 不会低于 raw × 该值。保留"老朋友"底色，避免完全失忆。默认 0.3。',
    default: 0.3,
  },
  // ────── Middleware 注入侧 ──────
  agentInjection: {
    type: 'boolean',
    label: '向 agent 注入关系上下文',
    description: '在 agent:llm:before 时把当前用户的子图速览注入 system prompt',
    default: true,
  },
  injectionMaxDepth: {
    type: 'number',
    label: '注入：BFS 最大深度',
    description: '0=仅起点；1=直接邻居；2=同事件其他参与者 / 朋友的朋友。token 敏感，默认 2',
    default: 2,
  },
  injectionMaxBreadth: {
    type: 'number',
    label: '注入：单节点展开邻居上限',
    description: '按 weight 降序展开。默认 10',
    default: 10,
  },
  maxInjectedEvents: {
    type: 'number',
    label: '注入：事件条数上限',
    default: 5,
  },
  maxInjectedRelations: {
    type: 'number',
    label: '注入：人际关系条数上限',
    default: 8,
  },
  maxParticipantsPerEvent: {
    type: 'number',
    label: '注入：每事件展示参与者数',
    description: '超出会显示 +N 人。默认 5',
    default: 5,
  },
  maxCooccurrencePartners: {
    type: 'number',
    label: '注入：共现伙伴展示数',
    description: '基于事件桥统计的隐式二跳；0 关闭该小节',
    default: 5,
  },
  maxGlobalHotEvents: {
    type: 'number',
    label: '注入：全局热点事件数',
    description: '与当前用户子图无关，按全局 lastMentionedAt 排序的最近事件；0 关闭',
    default: 5,
  },
  maxGlobalHotEntities: {
    type: 'number',
    label: '注入：全局热点实体数',
    description: '与当前用户子图无关，按全局 lastMentionedAt 排序的最近实体；0 关闭',
    default: 5,
  },
  groupOnly: {
    type: 'boolean',
    label: '仅在群聊中注入',
    description: '私聊一般无需关系图上下文',
    default: false,
  },

  // ────── Agent 工具侧 ──────
  toolsEnabled: {
    type: 'boolean',
    label: '向 Agent 暴露 dig 工具',
    description: '允许 LLM 主动调用：expand_person / find_path / search_events / upsert_* / link / unlink',
    default: true,
  },
  commandsEnabled: {
    type: 'boolean',
    label: '注册 /relation 指令',
    description: '注册 show / orphans / cleanup 系列指令（cleanup 需 authority ≥ 3）',
    default: true,
  },
  strictSelfAssertion: {
    type: 'boolean',
    label: '严格自证模式',
    description:
      '开启后，提取/工具只允许把关系归到「说过那条原话的人」名下：每条人-* 边必须有 evidence，且至少一条 evidence.messageId 对应消息的发言者 == fromPersonId；agent 工具调用 link/upsert_person 时 from 必须 == 当前发言者。person-person 边的 to 必须已存在 PersonNode。',
    default: true,
  },
  digToolDefaultMaxDepth: {
    type: 'number',
    label: 'dig 工具：默认深度',
    default: 2,
  },
  digToolDefaultMaxBreadth: {
    type: 'number',
    label: 'dig 工具：默认宽度',
    default: 8,
  },
  digToolHardMaxDepth: {
    type: 'number',
    label: 'dig 工具：硬上限深度',
    description: 'Agent 传入更大值会被截断',
    default: 4,
  },
  digToolHardMaxBreadth: {
    type: 'number',
    label: 'dig 工具：硬上限宽度',
    default: 20,
  },
  findPathDefaultMaxDepth: {
    type: 'number',
    label: 'find_path 默认深度',
    default: 4,
  },
  findPathHardMaxDepth: {
    type: 'number',
    label: 'find_path 硬上限',
    default: 6,
  },
  searchEventsDefaultLimit: {
    type: 'number',
    label: 'search_events 默认 limit',
    default: 10,
  },
  searchEventsHardMaxLimit: {
    type: 'number',
    label: 'search_events 硬上限 limit',
    default: 50,
  },

  // ────── 通用 ──────
  debug: {
    type: 'boolean',
    label: 'Debug 日志',
    description: '开启后会输出提取/注入/工具调用的详细日志',
    default: false,
  },
};

const webuiPages: WebuiPage[] = [
  {
    key: 'user-relation',
    label: '人物关系图',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="6" y1="9" x2="12" y2="15"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="6" y1="6" x2="18" y2="6"/></svg>',
    order: 58,
    content: [
      {
        type: 'stat',
        label: '关系图规模',
        source: 'getStats',
        icon: 'memory',
      },
      {
        type: 'graph',
        label: '关系图（点击节点查看详情；可设置焦点重做子图）',
        source: 'getRelationGraph',
        detailSource: 'getGraphNodeDetail',
        defaultMaxDepth: 2,
        defaultMaxBreadth: 10,
        refresh: 0,
      },
    ],
  },
  {
    key: 'user-relation-raw',
    label: '关系图·原始数据',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/></svg>',
    order: 59,
    content: [
      {
        type: 'tabs',
        label: '原始数据（与关系图共用同一份存储）',
        items: [
          {
            key: 'persons',
            label: '人物列表',
            content: [
              {
                type: 'table',
                source: 'listPersons',
                searchable: true,
                columns: [
                  { key: 'id', label: 'ID', nowrap: true },
                  { key: 'platform', label: '平台', nowrap: true },
                  { key: 'userId', label: '用户 ID', nowrap: true },
                  { key: 'displayName', label: '显示名', nowrap: true },
                  { key: 'firstSeenAt', label: '首次出现', nowrap: true },
                  { key: 'lastSeenAt', label: '最近活跃', nowrap: true },
                ],
                actions: [
                  { label: '删除', method: 'deletePerson', confirm: '确认删除该人物及其所有相关边？', danger: true },
                ],
                refresh: 60,
              },
            ],
          },
          {
            key: 'events',
            label: '事件列表',
            content: [
              {
                type: 'table',
                source: 'listEvents',
                searchable: true,
                columns: [
                  { key: 'title', label: '标题', minWidth: 160 },
                  { key: 'category', label: '类别', nowrap: true },
                  { key: 'sessionScope', label: '会话', nowrap: true },
                  { key: 'summary', label: '摘要', minWidth: 200, maxWidth: 360, render: 'expandable-text' },
                  { key: 'preview', label: '最新证据', minWidth: 160, render: 'expandable-text' },
                  { key: 'evidenceCount', label: '证据数', nowrap: true },
                  { key: 'lastReinforcedAt', label: '最近强化', nowrap: true },
                ],
                actions: [
                  { label: '删除', method: 'deleteEvent', confirm: '确认删除该事件及其所有相关边？', danger: true },
                ],
                refresh: 60,
              },
            ],
          },
          {
            key: 'entities',
            label: '实体列表',
            content: [
              {
                type: 'table',
                source: 'listEntities',
                searchable: true,
                columns: [
                  { key: 'name', label: '名称', minWidth: 140 },
                  { key: 'entityKind', label: '类型', nowrap: true },
                  { key: 'aliases', label: '别名', minWidth: 140, render: 'expandable-text' },
                  { key: 'summary', label: '摘要', minWidth: 200, maxWidth: 360, render: 'expandable-text' },
                  { key: 'evidenceCount', label: '证据数', nowrap: true },
                  { key: 'lastReinforcedAt', label: '最近强化', nowrap: true },
                ],
                actions: [
                  { label: '删除', method: 'deleteEntity', confirm: '确认删除该实体及其所有相关边？', danger: true },
                ],
                refresh: 60,
              },
            ],
          },
        ],
      },
    ],
  },
];

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const memory = ctx.getService<MemoryService>('memory');
  if (!memory) {
    throw new Error('[plugin-user-relation] memory 服务不可用，无法初始化关系图存储');
  }

  const store = new RelationStore(memory);
  const service = new RelationService(store, ctx);
  ctx.provide('user-relation', service);

  const debug = config.debug === true;

  // ─── 提取（写入）─── 受 extractionEnabled 控制
  // 注意：triggerEveryN=0 时不再绕过 extractor 构造，仅 disable 自动触发；
  // 这样 slash 命令 /relation extract 与 Agent 工具仍能调用。
  const extractionEnabled = config.extractionEnabled !== false;
  const triggerEveryN = numCfg(config.triggerEveryNMessages, 20);
  if (extractionEnabled) {
    const extractor = new RelationExtractor(ctx, service, {
      triggerEveryNMessages: triggerEveryN,
      readWindowSize: numCfg(config.readWindowSize, 30),
      mode: config.mode === 'all-new' ? 'all-new' : 'incremental',
      allNewMaxMessages: numCfg(config.allNewMaxMessages, 200),
      readScope:
        config.readScope === 'cross-platform'
          ? 'cross-platform'
          : config.readScope === 'same-platform'
            ? 'same-platform'
            : 'same-session',
      crossSessionMaxAgeMinutes: numCfg(config.crossSessionMaxAgeMinutes, 60),
      candidateEventDays: numCfg(config.candidateEventDays, 7),
      candidateEventLimit: numCfg(config.candidateEventLimit, 20),
      senderNeighborhoodEdgeLimit: numCfg(config.senderNeighborhoodEdgeLimit, 8),
      extractionModel: config.extractionModel as { provider: string; model: string } | undefined,
      disableThinking: config.extractionDisableThinking !== false,
      strictSelfAssertion: config.strictSelfAssertion !== false,
      evictionEnabled: config.evictionEnabled !== false,
      maxEvents: numCfg(config.maxEvents, 500),
      maxEntities: numCfg(config.maxEntities, 300),
      maxEdges: numCfg(config.maxEdges, 2000),
      pagerankDamping: numCfg(config.pagerankDamping, 0.85),
      pagerankIterations: numCfg(config.pagerankIterations, 20),
      pagerankEpsilon: numCfg(config.pagerankEpsilon, 0.0001),
      evictHysteresisPct: numCfg(config.evictHysteresisPct, 0.2),
      evictTargetPct: numCfg(config.evictTargetPct, 0.8),
      weightDecayHalfLifeDays: numCfg(config.weightDecayHalfLifeDays, 180),
      weightDecayFloor: numCfg(config.weightDecayFloor, 0.3),
      consolidateAfterEviction: config.consolidateAfterEviction !== false,
      consolidateLLMModelRef: config.consolidationModel as { provider: string; model: string } | undefined,
      consolidateLLMDisableThinking: config.consolidationDisableThinking !== false,
      consolidateAutoLink: config.consolidationAutoLink === true,
      consolidateSkipLowScorePairs: config.consolidationSkipLowScorePairs !== false,
      consolidateLowScoreThreshold: numCfg(config.consolidationLowScoreThreshold, 0.2),
      debug,
    });
    extractor.start();
    service.setTriggerExtractionHandler(sessionId => extractor.triggerNow(sessionId));
  }

  // ─── Middleware 注入（读取）─── 受 agentInjection 控制
  if (config.agentInjection !== false) {
    registerRelationMiddleware(ctx, service, {
      enabled: true,
      maxDepth: numCfg(config.injectionMaxDepth, 2),
      maxBreadth: numCfg(config.injectionMaxBreadth, 10),
      maxEvents: numCfg(config.maxInjectedEvents, 5),
      maxRelations: numCfg(config.maxInjectedRelations, 8),
      maxParticipantsPerEvent: numCfg(config.maxParticipantsPerEvent, 5),
      maxCooccurrencePartners: numCfg(config.maxCooccurrencePartners, 5),
      maxGlobalHotEvents: numCfg(config.maxGlobalHotEvents, 5),
      maxGlobalHotEntities: numCfg(config.maxGlobalHotEntities, 5),
      groupOnly: config.groupOnly === true,
      debug,
    });
  }

  // ─── Agent 工具 ─── 受 toolsEnabled 控制
  if (config.toolsEnabled !== false) {
    registerRelationTools(ctx, service, {
      enabled: true,
      group: 'user-relation',
      defaultMaxDepth: numCfg(config.digToolDefaultMaxDepth, 2),
      defaultMaxBreadth: numCfg(config.digToolDefaultMaxBreadth, 8),
      hardMaxDepth: numCfg(config.digToolHardMaxDepth, 4),
      hardMaxBreadth: numCfg(config.digToolHardMaxBreadth, 20),
      findPathDefaultMaxDepth: numCfg(config.findPathDefaultMaxDepth, 4),
      findPathHardMaxDepth: numCfg(config.findPathHardMaxDepth, 6),
      searchEventsDefaultLimit: numCfg(config.searchEventsDefaultLimit, 10),
      searchEventsHardMaxLimit: numCfg(config.searchEventsHardMaxLimit, 50),
      debug,
    });
  }

  // WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  // /relation 指令
  if (config.commandsEnabled !== false) {
    const consolidateModel = config.consolidationModel as { provider: string; model: string } | undefined;
    registerRelationCommands(ctx, service, {
      ...(consolidateModel
        ? {
            consolidateLLM: {
              modelRef: consolidateModel,
              disableThinking: config.consolidationDisableThinking !== false,
            },
          }
        : {}),
      eviction: {
        maxEvents: numCfg(config.maxEvents, 500),
        maxEntities: numCfg(config.maxEntities, 300),
        maxEdges: numCfg(config.maxEdges, 2000),
        pagerankDamping: numCfg(config.pagerankDamping, 0.85),
        pagerankIterations: numCfg(config.pagerankIterations, 20),
        pagerankEpsilon: numCfg(config.pagerankEpsilon, 0.0001),
        hysteresisPct: numCfg(config.evictHysteresisPct, 0.2),
        targetPct: numCfg(config.evictTargetPct, 0.8),
        weightDecayHalfLifeDays: numCfg(config.weightDecayHalfLifeDays, 180),
        weightDecayFloor: numCfg(config.weightDecayFloor, 0.3),
      },
      consolidateAutoLink: config.consolidationAutoLink === true,
      consolidateSkipLowScorePairs: config.consolidationSkipLowScorePairs !== false,
      consolidateLowScoreThreshold: numCfg(config.consolidationLowScoreThreshold, 0.2),
    });
  }

  // ─── 参与统一的 memory:clear（与 plugin-user-profile 对称） ───
  // scope='all'：清空整个关系图；scope='session'：跨会话存储，不动。
  // types 过滤：未指定 / 包含 'user-relation' 时执行。
  ctx.middleware(
    'memory:clear',
    async (
      data: {
        scope: 'session' | 'all';
        types?: string[];
        sessionId?: string;
        results: Array<{ source: string; success: boolean; message: string }>;
      },
      next,
    ) => {
      if (data.types && !data.types.includes('user-relation')) {
        await next();
        return;
      }
      if (data.scope !== 'all') {
        await next();
        return;
      }
      if (!memory.listMetadata || !memory.deleteMetadata) {
        await next();
        return;
      }
      try {
        const items = await memory.listMetadata(RELATION_NAMESPACE);
        for (const it of items) await memory.deleteMetadata(RELATION_NAMESPACE, it.key);
        ctx.logger.info(`[user-relation] 关系图已清空 (${items.length} 条)`);
        data.results.push({
          source: 'user-relation',
          success: true,
          message: `关系图已清空 (${items.length} 条)`,
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`[user-relation] 清空失败: ${m}`);
        data.results.push({ source: 'user-relation', success: false, message: `关系图清空失败: ${m}` });
      }
      await next();
    },
  );
}

function numCfg(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

export const actions: PluginModule['actions'] = baseActions;

export { RelationService } from './service.js';
export { RelationStore } from './store.js';
export * from './types.js';
