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
 * 多层遍历参数分两场景：
 * - injection.*：middleware 注入用，token 敏感，默认深度浅、宽度窄。
 * - digTool.*：Agent 工具调用用，允许更深；hardMax 防 Agent 一次拉满。
 */

import { commands } from '@aalis/api-commands';
import { contributions } from '@aalis/api-contributions';
import { embedding } from '@aalis/api-embedding';
import { hooks } from '@aalis/api-hooks';
import { ownHostConfig } from '@aalis/api-host-config';
import { i18n } from '@aalis/api-i18n';
import { llm } from '@aalis/api-llm';
import { memory } from '@aalis/api-memory';
import { persona } from '@aalis/api-persona';
import { platform } from '@aalis/api-platform';
import { originChatOf, sessionManager } from '@aalis/api-session-manager';
import { sessionFields } from '@aalis/api-session-settings';
import { tools } from '@aalis/api-tools';
import { userRelation } from '@aalis/api-user-relation';
import { webuiServer } from '@aalis/api-webui';
import { type BoundOf, config, definePlugin, events, logger, optional, provide } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';
import { textOf } from '@aalis/schema-i18n';
import { type EvictionConfig, registerRelationCommands } from './commands.js';
import { RelationExtractor } from './extractor.js';
import { registerRelationContribution } from './middleware.js';
import { startRenameWatcher } from './rename-watcher.js';
import { RelationService } from './service.js';
import { RelationStore } from './store.js';
import { t } from './texts.js';
import { registerRelationTools } from './tools.js';
import { registerRelationPages } from './webui.js';

