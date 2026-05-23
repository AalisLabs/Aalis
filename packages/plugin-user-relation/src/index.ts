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
import { RelationStore } from './store.js';
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
    label: '允许从对话中提取新关系',
    description:
      '关闭后停止生成新关系，但 middleware 仍读取并注入旧关系、actions 仍可查/删。若希望彻底关闭，请整体停用该插件。',
    default: true,
  },
  triggerEveryNMessages: {
    type: 'number',
    label: '提取触发阈值（每 N 条消息）',
    description: '每会话累计 N 条入站消息后触发一次 LLM 关系提取；0 关闭自动触发（仍可手动触发）',
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
    description: '0=仅起点；1=直接邻居；2=同事件其他参与者 / 朋友的朋友。token 敏感，默认 1',
    default: 1,
  },
  injectionMaxBreadth: {
    type: 'number',
    label: '注入：单节点展开邻居上限',
    description: '按 weight 降序展开。默认 5',
    default: 5,
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
      {
        type: 'tabs',
        label: '原始数据',
        items: [
          {
            key: 'persons',
            label: '人物列表',
            content: [
              {
                type: 'table',
                source: 'listPersons',
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
                columns: [
                  { key: 'title', label: '标题', minWidth: 160 },
                  { key: 'category', label: '类别', nowrap: true },
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
  const service = new RelationService(store);
  ctx.provide('user-relation', service);

  const debug = config.debug === true;

  // ─── 提取（写入）─── 受 extractionEnabled 控制
  const extractionEnabled = config.extractionEnabled !== false;
  const triggerEveryN = numCfg(config.triggerEveryNMessages, 20);
  if (extractionEnabled && triggerEveryN > 0) {
    const extractor = new RelationExtractor(ctx, service, {
      triggerEveryNMessages: triggerEveryN,
      readWindowSize: numCfg(config.readWindowSize, 30),
      mode: config.mode === 'all-new' ? 'all-new' : 'incremental',
      allNewMaxMessages: numCfg(config.allNewMaxMessages, 200),
      candidateEventDays: numCfg(config.candidateEventDays, 7),
      candidateEventLimit: numCfg(config.candidateEventLimit, 20),
      senderNeighborhoodEdgeLimit: numCfg(config.senderNeighborhoodEdgeLimit, 8),
      extractionModel: config.extractionModel as { provider: string; model: string } | undefined,
      disableThinking: config.extractionDisableThinking !== false,
      strictSelfAssertion: config.strictSelfAssertion !== false,
      debug,
    });
    extractor.start();
    service.setTriggerExtractionHandler(sessionId => extractor.triggerNow(sessionId));
  }

  // ─── Middleware 注入（读取）─── 受 agentInjection 控制
  if (config.agentInjection !== false) {
    registerRelationMiddleware(ctx, service, {
      enabled: true,
      maxDepth: numCfg(config.injectionMaxDepth, 1),
      maxBreadth: numCfg(config.injectionMaxBreadth, 5),
      maxEvents: numCfg(config.maxInjectedEvents, 5),
      maxRelations: numCfg(config.maxInjectedRelations, 8),
      maxParticipantsPerEvent: numCfg(config.maxParticipantsPerEvent, 5),
      maxCooccurrencePartners: numCfg(config.maxCooccurrencePartners, 5),
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
    registerRelationCommands(ctx, service);
  }
}

function numCfg(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

export const actions: PluginModule['actions'] = baseActions;

export { RelationService } from './service.js';
export { RelationStore } from './store.js';
export * from './types.js';
