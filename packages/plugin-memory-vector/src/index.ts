import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { contributions } from '@aalis/api-contributions';
import { embedding } from '@aalis/api-embedding';
import { hooks } from '@aalis/api-hooks';
import { ownHostConfig } from '@aalis/api-host-config';
import { memory } from '@aalis/api-memory';
import { platform, sessionTypeLabel } from '@aalis/api-platform';
import { rootSessionOf, sessionManager } from '@aalis/api-session-manager';
import { sessionFields } from '@aalis/api-session-settings';
import { tools } from '@aalis/api-tools';
import { type VectorSearchResult, vectorstore } from '@aalis/api-vectorstore';
import {
  type BoundOf,
  config,
  definePlugin,
  defineService,
  events,
  logger,
  optional,
  provide,
  type ServiceSelection,
} from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { toSource } from '@aalis/schema-i18n';
import type { IncomingMessage, Message } from '@aalis/schema-message';
import {
  CONTROL_KINDS,
  DIRECTIVE_KINDS,
  extractMentions,
  prefixSender,
  stripSenderPrefix,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';
import { t } from './texts.js';

// ===== 插件元数据 =====

const configSchema = defineConfig({
  search: {
    label: '搜索设置',
    fields: {
      topK: {
        type: 'number',
        label: '最大返回数',
        default: 5,
        description: '语义搜索返回的命中条数（每条会再带上下文窗口）',
      },
      timeWeight: {
        type: 'number',
        label: '时间权重',
        default: 0.3,
        description: '0=纯语义，1=纯时间近因',
      },
      userPriorityBoost: {
        type: 'number',
        label: '同用户加权系数',
        default: 2.0,
        description: '在 user 模式下对同一用户消息的命中分数乘以该系数（>1 表示优先）',
      },
      perItemMaxChars: {
        type: 'number',
        label: '单条截断字数',
        default: 0,
        description: '每条消息呈现给 LLM 时的字符上限；0 = 不截断（推荐）。超出会以「剩余 N 字符未展示」明示。',
      },
      minScore: {
        type: 'number',
        label: '最低相似度阈值',
        default: 0,
        description: '0~1，命中分数（时间加权前的语义分）低于该值则丢弃。0 表示不过滤',
      },
    },
  },
  contextExpand: {
    label: '上下文情景扩展',
    description: '命中后自动取该消息在原会话中的前后 N 条相邻消息（含 user/assistant/system/tool）还原情景。0 = 关闭。',
    fields: {
      window: {
        type: 'number',
        label: '扩展窗口（前后各 N 条消息）',
        default: 2,
        min: 0,
        integer: true,
        onInvalid: 'error',
        description: '0 = 仅命中本身。建议 2~5',
      },
      crossSession: {
        type: 'boolean',
        onInvalid: 'error',
        label: '跨会话也扩展',
        default: true,
        description: '若命中消息来自其他会话（user/all 模式可能发生），是否对那个会话也取上下文',
      },
    },
  },
  indexing: {
    label: '索引设置',
    description: '控制后台向量索引的削峰与并发。搜索路径不受该队列影响。',
    fields: {
      concurrency: {
        type: 'number',
        label: '最大并发索引数',
        default: 10,
        description:
          '同时进行的后台 embedding + 向量写入任务数。0 或负数表示不限制；建议 2~10，过高可能压垮本地 embedding 服务。',
      },
      maxQueueSize: {
        type: 'number',
        label: '最大索引队列长度',
        default: 500,
        description: '待索引消息队列上限。0 或负数表示不限制；超出后丢弃最旧待索引消息，避免内存无限增长。',
      },
    },
  },
  recallRoles: {
    type: 'select',
    label: '召回角色范围',
    default: 'all',
    description:
      'AI 自己的历史回复（role=assistant）是否作为语义命中参与召回。others-only 档过滤的是' +
      '**命中点**（候选池自动放大一倍补偿）；命中点的上下文扩窗邻居不过滤、仍可能以' +
      '「Assistant·你自己」标注出现（保留情景完整性）。无论何档，assistant 条目渲染必带' +
      '角色标注（防自我强化地基，不随开关关闭）。存量未打 role 的旧向量按 user（对方）对待',
    options: [
      { label: '对方与 AI 自己都召回', value: 'all' },
      { label: '只召回对方（过滤 AI 自己的回复）', value: 'others-only' },
    ],
  },
  // 按会话字段：生效值是被动召回与 memory_recall 的上限；坏值原样交来，按不互通处理
  crossSessionMode: {
    type: 'select',
    label: '跨会话检索模式',
    default: 'all',
    onInvalid: 'error',
    description: '控制向量记忆的跨会话可见范围',
    options: [
      { label: '不互通（仅当前会话）', value: 'isolated' },
      { label: '同用户增强（跨会话，同用户加权）', value: 'user' },
      { label: '同平台（仅相同平台的会话）', value: 'platform' },
      { label: '全部打通（所有平台所有会话）', value: 'all' },
    ],
    session: { prominence: 'advanced' },
  },
});

// ===== 配置 =====

/** 检索的可见范围：session=仅当前会话；platform=同平台所有会话；all=全部 */
type Visibility = 'session' | 'platform' | 'all';

/** 可见范围由窄到宽的次序 */
const VISIBILITY_RANK: Record<Visibility, number> = { session: 0, platform: 1, all: 2 };

/** 跨会话检索模式的可见范围：user 档是「全库可见 + 同用户加权」，可见范围同 all；坏值按不互通 */
const MODE_VISIBILITY: ReadonlyMap<unknown, Visibility> = new Map([
  ['isolated', 'session'],
  ['user', 'all'],
  ['platform', 'platform'],
  ['all', 'all'],
]);

/** 过了准入与可见范围的命中，带时间加权与同用户加权后的终分 */
type RankedHit = VectorSearchResult & { finalScore: number };

/** 一个会话的扩窗取数结果 */
interface PivotWindow {
  /** 覆盖该会话全部命中点（前后各留缓冲）的消息，按时间升序 */
  sorted: Message[];
  /** 命中点时间戳 → 在 sorted 中的下标；消息表里找不到（已老化清理）时为 -1 */
  idxByPivot: Map<number, number>;
}

type VectorMemoryConfig = ConfigOf<typeof configSchema>;

// ===== 工具 =====

function recencyScore(timestampMs: number, nowMs: number): number {
  const daysSince = (nowMs - timestampMs) / (1000 * 60 * 60 * 24);
  return Math.exp(-0.1 * daysSince);
}

/**
 * 送入 embedder 的文本上限（字符）。归档文本可以很长——文件附件的正文由 file-reader 整段
 * 烘进归档（`--- 文件内容 ---` 块），一条消息几万字并不罕见；embedder 输入超限时整条
 * 索引静默失败（只留一条 warn），消息从此不可召回。单条向量表达不了整篇文档，取开头
 * 足以让「有人发过这个文件」被召回；文件正文本就该由 file_read 类工具按需读。
 * 同一上限也作用于兜底 metadata.content，避免向量库存整篇文件正文。
 */
const MAX_EMBED_CHARS = 4000;
/**
 * 一段操作固定选中的那一家：算向量与记下 modelId（向量空间标识）、写入与清空再落盘、判方法与删除再落盘都要落在同一个
 * 实例上，途中换了人（含同一个 id 换了新实例）也不会混用两家。选不到时退回业务句柄，访问成员即抛不可用错误
 */
function pinned<P>(selection: ServiceSelection<P>): P {
  return selection.list().find(p => p.selected)?.use ?? selection.use;
}

/** 代理对安全截断：裸 slice 会切出孤代理，经 JSON 送到 embedder 端点同样会被严格解析器拒收。 */
function clipForEmbed(text: string): string {
  return truncateChars(text, MAX_EMBED_CHARS);
}

function truncate(text: string | undefined | null, max: number): string {
  const s = text ?? '';
  if (max <= 0 || s.length <= max) return s;
  const remaining = s.length - max;
  return `${s.slice(0, max)}…[已截断，还剩 ${remaining} 个字符未展示]`;
}

/**
 * 消息的可见正文。回复经结构化输出（persona 的 outputFormat）时，content 存整串 JSON 信封，
 * agent 把解码后的回复另写进 metadata 的 VisibleContent 键；键缺省即 content 本身。
 * 信封里的键骨架与当时的状态字段不该进向量空间，也不该当作「当时说的话」回流给模型。
 */
function visibleText(m: Message): string {
  const visible = m.metadata?.[WellKnownMetadataKeys.VisibleContent];
  return typeof visible === 'string' ? visible : (m.content ?? '');
}

/** 渲染一条消息为可读文本（含来源标签）。
 *
 * 角色标注（只标注、不过滤——检索与扩窗集合不变，召回率不受影响）：
 * 邻居扩窗从 memory 拉的是**全角色**消息，assistant/tool/notice 此前一律渲染成与
 * 真人发言同构的形态（连昵称/ID 标签都带）——AI 自己的台词以「群成员发言实录」
 * 口吻按语义相关度回流，正是「戳戳月卡」自我强化事故的机制。角色词根取
 * memory-history 的 Assistant/Notice，assistant 额外缀「你自己」强化自指
 * （tool 在彼处不渲染，此处自定）。 */
function renderMessage(m: Message, max: number, typeLabel: (platform: string, type: string) => string): string {
  const meta = m.metadata ?? {};
  const ts = m.timestamp ?? 0;
  const date = new Date(ts).toLocaleString('zh-CN');

  const userId = (meta[WellKnownMetadataKeys.UserId] as string | undefined) ?? m.name ?? '';
  const nickname = meta[WellKnownMetadataKeys.Nickname] as string | undefined;
  const groupName = meta[WellKnownMetadataKeys.GroupName] as string | undefined;
  const platformName = (meta[WellKnownMetadataKeys.Platform] as string | undefined) ?? '';
  const sessionType = meta[WellKnownMetadataKeys.SessionType] as string | undefined;

  // 位置描述：优先群名、其次会话类型的显示名
  let where = '';
  if (groupName) {
    where = `群「${groupName}」/`;
  } else if (sessionType) {
    where = `${typeLabel(platformName, sessionType)}/`;
  }
  // 平台前缀
  const platformPrefix = platformName ? `${platformName}/` : '';

  let who: string;
  let cleanContent = visibleText(m);
  if (m.role === 'assistant') {
    who = `Assistant·你自己${nickname ? `(${nickname})` : ''}`;
  } else if (m.role === 'notice') {
    who = 'Notice';
  } else if (m.role === 'tool') {
    who = 'Tool·工具结果';
  } else {
    who = nickname ? `${nickname}${userId ? `(${userId})` : ''}` : userId;
    // 去掉存档给入站 user 消息烘进的发送者前缀（tag 已表达身份，避免双重前缀）：按存档记下的标签去，
    // 正文自己以 [..]: 开头的不动
    const label = meta[WellKnownMetadataKeys.SenderLabel];
    cleanContent = stripSenderPrefix(cleanContent, typeof label === 'string' ? label : undefined);
  }
  const tag = `[${platformPrefix}${where}${who}${who ? ' ' : ''}@ ${date}]`;

  return `${tag} ${truncate(cleanContent, max)}`;
}

/** 给消息生成稳定 key 用于跨命中去重（sessionId + timestamp + role） */
function messageKey(sessionId: string, m: Message): string {
  // 不含 content：同一逻辑消息（同 sid+ts+role）不因文本形态差异（存量向量的 metadata.content
  // 无发送者前缀，真消息有）分裂成两个 key，避免扩展路径与兜底对同一 pivot 各注入一次造成可见重复。
  return `${sessionId}|${m.timestamp ?? 0}|${m.role}`;
}

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
// `semantic-memory` 是**能力标记**而非查询 API：它只声明「本实例具备语义检索能力」，
// 供依赖声明与拓扑排序识别，以及消费方做能力探测。语义检索本身经工具与
// memory 契约走，不从这里取。如实声明它的真实形状，不臆造一个没人实现的查询接口。
/** 存在性标记服务：只表明「语义记忆已就绪」，检索本身走 memory 契约 */
export const semanticMemory = defineService<{ name: string }>('semantic-memory');

// ===== 插件入口 =====

const uses = {
  vectorstore,
  embedding,
  memory: optional(memory),
  tools: optional(tools),
  /**
   * 当前会话、候选所在会话的出生平台（子会话取根会话的）。不在场时当前平台取入口平台，同平台过滤只认向量记下的入口平台
   */
  sessionManager: optional(sessionManager),
  /** 召回片段的位置写平台声明的类型显示名；缺席时写类型名 */
  platform: optional(platform),
  /** 按会话读跨会话检索模式；缺席时取插件配置里的值 */
  sessionFields: optional(sessionFields),
  /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
  document: optional(ownHostConfig),
  events,
  hooks,
  contributions,
  provide,
  logger,
  config,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-memory-vector',
  displayName: '向量记忆',
  subsystem: 'memory',
  configSchema,
  provides: [semanticMemory],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const {
    vectorstore,
    embedding,
    memory,
    tools,
    sessionManager,
    events,
    hooks,
    contributions,
    provide,
    logger,
    config,
  } = caps;
  // memory 是可选依赖，provider 换人不级联 bounce 本插件：引用与能力探测都必须在调用点现算，
  // 否则 provider 晚于本插件注册时 hasRangeQuery 永久为假，或扩窗落在已关闭的旧实例上。
  function hasRangeQuery(): boolean {
    return memory.present && typeof memory.use.getMessagesBySessionRange === 'function';
  }

  const parsed = parseConfig(configSchema, config.use, logger.use);
  const fields = caps.sessionFields.use.fields(configSchema, caps);

  const cfg: VectorMemoryConfig = {
    search: {
      ...parsed.search,
      timeWeight: Math.max(0, Math.min(1, parsed.search.timeWeight)),
      userPriorityBoost: Math.max(1, parsed.search.userPriorityBoost),
      perItemMaxChars: Math.max(0, parsed.search.perItemMaxChars),
      minScore: Math.max(0, Math.min(1, parsed.search.minScore)),
    },
    contextExpand: parsed.contextExpand,
    indexing: {
      concurrency: Math.floor(parsed.indexing.concurrency),
      maxQueueSize: Math.floor(parsed.indexing.maxQueueSize),
    },
    recallRoles: parsed.recallRoles,
  };

  // 启动日志与下方 warn 都是启动时刻的快照（此后按调用点现算，不再据此判定）
  logger.use.info(
    `向量记忆已启动: ${await vectorstore.use.size()} 条向量, 范围查询=${hasRangeQuery() ? '可用' : '不可用'}, ` +
      `userBoost=${cfg.search.userPriorityBoost}, expandWindow=${cfg.contextExpand.window}, ` +
      `单条截断=${cfg.search.perItemMaxChars > 0 ? `${cfg.search.perItemMaxChars}字` : '不截断'}, minScore=${cfg.search.minScore}, ` +
      `indexConcurrency=${cfg.indexing.concurrency <= 0 ? 'unlimited' : cfg.indexing.concurrency}, ` +
      `indexQueue=${cfg.indexing.maxQueueSize <= 0 ? 'unlimited' : cfg.indexing.maxQueueSize}`,
  );

  if (!hasRangeQuery() && cfg.contextExpand.window > 0) {
    logger.use.warn('当前 memory 后端不支持范围查询，contextExpand 将退化为仅命中本身');
  }

  provide.use(semanticMemory, { name: 'vector-memory' });

  // === 检索管线（被动注入与 memory_recall 共用）===

  /** 候选池放大倍率：others-only 档的角色过滤发生在检索后，候选池放大一倍补偿，否则 assistant 语料
   * 占比升高后对方消息会被挤出候选（同语料实测 2→0 条） */
  const candidateOversample = cfg.recallRoles === 'others-only' ? 8 : 4;

  /** 平台声明的类型显示名，取原文（召回片段是写给模型的）；平台不在、没声明显示名时为类型名 */
  function typeLabel(platformName: string, type: string): string {
    return toSource(sessionTypeLabel(caps.platform, platformName, type) ?? type);
  }

  /** 会话管理记下的出生平台（子会话取根会话的）；会话管理不在或会话没有出生平台时为 undefined */
  function originPlatformOf(sessionId: string): string | undefined {
    const sm = sessionManager.present ? sessionManager.use : undefined;
    return sm && rootSessionOf(sm.getSession(sessionId), id => sm.getSession(id))?.originPlatform;
  }

  /**
   * 检索的当前平台（platform 可见范围与房间的召回范围按它算）：房间会话按出生平台，不论从哪个入口驱动，owner 从 WebUI
   * 往群里插话时不召回 owner 自己的 WebUI 会话；没有出生平台的会话按入口平台
   */
  function currentPlatformOf(sessionId: string | undefined, entryPlatform: string | undefined): string {
    return (sessionId === undefined ? undefined : originPlatformOf(sessionId)) ?? entryPlatform ?? '';
  }

  /**
   * 这个会话的跨会话检索模式（每次检索现读，改了下一轮即生效）：可见范围（检索的上限）与是否按同用户加权。platform 是入口平台
   */
  function modeOf(sessionId: string | undefined, platform: string | undefined) {
    const mode = fields.get(sessionId, { platform }).crossSessionMode;
    return { visibility: MODE_VISIBILITY.get(mode) ?? 'session', userBoost: mode === 'user' };
  }

  // === embedding 模型（向量空间）===
  // 只有同一模型算出的向量才能互相比较。索引时 metadata 记下提供者的 modelId；本版之前写入的
  // 存量向量不带它，它们出自哪个模型记在记忆元数据的存量标记里：首次需要时读取，不存在就记下
  // 当时的模型（即升级后第一次检索时的模型）。memory 是可选依赖且可能晚到，确定不了时本次把
  // 存量向量视为与当前模型一致（与改前行为相同），成功读到或写入后才缓存。

  const LEGACY_MODEL_NAMESPACE = 'memory-vector';
  const LEGACY_MODEL_KEY = 'legacy-model';
  /** 已确定的存量标记；undefined = 尚未确定 */
  let legacyModel: { modelId?: string } | undefined;
  /** 已为哪些当前模型告警过「排除了其它模型的向量」 */
  const mismatchWarned = new Set<string>();
  /**
   * 存量标记读写失败是否已告警。后端持续出错时每轮检索都会重试，同一段连续失败只告警一次；
   * 标记一经确定即缓存、此后不再经这里读写，失败段随之结束，所以成功时无需复位。
   * 全局清空向量库时缓存随标记一并复位（见 dropLegacyModel），本标志也随之复位。
   */
  let legacyFailureWarned = false;

  /**
   * 标记的读写与删除排成一队：全局清空删标记时，在途的读写先落定再删，删之后才轮到的读写看到的是删后的库。
   * 否则清空前读到的旧标记会在删除之后进缓存，在途的写入会在删除之后落库。队尾只等前一个操作落定：
   * 某个操作拒绝时拒绝照常交给它的调用方，之后排队的操作照常执行
   */
  let markerQueue: Promise<void> = Promise.resolve();
  function queueMarker<T>(op: () => Promise<T>): Promise<T> {
    const queued = markerQueue.then(op);
    markerQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /** 存量向量（无 metadata.modelId）的模型；确定不了时返回 undefined，由调用方按当前模型对待 */
  async function legacyModelId(currentModelId: string): Promise<string | undefined> {
    if (legacyModel) return legacyModel.modelId;
    return queueMarker(() => loadLegacyModelId(currentModelId));
  }

  /** 读取或记下存量标记（在标记队列里执行）。排队期间已有别的读写确定了标记，直接用它 */
  async function loadLegacyModelId(currentModelId: string): Promise<string | undefined> {
    if (legacyModel) return legacyModel.modelId;
    // 先读后写：固定同一家
    const mem = memory.list().find(p => p.selected)?.use;
    if (!mem) return undefined;
    try {
      const data = await mem.getMetadata(LEGACY_MODEL_NAMESPACE, LEGACY_MODEL_KEY);
      if (data) {
        legacyModel = { modelId: typeof data.modelId === 'string' ? data.modelId : undefined };
      } else {
        await mem.saveMetadata(LEGACY_MODEL_NAMESPACE, LEGACY_MODEL_KEY, { modelId: currentModelId });
        legacyModel = { modelId: currentModelId };
      }
      return legacyModel.modelId;
    } catch (err) {
      if (!legacyFailureWarned) {
        legacyFailureWarned = true;
        logger.use.warn(
          '读写存量向量的模型标记失败，存量向量暂按当前模型对待；之后每次检索都会重试，恢复前不再重复告警:',
          err,
        );
      }
      return undefined;
    }
  }

  /**
   * 向量库全局清空后，存量向量已不复存在：删掉存量标记并复位缓存，之后按届时的模型重新确定。
   * 删除失败只记 warn，不影响清空结果（残留的标记只作用于不带 modelId 的向量）。
   */
  function dropLegacyModel(): Promise<void> {
    return queueMarker(async () => {
      try {
        if (memory.present) await memory.use.deleteMetadata(LEGACY_MODEL_NAMESPACE, LEGACY_MODEL_KEY);
      } catch (err) {
        logger.use.warn('删除存量向量的模型标记失败:', err);
      }
      legacyModel = undefined;
      legacyFailureWarned = false;
    });
  }

  /**
   * 检索并排序：search → 同模型 → 准入 → minScore → 可见范围 → 时间加权 → 同用户加权 → 按终分降序。
   * 同模型：queryModelId 取自算查询向量的那个提供者；声明了时只留同模型的向量（存量向量按存量标记
   * 认定模型），未声明时不按模型过滤。
   * 准入：others-only 档过滤 AI 自身发言；存量旧向量无 role 字段，不等于 'assistant'，按对方对待。
   * 同用户加权只对 boostUserIds 里的用户（crossSessionMode='user' 时调用方给）：作者是其中一位或其中一位被 @提及，
   * 分数乘以 userPriorityBoost。
   */
  async function rankCandidates(
    queryVec: number[],
    queryModelId: string | undefined,
    candidateCount: number,
    scope: {
      visibility: Visibility;
      curSessionId: string | undefined;
      curPlatform: string;
      boostUserIds: readonly string[];
    },
  ): Promise<RankedHit[]> {
    const candidates = await vectorstore.use.search(queryVec, candidateCount);
    const legacy = queryModelId ? await legacyModelId(queryModelId) : undefined;
    const excludedModels = new Set<string>();
    const now = Date.now();
    const ranked = candidates
      .filter(c => {
        if (!queryModelId) return true;
        const vecModel = (c.metadata.modelId as string | undefined) ?? legacy ?? queryModelId;
        if (vecModel === queryModelId) return true;
        excludedModels.add(vecModel);
        return false;
      })
      .filter(c => !(cfg.recallRoles === 'others-only' && c.metadata.role === 'assistant'))
      .filter(c => c.score >= cfg.search.minScore)
      .filter(c => {
        switch (scope.visibility) {
          case 'session':
            return c.metadata.sessionId === scope.curSessionId;
          case 'platform':
            // 向量记下的是那一轮的入口平台：房间里经 WebUI 插的话记为 webui，再按会话记下的出生平台认回房间的平台
            return (
              (c.metadata.platform as string) === scope.curPlatform ||
              originPlatformOf(c.metadata.sessionId as string) === scope.curPlatform
            );
          default:
            return true;
        }
      })
      .map(c => {
        let score =
          (1 - cfg.search.timeWeight) * c.score +
          cfg.search.timeWeight * recencyScore((c.metadata.timestamp as number) ?? 0, now);
        const mentions = c.metadata.mentions as string[] | undefined;
        const boosted = scope.boostUserIds.some(
          id => (c.metadata.userId as string) === id || (Array.isArray(mentions) && mentions.includes(id)),
        );
        if (boosted) score *= cfg.search.userPriorityBoost;
        return { ...c, finalScore: score };
      });
    if (queryModelId && excludedModels.size > 0 && !mismatchWarned.has(queryModelId)) {
      mismatchWarned.add(queryModelId);
      logger.use.warn(
        `向量库里有其它 embedding 模型生成的向量（${[...excludedModels].join('、')}），与当前模型 ${queryModelId} ` +
          '的向量不可比较，检索时已排除。要继续召回这些记忆，改回原模型或用当前模型重新 embed 这些向量；' +
          '不再需要时可用 /clear all -t vector 清空向量库，由新消息重建。',
      );
    }
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    return ranked;
  }

  /**
   * 扩窗取数：按会话聚合命中点，每个会话用覆盖全部命中点的宽时间窗（前后各 4 小时缓冲，足以覆盖
   * 数十条邻居的常见场景）一次范围查询，避免多次小查询；再定位每个命中点，先找同时间戳的 user 消息，
   * 找不到再退回同时间戳的任意角色。
   * `crossSession` 为 false 时只取当前会话的命中。memory 不在或不支持范围查询时返回空表；
   * 单个会话查询失败只记告警、该会话缺席，中止则原样抛出。
   */
  async function loadPivotWindows(
    hits: RankedHit[],
    crossSession: boolean,
    curSessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<Map<string, PivotWindow>> {
    const windows = new Map<string, PivotWindow>();
    const mem = memory.present ? memory.use : undefined;
    if (!mem?.getMessagesBySessionRange) return windows;

    const sessionPivots = new Map<string, number[]>();
    for (const r of hits) {
      const sid = r.metadata.sessionId as string | undefined;
      const ts = r.metadata.timestamp as number | undefined;
      if (!sid || ts === undefined) continue;
      if (!crossSession && sid !== curSessionId) continue;
      const arr = sessionPivots.get(sid) ?? [];
      arr.push(ts);
      sessionPivots.set(sid, arr);
    }

    const bufferMs = 4 * 60 * 60 * 1000;
    for (const [sid, pivots] of sessionPivots) {
      signal?.throwIfAborted();
      const minTs = Math.min(...pivots);
      const maxTs = Math.max(...pivots);
      try {
        // 事件标记（CONTROL_KINDS）不是对话内容：不带出，也不占前后 N 条的名额
        const all = await mem.getMessagesBySessionRange(sid, minTs - bufferMs, maxTs + bufferMs, undefined, [
          ...CONTROL_KINDS,
        ]);
        signal?.throwIfAborted();
        const sorted = all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        const idxByPivot = new Map<number, number>();
        for (const pivotTs of pivots) {
          const userIdx = sorted.findIndex(m => (m.timestamp ?? 0) === pivotTs && m.role === 'user');
          idxByPivot.set(pivotTs, userIdx >= 0 ? userIdx : sorted.findIndex(m => (m.timestamp ?? 0) === pivotTs));
        }
        windows.set(sid, { sorted, idxByPivot });
      } catch (err) {
        signal?.throwIfAborted();
        logger.use.warn(`扩展上下文失败 (session=${sid}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return windows;
  }

  // === 索引：入站 user 消息 + assistant 落库回复，触发即写；已落库的消息被改写时换掉旧条目 ===

  /** 待索引项：user 带归档消息（文本与时间戳都以落库形态为准）；assistant 自带；rewritten 是改写后的整条 */
  type PendingIndexItem =
    | { kind: 'user'; msg: IncomingMessage; archived: Message }
    | { kind: 'assistant' | 'rewritten'; sessionId: string; message: Message };
  const pendingIndexMessages: PendingIndexItem[] = [];
  let activeIndexers = 0;
  /**
   * 在途的收录与重收录，按会话与时间戳：改写项先等同一条在途的那个落定再删旧条目。识图命中缓存时改写通知紧跟着落库到来，不等
   * 的话删不到还没写进去的旧条目，原来那条随后照旧写进去；同一条的几次改写也这样排成一串，按到达的先后落定
   */
  const indexing = new Map<string, Promise<void>>();
  const entryKey = (sessionId: string, timestamp: number | undefined) => `${sessionId}\n${timestamp}`;

  function track(key: string, work: Promise<void>): Promise<void> {
    indexing.set(key, work);
    return work.finally(() => {
      if (indexing.get(key) === work) indexing.delete(key);
    });
  }

  function enqueueIndexMessage(item: PendingIndexItem): void {
    pendingIndexMessages.push(item);
    if (cfg.indexing.maxQueueSize > 0 && pendingIndexMessages.length > cfg.indexing.maxQueueSize) {
      const dropped = pendingIndexMessages.splice(0, pendingIndexMessages.length - cfg.indexing.maxQueueSize).length;
      logger.use.warn(`向量索引队列过长，已丢弃 ${dropped} 条最旧待索引消息`);
    }
    void drainIndexQueue();
  }

  async function drainIndexQueue(): Promise<void> {
    while (
      (cfg.indexing.concurrency <= 0 || activeIndexers < cfg.indexing.concurrency) &&
      pendingIndexMessages.length > 0
    ) {
      const next = pendingIndexMessages.shift()!;
      activeIndexers++;
      void (async () => {
        try {
          if (next.kind === 'user') {
            await track(
              entryKey(next.msg.sessionId, next.archived.timestamp),
              indexUserMessage(next.msg, next.archived),
            );
          } else if (next.kind === 'assistant') {
            const work = indexEntry(() => assistantEntry(next.sessionId, next.message), 'assistant 向量索引失败:');
            await track(entryKey(next.sessionId, next.message.timestamp), work);
          } else {
            const key = entryKey(next.sessionId, next.message.timestamp);
            await track(key, reindexRewritten(next.sessionId, next.message, indexing.get(key)));
          }
        } finally {
          activeIndexers--;
          void drainIndexQueue();
        }
      })();
    }
  }

  async function indexUserMessage(msg: IncomingMessage, archived: Message): Promise<void> {
    // 带来源的是内部注入，不是谁在跟她说话，不进长期记忆（与档案插件同一判据；宿主通知按契约必带来源）
    if (msg.source) return;
    await indexEntry(() => userEntry(msg.sessionId, archived), '向量索引失败:');
  }

  /** 一条消息算成的向量条目 */
  interface VectorEntry {
    vec: number[];
    metadata: Record<string, unknown>;
  }

  /** 算出条目、写进向量库；不收录的（算出 undefined）不写，出错记 warn */
  async function indexEntry(build: () => Promise<VectorEntry | undefined>, failure: string): Promise<void> {
    try {
      const entry = await build();
      if (!entry) return;
      const store = pinned(vectorstore);
      await store.add(entry.vec, entry.metadata);
      await store.save();
    } catch (err) {
      logger.use.warn(failure, err);
    }
  }

  /**
   * 对方的一条发言算成向量条目。向量文本 = 归档文本（单一来源）：archive 已按平台规则加发送者前缀、烘入引用与附件描述；若 embed
   * 的是 incoming.content，图片消息只剩 [图片 | ref:…] 占位符，识别出的描述从未进向量空间，图片记忆不可召回。说话人与位置取存档
   * 记在元数据里的（与入站消息同一份事实），改写后重收录时同样取它们
   */
  async function userEntry(sessionId: string, archived: Message): Promise<VectorEntry | undefined> {
    const rawText = clipForEmbed(archived.content?.trim() ?? '');
    if (!rawText) return undefined;
    const meta = archived.metadata ?? {};
    const fact = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : '');
    const mentioned = meta[WellKnownMetadataKeys.Mentions];
    // 向量空间标识与向量出自同一实例，在发起计算时一并读下：那一家中途撤回后钉住的句柄就不可用了
    const provider = pinned(embedding);
    const { modelId } = provider;
    const vec = await provider.embed(rawText);
    const metadata: Record<string, unknown> = {
      sessionId,
      // 前向打角色（2026-08-27 起）：存量旧向量无此字段，检索侧按 user（对方）对待
      role: 'user',
      userId: fact(WellKnownMetadataKeys.UserId),
      nickname: fact(WellKnownMetadataKeys.Nickname),
      platform: fact(WellKnownMetadataKeys.Platform),
      groupName: fact(WellKnownMetadataKeys.GroupName),
      groupId: fact(WellKnownMetadataKeys.GroupId),
      sessionType: fact(WellKnownMetadataKeys.SessionType),
      // 归档写入时间戳：保证后续按时间戳精确删除（如「回滚本轮对话」）能命中向量条目
      timestamp: archived.timestamp ?? Date.now(),
      // 兜底内容：归档文本（消息表老化后供渲染兜底；user 角色的发送者前缀由渲染侧按 senderLabel 去掉）
      content: rawText,
      // 发言人自己写的话里 @ 到的用户 ID，用于检索时同用户加权
      mentions: Array.isArray(mentioned) ? mentioned : [],
    };
    // 发送者前缀的标签：存档只在加了前缀时记，没有就不写
    const senderLabel = fact(WellKnownMetadataKeys.SenderLabel);
    if (senderLabel) metadata[WellKnownMetadataKeys.SenderLabel] = senderLabel;
    // 检索时只与同模型的查询向量比较
    if (modelId) metadata.modelId = modelId;
    return { vec, metadata };
  }

  // 与 plugin-user-profile 等「派生持久数据」插件统一锚点：仅对已成功落库的入站消息建索引，
  // 避免归档失败的消息进入向量库，也消除归档前/后两套订阅时机的不一致。
  events.use.on('inbound:message:archived', data => {
    enqueueIndexMessage({ kind: 'user', msg: data.incoming, archived: data.archivedMessage });
  });

  // assistant 自身发言入库（2026-08-27，recallRoles 双模式的存储侧）：
  // 经 archive.saveMessage 落库的 assistant 回复（含她发出的附件的记录）。
  // metadata 带 role='assistant'，检索側据此过滤与标注；渲染必带「Assistant·你自己」。
  events.use.on('assistant:message:archived', data => {
    enqueueIndexMessage({ kind: 'assistant', sessionId: data.sessionId, message: data.message });
  });

  /** 她的一条发言算成向量条目 */
  async function assistantEntry(sessionId: string, message: Message): Promise<VectorEntry | undefined> {
    // 向量文本 = 可见正文：落库的是结构化输出信封时取解码后的回复（见 visibleText）
    const rawText = clipForEmbed(visibleText(message).trim());
    if (!rawText) return undefined;
    // 防御性冗余：EventMarker 现产者全是 role:system、被发射门先挡；此处兜第三方发射者
    if (message.kind === WellKnownKinds.EventMarker) return undefined;
    const meta = message.metadata ?? {};
    const nickname = (meta[WellKnownMetadataKeys.Nickname] as string | undefined) ?? '';
    // 生产者是 plugin-agent 的 buildAssistantMetadata：自身标识写在 UserId 键
    //（值=identity.selfId），并带群名、群号与会话类型——全部透传，
    // 使 assistant 条目的渲染位置段（群「X」/私聊/）与 user 侧对齐。
    // 注意没有 selfId 这个键（曾经读错过字段名）。
    const selfUserId = (meta[WellKnownMetadataKeys.UserId] as string | undefined) ?? '';
    // 与 user 侧对称：embed 带发送者前缀，身份信号入向量空间
    const embedText = prefixSender(rawText, nickname || undefined, selfUserId || undefined);
    const provider = pinned(embedding);
    const { modelId } = provider;
    const vec = await provider.embed(embedText);
    const metadata: Record<string, unknown> = {
      sessionId,
      role: 'assistant',
      // userId=自身标识：crossSessionMode='user' 的同用户加权按调用者 userId 匹配，
      // 不会误中 bot 自身；空串与 user 侧缺省语义一致
      userId: selfUserId,
      nickname,
      // 与 user 侧同一口径：这一轮的入口平台
      platform: (meta[WellKnownMetadataKeys.Platform] as string | undefined) ?? '',
      groupName: (meta[WellKnownMetadataKeys.GroupName] as string | undefined) ?? '',
      groupId: (meta[WellKnownMetadataKeys.GroupId] as string | undefined) ?? '',
      sessionType: (meta[WellKnownMetadataKeys.SessionType] as string | undefined) ?? '',
      timestamp: message.timestamp ?? Date.now(),
      content: rawText,
      mentions: extractMentions(rawText),
    };
    if (modelId) metadata.modelId = modelId;
    return { vec, metadata };
  }

  // 已落库的消息被改写（出站附件补上描述等）：排进同一个索引队列，先等同一条在途的收录落定
  events.use.on('memory:messages-rewritten', ({ sessionId, messages }) => {
    for (const message of messages) enqueueIndexMessage({ kind: 'rewritten', sessionId, message });
  });

  /**
   * 改写后的一条换掉旧条目：只管她与对方的发言（assistant 按她的发言，user 按存档消息的元数据），先按改写后的正文算出条目，
   * 算成了才按会话与时间戳删掉旧条目（与回滚删向量同一写法）、写进新的；向量化失败时旧条目留着。删不到的（原来就没收录，
   * 如宿主通知与内部注入）不收录，入站的过滤规则不必再写一遍。向量存储不支持按条件删除时不重收录，免得同一条留两份。
   * previous 是同一条在途的那个（收录或前一次改写），先等它落定
   */
  async function reindexRewritten(
    sessionId: string,
    message: Message,
    previous: Promise<void> | undefined,
  ): Promise<void> {
    await previous;
    const entryOf = message.role === 'assistant' ? assistantEntry : message.role === 'user' ? userEntry : undefined;
    const { timestamp } = message;
    if (!entryOf || timestamp === undefined) return;
    try {
      const entry = await entryOf(sessionId, message);
      if (!entry) return;
      const store = pinned(vectorstore);
      if (!store.deleteByFilter) {
        logger.use.warn('当前向量存储不支持按条件删除，改写过的消息不重收录');
        return;
      }
      if ((await store.deleteByFilter({ sessionId, timestamp })) === 0) return;
      await store.add(entry.vec, entry.metadata);
      await store.save();
    } catch (err) {
      logger.use.warn('改写过的消息重收录失败:', err);
    }
  }

  // === 按时间戳删除向量（供 plugin-checkpoint 回滚整轮对话使用） ===
  events.use.on('memory:messages-deleted', async data => {
    if (!data?.sessionId || !Array.isArray(data.timestamps) || data.timestamps.length === 0) return;
    const currentStore = pinned(vectorstore);
    if (!currentStore.deleteByFilter) {
      logger.use.warn('当前向量存储不支持按条件删除，跳过 memory:messages-deleted');
      return;
    }
    let total = 0;
    for (const ts of data.timestamps) {
      try {
        total += await currentStore.deleteByFilter({ sessionId: data.sessionId, timestamp: ts });
      } catch (err) {
        logger.use.warn(`按时间戳删除向量失败 (ts=${ts}):`, err);
      }
    }
    if (total > 0) {
      try {
        await currentStore.save();
      } catch (err) {
        logger.use.warn('向量保存失败:', err);
      }
      logger.use.info(`回滚清除向量: session=${data.sessionId}, 删除 ${total} 条`);
    }
  });

  // === 统一记忆清除（登记 vector 类型，/clear -t 才选得中）===

  contributions.use.contribute('memory:clear-type', { id: 'vector', label: t('clearType') });
  hooks.use.middleware('memory:clear', async (data, next) => {
    if (data.types && !data.types.includes('vector')) {
      await next();
      return;
    }

    try {
      if (data.scope === 'all') {
        const store = pinned(vectorstore);
        await store.clear();
        await store.save();
        await dropLegacyModel();
        data.results.push({ source: 'vector', type: 'vector', success: true, message: '所有向量记忆已清空' });
        logger.use.info('向量记忆已全部清空');
      } else if (data.sessionId) {
        const currentStore = pinned(vectorstore);
        if (currentStore.deleteByFilter) {
          const deleted = await currentStore.deleteByFilter({ sessionId: data.sessionId });
          await currentStore.save();
          data.results.push({
            source: 'vector',
            type: 'vector',
            success: true,
            message: `向量记忆已清空 (${deleted} 条)`,
          });
          logger.use.info(`向量记忆已清空: session=${data.sessionId}, 删除 ${deleted} 条向量`);
        } else {
          // 老实报告：不支持会话级删除时不能谎称成功（此前会 push success 且「已清空 0 条」误导用户）。
          logger.use.warn('当前向量存储不支持按条件删除，会话级向量清空跳过');
          data.results.push({
            source: 'vector',
            type: 'vector',
            success: false,
            message: '当前向量存储不支持会话级清空，向量记忆未清除（可改用 /clear.all 或换支持按条件删除的后端）',
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      data.results.push({ source: 'vector', type: 'vector', success: false, message: `向量清空失败: ${msg}` });
      logger.use.warn('向量清空失败:', err);
    }

    await next();
  });

  // === 检索并注入上下文（agent:prompt 贡献 / turn-context 槽：按这一轮的输入检索、每轮必变，落历史后护前缀缓存）===

  contributions.use.contribute('agent:prompt', {
    id: 'memory-vector',
    anchor: 'turn-context',
    async build(data) {
      // 干跑(token 快照)不做真实的 embedding+检索——那是纯统计路径的昂贵副作用
      if (data.dryRun) return null;
      data.signal?.throwIfAborted();

      // 检索词：这一轮各条输入归档的正文按先后相接（与入库时同一份正文），超过上限时从最早的一条丢起；都没归档时不检索
      const texts = data.inputs.flatMap(({ archived }) => (archived?.content ? [archived.content] : []));
      if (texts.length === 0) return null;
      while (texts.length > 1 && texts.join('\n').length > MAX_EMBED_CHARS) texts.shift();
      const query = clipForEmbed(texts.join('\n'));

      try {
        const curSessionId = data.sessionId;
        const curPlatform = currentPlatformOf(curSessionId, data.platform);
        const mode = modeOf(curSessionId, data.platform);
        /** 同用户加权：这一轮各条输入的发言者 */
        const speakers = data.inputs.flatMap(({ message }) => (message.userId ? [message.userId] : []));

        const candidateCount = Math.min(cfg.search.topK * candidateOversample, await vectorstore.use.size());
        data.signal?.throwIfAborted();
        if (candidateCount === 0) return null;

        const provider = pinned(embedding);
        const { modelId } = provider;
        const queryVec = await provider.embed(query, { signal: data.signal });
        data.signal?.throwIfAborted();
        const ranked = await rankCandidates(queryVec, modelId, candidateCount, {
          visibility: mode.visibility,
          curSessionId,
          curPlatform,
          boostUserIds: mode.userBoost ? speakers : [],
        });
        data.signal?.throwIfAborted();

        const topResults = ranked.slice(0, cfg.search.topK);
        if (topResults.length === 0) return null;

        // 命中点 + 上下文窗口扩展（合并区间，去重）
        const W = cfg.contextExpand.window;
        const collected = new Map<string, { sessionId: string; msg: Message }>();
        // sid|ts 占位集：messageKey 含 role，扩窗路径（真实 role，如 proactive 代发任务落的 notice）与
        // 兜底路径（强制 user）会对同一逻辑消息各持一 key、双份注入——兜底以此集判断
        // 该 (sid,ts) 是否已被任一角色覆盖。
        const collectedSidTs = new Set<string>();
        const markSidTs = (sid: string, ts: number | undefined) => collectedSidTs.add(`${sid}|${ts ?? 0}`);

        // 当前对话已有的内容用于去重，按可见正文比：命中的 assistant 向量存的是可见正文，扩窗带出的邻居与
        // 历史里的同一条回复都取 visibleText，落库的是结构化输出信封时也对得上。
        const currentContents = new Set(data.messages.map(m => visibleText(m).trim()).filter(Boolean));

        if (W > 0) {
          const windows = await loadPivotWindows(topResults, cfg.contextExpand.crossSession, curSessionId, data.signal);
          for (const [sid, { sorted, idxByPivot }] of windows) {
            // 对每个 pivot 取 ±W 条
            for (const [pivotTs, idx] of idxByPivot) {
              if (idx < 0) {
                // pivot 在 messages 表里找不到（消息表已老化清理），从向量 metadata 兜底插入
                const cand = topResults.find(r => r.metadata.sessionId === sid && r.metadata.timestamp === pivotTs);
                if (cand) {
                  const fakeMsg: Message = {
                    role: ((cand.metadata.role as Message['role']) ?? 'user') as Message['role'],
                    content: (cand.metadata.content as string) ?? '',
                    timestamp: pivotTs,
                    name: cand.metadata.userId as string | undefined,
                    metadata: cand.metadata,
                  };
                  const key = messageKey(sid, fakeMsg);
                  if (!collected.has(key)) {
                    collected.set(key, { sessionId: sid, msg: fakeMsg });
                    markSidTs(sid, pivotTs);
                  }
                }
                continue;
              }
              const start = Math.max(0, idx - W);
              const end = Math.min(sorted.length, idx + W + 1);
              for (let i = start; i < end; i++) {
                const m = sorted[i];
                if (!m.content) continue;
                // 指令类（代发任务、宿主通知）不是任何人的发言，不随邻居带出。命中点本身不在此列：
                // 在这里跳过，下面的兜底会按向量元数据把它补成 user 行
                if (i !== idx && DIRECTIVE_KINDS.includes(m.kind ?? '')) continue;
                if (currentContents.has(visibleText(m).trim())) continue;
                const key = messageKey(sid, m);
                if (!collected.has(key)) {
                  collected.set(key, { sessionId: sid, msg: m });
                  markSidTs(sid, m.timestamp);
                }
              }
            }
          }
        }

        // 兜底：把所有未被扩展覆盖的命中（如跨会话扩展关闭、或无 range query）放入 collected
        for (const r of topResults) {
          const sid = r.metadata.sessionId as string | undefined;
          const ts = r.metadata.timestamp as number | undefined;
          if (!sid || ts === undefined) continue;
          // 注：索引侧只写 user 入站与 assistant 落库回复（event-marker/压缩标记是
          // role:system，进不了任一写口），这里无需额外过滤控制消息。
          const fakeMsg: Message = {
            role: ((r.metadata.role as Message['role']) ?? 'user') as Message['role'],
            content: (r.metadata.content as string) ?? '',
            timestamp: ts,
            name: r.metadata.userId as string | undefined,
            metadata: r.metadata,
          };
          if (!fakeMsg.content) continue;
          if (currentContents.has(fakeMsg.content.trim())) continue;
          // 该 (sid,ts) 已被扩窗以真实角色收录（可能非 user，如代发任务 notice）→ 不再造 user 拷贝
          if (collectedSidTs.has(`${sid}|${ts}`)) continue;
          const key = messageKey(sid, fakeMsg);
          if (!collected.has(key)) collected.set(key, { sessionId: sid, msg: fakeMsg });
        }

        if (collected.size === 0) return null;

        // 按时间排序混排
        const sortedAll = [...collected.values()].sort((a, b) => (a.msg.timestamp ?? 0) - (b.msg.timestamp ?? 0));

        const lines = sortedAll.map(({ msg }) => renderMessage(msg, cfg.search.perItemMaxChars, typeLabel));

        // 片段含非 user 角色（扩窗带出的 Assistant/Notice/Tool）时在标题行内附加自指说明，
        // 防模型把自己的历史回复当他人发言引用（自我强化事故的入口形态）。
        // 刻意并入标题行而非另起一行：本块会被 memoryTokenBudget 按字符比例掐尾截断，
        // 多一行说明会在预算贴线时挤掉一条真实记忆（实测 8→7 条）。
        const hasNonUser = sortedAll.some(({ msg }) => msg.role !== 'user');
        const selfNote = hasNonUser ? '；标注 Assistant·你自己 的条目是你自己当时的回复' : '';

        // 收口句与 memory-history 同构：本块落在历史转录之后（turn-context 槽），
        // 双向夹住可降低模型把检索片段当续写素材、串上别的会话腔调的风险。
        return (
          `以下是从长期记忆中检索到的相关聊天记录片段（可能跨会话/跨群），按时间顺序呈现${selfNote}，仅供参考：\n` +
          lines.join('\n') +
          '\n（以上为检索片段结束；它们早于当前对话，不是正在进行的聊天。）'
        );
      } catch (err) {
        if (data.signal?.aborted) return null;
        logger.use.warn('向量记忆检索失败:', err);
        return null;
      }
    },
  });

  // === 工具：主动语义召回 ===
  // LLM 可在判断"被动注入不够用"时主动调用，按任意 query 检索
  tools.use.register({
    definition: {
      type: 'function',
      function: {
        name: 'memory_recall',
        description:
          '从长期向量记忆中检索与某个关键词或问题相关的历史对话片段。' +
          '适用场景：用户提到「上次」「以前」「之前」等指代；' +
          '你需要核实自己或某个用户过往说过/承诺过什么；' +
          '当前对话上下文不足以回答而你怀疑历史里有线索时。' +
          '注意：每轮对话开始前已自动注入了 topK 条相关命中，请勿重复调用。' +
          '只在默认注入信息不足或需要换关键词重查时才使用本工具。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '检索关键词或自然语言问题。建议提炼成短句而非整段文本。',
            },
            topK: {
              type: 'number',
              description: `返回条数。默认 ${cfg.search.topK}，最多 15。`,
            },
            scope: {
              type: 'string',
              enum: ['session', 'platform', 'all'],
              description:
                'session=仅当前会话；platform=同平台所有会话；all=全部。' +
                '默认按这个会话的跨会话检索模式（同用户加权档下，当前用户本人发言或被 @ 的记录优先）。' +
                '为安全起见，scope 只能比它更窄，不能更宽。',
            },
            contextWindow: {
              type: 'number',
              description:
                `命中后是否再取该消息在原会话中前后 N 条相邻消息（含 user/assistant/system/tool）还原情景。` +
                `0 = 仅命中本身。建议 2~5。负数会报错。` +
                `默认沿用插件配置（当前=${cfg.contextExpand.window}），且最终值不会超过插件上限。`,
            },
            crossSession: {
              type: 'boolean',
              description:
                '若命中消息来自其他会话（user/all 模式可能发生），是否对那个会话也取上下文。' +
                `默认沿用插件配置（当前=${cfg.contextExpand.crossSession}）；若插件已禁用则本参数传 true 也无效。`,
            },
          },
          required: ['query'],
        },
      },
    },
    // 读=信息暴露向量（可含跨会话日志/记忆），等级 1 起可用，挡住 0 级；不弹确认
    risk: 'sensitive',
    handler: async (args, callCtx): Promise<string> => {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'query 不能为空' });

      const requestedTopK = Math.min(15, Math.max(1, Number(args.topK) || cfg.search.topK));
      const requestedScope = args.scope as Visibility | undefined;

      // contextWindow：默认沿用插件配置；提供时校验非负整数，取 min(cfg, requested)
      let effectiveWindow = cfg.contextExpand.window;
      if (args.contextWindow !== undefined && args.contextWindow !== null) {
        const w = Number(args.contextWindow);
        if (!Number.isFinite(w) || w < 0 || !Number.isInteger(w)) {
          return JSON.stringify({ error: 'contextWindow 必须是非负整数（0 表示仅命中本身）' });
        }
        effectiveWindow = Math.min(cfg.contextExpand.window, Math.floor(w));
      }
      // crossSession：取 cfg AND requested（任一为 false 都收紧到 false）
      const effectiveCrossSession =
        cfg.contextExpand.crossSession && (args.crossSession === undefined ? true : Boolean(args.crossSession));

      const curSessionId = callCtx.sessionId;
      const curPlatform = currentPlatformOf(curSessionId, callCtx.platform);

      // scope 收紧规则：这个会话的跨会话检索模式先映成**可见范围**，再与请求取较窄者。
      // 两者不能共用一张 rank 表：user 档是「全库可见 + 同用户加权」，作为加权策略它
      // 排在 platform 之前，于是「显式请求 platform」会被静默放宽回 all——与工具描述
      // 承诺的「scope 只能更窄」相反。
      const mode = modeOf(curSessionId, callCtx.platform);
      const allowedScope = mode.visibility;
      const effectiveScope: Visibility =
        requestedScope && VISIBILITY_RANK[requestedScope] < VISIBILITY_RANK[allowedScope]
          ? requestedScope
          : allowedScope;

      try {
        const storeSize = await vectorstore.use.size();
        if (storeSize === 0) {
          return JSON.stringify({ ok: true, query, results: [], message: '向量库为空' });
        }

        const provider = pinned(embedding);
        const { modelId } = provider;
        const queryVec = await provider.embed(query, { signal: callCtx.signal });
        // 与被动注入同一排序：user 档对调用者本人相关的命中同样加权（scope 收紧后照旧）。调用者是物理发言者，这一轮几个人说话时
        // 没有，不加权（被动注入按各条输入的发言者加权）
        const ranked = await rankCandidates(
          queryVec,
          modelId,
          Math.min(requestedTopK * candidateOversample, storeSize),
          {
            visibility: effectiveScope,
            curSessionId,
            curPlatform,
            boostUserIds: mode.userBoost && callCtx.userId ? [callCtx.userId] : [],
          },
        );

        const top = ranked.slice(0, requestedTopK);
        if (top.length === 0) {
          return JSON.stringify({ ok: true, query, results: [], message: '无命中' });
        }

        // 为每个命中按 sessionId 取 ±W 条相邻消息（情景扩展）
        // 仅当 effectiveWindow > 0 且 memory 服务支持范围查询时启用
        type CtxEntry = { ts: number; role: string; text: string };
        const contextBySessionPivot = new Map<string, CtxEntry[]>(); // key = `${sid}|${ts}`
        if (effectiveWindow > 0) {
          const windows = await loadPivotWindows(top, effectiveCrossSession, curSessionId, callCtx.signal);
          for (const [sid, { sorted, idxByPivot }] of windows) {
            for (const [pivotTs, idx] of idxByPivot) {
              if (idx < 0) continue;
              const start = Math.max(0, idx - effectiveWindow);
              const end = Math.min(sorted.length, idx + effectiveWindow + 1);
              const ctxArr: CtxEntry[] = [];
              for (let i = start; i < end; i++) {
                if (i === idx) continue; // 命中本身不重复
                const m = sorted[i];
                if (!m.content) continue;
                // 指令类（代发任务、宿主通知）不是任何人的发言，不随邻居带出
                if (DIRECTIVE_KINDS.includes(m.kind ?? '')) continue;
                ctxArr.push({
                  ts: m.timestamp ?? 0,
                  role: m.role,
                  text: renderMessage(m, cfg.search.perItemMaxChars, typeLabel),
                });
              }
              if (ctxArr.length > 0) contextBySessionPivot.set(`${sid}|${pivotTs}`, ctxArr);
            }
          }
        }

        const results = top.map(r => {
          const m: Message = {
            role: ((r.metadata.role as Message['role']) ?? 'user') as Message['role'],
            content: (r.metadata.content as string) ?? '',
            timestamp: (r.metadata.timestamp as number) ?? 0,
            name: r.metadata.userId as string | undefined,
            metadata: r.metadata,
          };
          const sid = r.metadata.sessionId as string;
          const ts = (r.metadata.timestamp as number) ?? 0;
          const ctxArr = contextBySessionPivot.get(`${sid}|${ts}`);
          const base: Record<string, unknown> = {
            score: Number(r.finalScore.toFixed(4)),
            text: renderMessage(m, cfg.search.perItemMaxChars, typeLabel),
            sessionId: sid,
          };
          if (ctxArr && ctxArr.length > 0) {
            base.context = ctxArr.map(c => ({ role: c.role, text: c.text }));
          }
          return base;
        });

        return JSON.stringify({
          ok: true,
          query,
          scope: effectiveScope,
          contextWindow: effectiveWindow,
          crossSession: effectiveCrossSession,
          count: results.length,
          results,
        });
      } catch (err) {
        // 回合被停下（停止键、禁言、停机等）不是检索故障，与被动注入同样不告警
        if (callCtx.signal?.aborted) return JSON.stringify({ error: '回合已中止' });
        const msg = err instanceof Error ? err.message : String(err);
        logger.use.warn(`memory_recall 失败: ${msg}`);
        return JSON.stringify({ error: `检索失败: ${msg}` });
      }
    },
  });
}