const configSchema = defineConfig({
  // ────── 抽取（写入）侧 ──────
  extractionEnabled: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('extractionEnabledLabel'),
    description: t('extractionEnabledDescription'),
    default: true,
  },
  triggerEveryNMessages: {
    type: 'number',
    label: t('triggerLabel'),
    description: t('triggerDescription'),
    default: 20,
  },
  readWindowSize: {
    type: 'number',
    label: t('readWindowLabel'),
    description: t('readWindowDescription'),
    default: 30,
  },
  mode: {
    type: 'select',
    label: t('modeLabel'),
    description: t('modeDescription'),
    options: [
      { value: 'incremental', label: t('modeIncremental') },
      { value: 'all-new', label: t('modeAllNew') },
    ],
    default: 'incremental',
  },
  allNewMaxMessages: {
    type: 'number',
    label: t('allNewMaxLabel'),
    description: t('allNewMaxDescription'),
    default: 200,
  },
  readScope: {
    type: 'select',
    label: t('readScopeLabel'),
    description: t('readScopeDescription'),
    options: [
      { value: 'same-session', label: t('readScopeSession') },
      { value: 'same-platform', label: t('readScopePlatform') },
      { value: 'cross-platform', label: t('readScopeAll') },
    ],
    default: 'same-session',
  },
  crossSessionMaxAgeMinutes: {
    type: 'number',
    label: t('crossMaxAgeLabel'),
    description: t('crossMaxAgeDescription'),
    default: 60,
  },
  candidateEventDays: {
    type: 'number',
    label: t('candidateDaysLabel'),
    description: t('candidateDaysDescription'),
    default: 7,
  },
  candidateEventLimit: {
    type: 'number',
    label: t('candidateLimitLabel'),
    description: t('candidateLimitDescription'),
    default: 20,
  },
  senderNeighborhoodEdgeLimit: {
    type: 'number',
    label: t('neighborLimitLabel'),
    description: t('neighborLimitDescription'),
    default: 8,
  },
  extractionModel: {
    type: 'llm-ref',
    label: t('extractionModelLabel'),
    description: t('extractionModelDescription'),
  },
  extractionDisableThinking: {
    type: 'boolean',
    label: t('extractionThinkingLabel'),
    description: t('extractionThinkingDescription'),
    default: true,
  },

  // ────── Consolidate（图整理 + 自动别名合并 + 可选 LLM 增强）──────
  consolidationModel: {
    type: 'llm-ref',
    label: t('consolidationModelLabel'),
    description: t('consolidationModelDescription'),
  },
  consolidationDisableThinking: {
    type: 'boolean',
    label: t('consolidationThinkingLabel'),
    description: t('consolidationThinkingDescription'),
    default: true,
  },
  consolidationAutoLink: {
    type: 'boolean',
    onInvalid: 'error',
    label: 'Consolidate autoLink',
    description: t('autoLinkDescription'),
    default: false,
  },
  consolidationSkipLowScorePairs: {
    type: 'boolean',
    label: t('skipLowLabel'),
    description: t('skipLowDescription'),
    default: true,
  },
  consolidationLowScoreThreshold: {
    type: 'number',
    label: t('lowThresholdLabel'),
    description: t('lowThresholdDescription'),
    default: 0.2,
  },
  consolidateAfterEviction: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('consolidateAfterEvictionLabel'),
    description: t('consolidateAfterEvictionDescription'),
    default: true,
  },

  // ────── 自动老化（写后顺手扫，profile 风格，不开独立调度器）──────
  evictionEnabled: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('evictionLabel'),
    description: t('evictionDescription'),
    default: true,
  },
  maxPersons: {
    type: 'number',
    label: t('maxPersonsLabel'),
    description: t('maxPersonsDescription'),
    default: 1500,
  },
  maxEvents: {
    type: 'number',
    label: t('maxEventsLabel'),
    description: t('maxEventsDescription'),
    default: 2500,
  },
  maxEntities: {
    type: 'number',
    label: t('maxEntitiesLabel'),
    description: t('maxEntitiesDescription'),
    default: 1500,
  },
  maxEdges: {
    type: 'number',
    label: t('maxEdgesLabel'),
    description: t('maxEdgesDescription'),
    default: 10000,
  },
  pagerankDamping: {
    type: 'number',
    label: t('dampingLabel'),
    description: t('dampingDescription'),
    default: 0.85,
  },
  pagerankIterations: {
    type: 'number',
    label: t('iterationsLabel'),
    description: t('iterationsDescription'),
    default: 20,
  },
  pagerankEpsilon: {
    type: 'number',
    label: t('epsilonLabel'),
    description: t('epsilonDescription'),
    default: 0.0001,
  },
  communityAlgorithm: {
    type: 'select',
    label: t('communityLabel'),
    description: t('communityDescription'),
    options: [
      { value: 'louvain', label: t('communityLouvain') },
      { value: 'leiden', label: t('communityLeiden') },
      { value: 'slpa', label: t('communitySlpa') },
    ],
    default: 'louvain',
  },
  evictHysteresisPct: {
    type: 'number',
    label: t('hysteresisLabel'),
    description: t('hysteresisDescription'),
    default: 0.2,
  },
  evictTargetPct: {
    type: 'number',
    label: t('targetLabel'),
    description: t('targetDescription'),
    default: 0.8,
  },
  weightDecayHalfLifeDays: {
    type: 'number',
    label: t('halfLifeLabel'),
    description: t('halfLifeDescription'),
    default: 180,
  },
  weightDecayFloor: {
    type: 'number',
    label: t('floorLabel'),
    description: t('floorDescription'),
    default: 0.3,
  },
  // ────── Middleware 注入侧 ──────
  agentInjection: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('injectionLabel'),
    description: t('injectionDescription'),
    default: true,
  },
  injectionMaxDepth: {
    type: 'number',
    label: t('injectionDepthLabel'),
    description: t('injectionDepthDescription'),
    default: 2,
  },
  injectionMaxBreadth: {
    type: 'number',
    label: t('injectionBreadthLabel'),
    description: t('injectionBreadthDescription'),
    default: 10,
  },
  maxInjectedEvents: {
    type: 'number',
    label: t('maxInjectedEventsLabel'),
    default: 5,
  },
  maxInjectedRelations: {
    type: 'number',
    label: t('maxInjectedRelationsLabel'),
    default: 8,
  },
  maxParticipantsPerEvent: {
    type: 'number',
    label: t('maxParticipantsLabel'),
    description: t('maxParticipantsDescription'),
    default: 5,
  },
  maxCooccurrencePartners: {
    type: 'number',
    label: t('maxCooccurrenceLabel'),
    description: t('maxCooccurrenceDescription'),
    default: 5,
  },
  maxGlobalHotEvents: {
    type: 'number',
    label: t('hotEventsLabel'),
    description: t('hotEventsDescription'),
    default: 5,
  },
  maxGlobalHotEntities: {
    type: 'number',
    label: t('hotEntitiesLabel'),
    description: t('hotEntitiesDescription'),
    default: 5,
  },
  groupOnly: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('groupOnlyLabel'),
    description: t('groupOnlyDescription'),
    default: false,
  },
  // 按会话字段：坏值原样交来，按仅本会话处理
  recallScope: {
    type: 'select',
    label: t('recallScopeLabel'),
    description: t('recallScopeDescription'),
    default: 'all',
    onInvalid: 'error',
    options: [
      { label: t('recallScopeSession'), value: 'session' },
      { label: t('recallScopeAll'), value: 'all' },
    ],
    session: { prominence: 'advanced' },
  },

  // ────── Agent 工具侧 ──────
  toolsEnabled: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('toolsLabel'),
    description: t('toolsDescription'),
    default: true,
  },
  commandsEnabled: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('commandsLabel'),
    description: t('commandsDescription'),
    default: true,
  },
  strictSelfAssertion: {
    type: 'boolean',
    onInvalid: 'error',
    label: t('strictLabel'),
    description: t('strictDescription'),
    default: true,
  },
  digToolDefaultMaxDepth: {
    type: 'number',
    label: t('digDepthLabel'),
    default: 2,
  },
  digToolDefaultMaxBreadth: {
    type: 'number',
    label: t('digBreadthLabel'),
    default: 8,
  },
  digToolHardMaxDepth: {
    type: 'number',
    label: t('digHardDepthLabel'),
    description: t('digHardDepthDescription'),
    default: 4,
  },
  digToolHardMaxBreadth: {
    type: 'number',
    label: t('digHardBreadthLabel'),
    default: 20,
  },
  findPathDefaultMaxDepth: {
    type: 'number',
    label: t('findPathDepthLabel'),
    default: 4,
  },
  findPathHardMaxDepth: {
    type: 'number',
    label: t('findPathHardLabel'),
    default: 6,
  },
  searchEventsDefaultLimit: {
    type: 'number',
    label: t('searchLimitLabel'),
    default: 10,
  },
  searchEventsHardMaxLimit: {
    type: 'number',
    label: t('searchHardLabel'),
    default: 50,
  },

  // ────── 关系图页 ──────
  graphSpacing: {
    type: 'number',
    label: t('spacingLabel'),
    default: 120,
    min: 20,
    max: 1000,
    description: t('spacingDescription'),
  },

  // ────── 通用 ──────
  debug: {
    type: 'boolean',
    label: t('debugLabel'),
    description: t('debugDescription'),
    default: false,
  },
});

function start(caps: Caps): void {
  const cfg = parseConfig(configSchema, caps.config.use, caps.logger.use);
  const store = new RelationStore(caps.memory.use);
  const service = new RelationService(store, caps.logger.use, caps.embedding);

  caps.provide.use(userRelation, service);

  // 平台 displayName 同步：与 extractionEnabled 解耦，即便关掉写入提取，
  // 改名也应反映到已存在的 Person 节点（仅同步，不创建新节点）。
  startRenameWatcher({ events: caps.events.use, logger: caps.logger.use }, service);

  const debug = cfg.debug;

  // 容量淘汰配置只解析一次，extractor 的自动淘汰与 /relation 指令共用
  const eviction: EvictionConfig = {
    maxPersons: cfg.maxPersons,
    maxEvents: cfg.maxEvents,
    maxEntities: cfg.maxEntities,
    maxEdges: cfg.maxEdges,
    pagerankDamping: cfg.pagerankDamping,
    pagerankIterations: cfg.pagerankIterations,
    pagerankEpsilon: cfg.pagerankEpsilon,
    hysteresisPct: cfg.evictHysteresisPct,
    targetPct: cfg.evictTargetPct,
    weightDecayHalfLifeDays: cfg.weightDecayHalfLifeDays,
    weightDecayFloor: cfg.weightDecayFloor,
    communityAlgorithm: cfg.communityAlgorithm,
  };

  // ─── 提取（写入）─── 受 extractionEnabled 控制；triggerEveryNMessages ≤ 0 即关闭自动提取，不挂监听
  const extractionEnabled = cfg.extractionEnabled;
  const triggerEveryN = cfg.triggerEveryNMessages;
  if (extractionEnabled && triggerEveryN > 0) {
    const extractor = new RelationExtractor(
      { events: caps.events, logger: caps.logger, memory: caps.memory, llm: caps.llm, persona: caps.persona },
      service,
      {
        triggerEveryNMessages: triggerEveryN,
        readWindowSize: cfg.readWindowSize,
        mode: cfg.mode,
        allNewMaxMessages: cfg.allNewMaxMessages,
        readScope: cfg.readScope,
        crossSessionMaxAgeMinutes: cfg.crossSessionMaxAgeMinutes,
        candidateEventDays: cfg.candidateEventDays,
        candidateEventLimit: cfg.candidateEventLimit,
        senderNeighborhoodEdgeLimit: cfg.senderNeighborhoodEdgeLimit,
        // 两项不齐按没填处理，与其余模型字段一致
        extractionModel:
          cfg.extractionModel?.provider && cfg.extractionModel.model
            ? { provider: cfg.extractionModel.provider, model: cfg.extractionModel.model }
            : undefined,
        disableThinking: cfg.extractionDisableThinking,
        strictSelfAssertion: cfg.strictSelfAssertion,
        evictionEnabled: cfg.evictionEnabled,
        maxPersons: eviction.maxPersons,
        maxEvents: eviction.maxEvents,
        maxEntities: eviction.maxEntities,
        maxEdges: eviction.maxEdges,
        pagerankDamping: eviction.pagerankDamping,
        pagerankIterations: eviction.pagerankIterations,
        pagerankEpsilon: eviction.pagerankEpsilon,
        evictHysteresisPct: eviction.hysteresisPct,
        evictTargetPct: eviction.targetPct,
        weightDecayHalfLifeDays: eviction.weightDecayHalfLifeDays,
        weightDecayFloor: eviction.weightDecayFloor,
        communityAlgorithm: eviction.communityAlgorithm,
        consolidateAfterEviction: cfg.consolidateAfterEviction,
        consolidateLLMModelRef: cfg.consolidationModel,
        consolidateLLMDisableThinking: cfg.consolidationDisableThinking,
        consolidateAutoLink: cfg.consolidationAutoLink,
        consolidateSkipLowScorePairs: cfg.consolidationSkipLowScorePairs,
        consolidateLowScoreThreshold: cfg.consolidationLowScoreThreshold,
        debug,
      },
    );
    extractor.start();
  }

  // ─── 注入与工具 ─── 各受 agentInjection、toolsEnabled 控制；两者都关着时不登记关系图范围
  if (cfg.agentInjection || cfg.toolsEnabled) {
    // 关系图范围：注入与工具的会话作用域都不超过它。每次现读，改了下一轮即生效；不是「全部」的（含写坏了的）一律按仅本会话
    const fields = caps.sessionFields.use.fields(configSchema, caps);
    const sessionOnly = (sessionId: string | undefined, platform: string | undefined) =>
      fields.get(sessionId, { platform }).recallScope !== 'all';

    if (cfg.agentInjection) {
      // 仅群聊按会话记下的多方标记判（子会话取根会话的）；会话管理不在、会话不在表里或没有聊天窗口时判不出，按否
      const multiParty = (sessionId: string | undefined) =>
        sessionId !== undefined && originChatOf(sessionId, caps.sessionManager)?.multiParty === true;
      registerRelationContribution({ contributions: caps.contributions, sessionOnly, multiParty }, service, {
        maxDepth: cfg.injectionMaxDepth,
        maxBreadth: cfg.injectionMaxBreadth,
        maxEvents: cfg.maxInjectedEvents,
        maxRelations: cfg.maxInjectedRelations,
        maxParticipantsPerEvent: cfg.maxParticipantsPerEvent,
        maxCooccurrencePartners: cfg.maxCooccurrencePartners,
        maxGlobalHotEvents: cfg.maxGlobalHotEvents,
        maxGlobalHotEntities: cfg.maxGlobalHotEntities,
        groupOnly: cfg.groupOnly,
      });
    }

    if (cfg.toolsEnabled) {
      registerRelationTools({ tools: caps.tools.use, logger: caps.logger.use, sessionOnly }, service, {
        defaultMaxDepth: cfg.digToolDefaultMaxDepth,
        defaultMaxBreadth: cfg.digToolDefaultMaxBreadth,
        hardMaxDepth: cfg.digToolHardMaxDepth,
        hardMaxBreadth: cfg.digToolHardMaxBreadth,
        findPathDefaultMaxDepth: cfg.findPathDefaultMaxDepth,
        findPathHardMaxDepth: cfg.findPathHardMaxDepth,
        searchEventsDefaultLimit: cfg.searchEventsDefaultLimit,
        searchEventsHardMaxLimit: cfg.searchEventsHardMaxLimit,
        communityAlgorithm: eviction.communityAlgorithm,
        debug,
      });
    }
  }

  // 关系图页与原始数据页
  registerRelationPages(caps.webui.use, service, caps.logger.use, cfg.graphSpacing);

  // /relation 指令
  if (cfg.commandsEnabled) {
    const ref = cfg.consolidationModel;
    const consolidateModel = ref?.provider && ref.model ? { provider: ref.provider, model: ref.model } : undefined;
    registerRelationCommands(
      { commands: caps.commands.use, platform: caps.platform, llm: caps.llm, i18n: caps.i18n, logger: caps.logger.use },
      service,
      {
        ...(consolidateModel
          ? {
              consolidateLLM: {
                modelRef: consolidateModel,
                disableThinking: cfg.consolidationDisableThinking,
              },
            }
          : {}),
        eviction,
        consolidateAutoLink: cfg.consolidationAutoLink,
        consolidateSkipLowScorePairs: cfg.consolidationSkipLowScorePairs,
        consolidateLowScoreThreshold: cfg.consolidationLowScoreThreshold,
      },
    );
  }

  // ─── 参与统一的 memory:clear（与 plugin-user-profile 对称） ───
  // scope='all'：清空整个关系图；scope='session'：跨会话存储，不动，显式选了 user-relation 时回一行未清理。
  // types 过滤：未指定 / 包含 'user-relation' 时执行。
  caps.contributions.use.contribute('memory:clear-type', { id: 'user-relation', label: t('clearType') });
  caps.hooks.use.middleware('memory:clear', async (data, next) => {
    if (data.types && !data.types.includes('user-relation')) {
      await next();
      return;
    }
    if (data.scope !== 'all') {
      if (data.types)
        data.results.push({
          source: 'user-relation',
          type: 'user-relation',
          success: false,
          message: t('clearSkipped'),
        });
      await next();
      return;
    }
    try {
      // 经 store 而非直接拿 memory 删：clearAll 走 commitMetadata 一次批量提交
      // （原子性按后端分档，见 store.clearAll），
      // 逐条删会在中途失败时留下半张图。
      const cleared = await store.clearAll(caps.logger.use);
      caps.logger.use.info(`[user-relation] 关系图已清空 (${cleared} 条)`);
      data.results.push({
        source: 'user-relation',
        type: 'user-relation',
        success: true,
        message: t('clearDone', { count: cleared }),
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      caps.logger.use.warn(`[user-relation] 清空失败: ${m}`);
      data.results.push({
        source: 'user-relation',
        type: 'user-relation',
        success: false,
        message: t('clearFailed', { error: textOf(err) }),
      });
    }
    await next();
  });
}

export { RelationService } from './service.js';
export { RelationStore } from './store.js';
export * from './types.js';

const uses = {
  memory,
  logger,
  config,
  events,
  hooks,
  contributions,
  provide,
  llm: optional(llm),
  /** 提取提示里机器人的称呼取人设名；缺席时用中性称呼 */
  persona: optional(persona),
  platform: optional(platform),
  tools: optional(tools),
  commands: optional(commands),
  webui: optional(webuiServer),
  embedding: optional(embedding),
  /** 「仅在群聊中注入」按会话记下的多方标记判；缺席时判不出，不注入 */
  sessionManager: optional(sessionManager),
  /** 按会话读关系图范围；缺席时取插件配置里的值 */
  sessionFields: optional(sessionFields),
  /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
  document: optional(ownHostConfig),
  /** /relation 长任务的立即回执按会话的语言渲染；缺席时按原文 */
  i18n: optional(i18n),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-user-relation',
  displayName: t('displayName'),
  subsystem: 'memory',
  configSchema,
  provides: [userRelation],
  uses,
  apply: start,
});
