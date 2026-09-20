import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { embedding } from '@aalis/api-embedding';
import { memory } from '@aalis/api-memory';
import { tools } from '@aalis/api-tools';
import { vectorstore } from '@aalis/api-vectorstore';
import {
  type BoundOf,
  config,
  contributions,
  definePlugin,
  defineService,
  events,
  hooks,
  logger,
  optional,
  provide,
} from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import type { IncomingMessage, Message } from '@aalis/schema-message';
import { prefixSender, WellKnownKinds } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';

// ===== 插件元数据 =====

const configSchema: ConfigSchema = {
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
        description: '0 = 仅命中本身。建议 2~5。负数会报错',
      },
      crossSession: {
        type: 'boolean',
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
  crossSessionMode: {
    type: 'select',
    label: '跨会话检索模式',
    default: 'all',
    description: '控制向量记忆的跨会话可见范围',
    options: [
      { label: '不互通（仅当前会话）', value: 'isolated' },
      { label: '同用户增强（跨会话，同用户加权）', value: 'user' },
      { label: '同平台（仅相同平台的会话）', value: 'platform' },
      { label: '全部打通（所有平台所有会话）', value: 'all' },
    ],
  },
};

// ===== 配置 =====

type CrossSessionMode = 'isolated' | 'user' | 'platform' | 'all';

interface VectorMemoryConfig {
  search: {
    topK: number;
    timeWeight: number;
    userPriorityBoost: number;
    perItemMaxChars: number;
    minScore: number;
  };
  contextExpand: {
    window: number;
    crossSession: boolean;
  };
  indexing: {
    concurrency: number;
    maxQueueSize: number;
  };
  crossSessionMode: CrossSessionMode;
  recallRoles: 'all' | 'others-only';
}

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

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function parsePlatform(sessionId: string): string {
  return sessionId.split(':')[0] ?? '';
}

/** 从消息文本中抽取 @提及的用户 ID（各 adapter 输出统一 <at id="X"> 标签） */
function extractMentions(text: string): string[] {
  if (!text) return [];
  const ids = new Set<string>();
  const re = /<at(?:\s+self)?\s+id="([^"]+)">/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const id = m[1];
    if (id && id !== 'all') ids.add(id);
    m = re.exec(text);
  }
  return [...ids];
}

/** 人可读的平台名（cli 不叠加避免噪音） */
function platformLabel(platform: string | undefined): string {
  if (!platform || platform === 'cli') return '';
  return platform;
}

/** 剖掉 agent 在某条消息开头注入的临时时间标签（如 "(刚刚) " / "(3 分钟前) "）。
 * 只剖首个括号对，保留后续内容（包括 [发送者] 前缀）。
 */
function stripTimeLabel(content: string): string {
  if (!content) return content;
  return content.replace(/^\([^)]{1,16}\)\s+/, '');
}

/** 渲染一条消息为可读文本（含来源标签）。
 *
 * 角色标注（只标注、不过滤——检索与扩窗集合不变，召回率不受影响）：
 * 邻居扩窗从 memory 拉的是**全角色**消息，assistant/tool/notice 此前一律渲染成与
 * 真人发言同构的形态（连昵称/ID 标签都带）——AI 自己的台词以「群成员发言实录」
 * 口吻按语义相关度回流，正是「戳戳月卡」自我强化事故的机制。角色词根取
 * memory-history 的 Assistant/Notice，assistant 额外缀「你自己」强化自指
 * （tool 在彼处不渲染，此处自定）。 */
function renderMessage(m: Message, max: number): string {
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const ts = m.timestamp ?? 0;
  const date = new Date(ts).toLocaleString('zh-CN');

  const userId = (meta.userId as string | undefined) ?? m.name ?? '';
  const nickname = meta.nickname as string | undefined;
  const groupName = meta.groupName as string | undefined;
  const platform = platformLabel(meta.platform as string | undefined);
  const sessionType = meta.sessionType as string | undefined;

  // 位置描述：优先群名、其次会话类型
  let where = '';
  if (groupName) {
    where = `群「${groupName}」/`;
  } else if (sessionType === 'private') {
    where = '私聊/';
  } else if (sessionType === 'channel') {
    where = '频道/';
  }
  // 平台前缀
  const platformPrefix = platform ? `${platform}/` : '';

  let who: string;
  let cleanContent = m.content ?? '';
  if (m.role === 'assistant') {
    who = `Assistant·你自己${nickname ? `(${nickname})` : ''}`;
  } else if (m.role === 'notice') {
    who = 'Notice';
  } else if (m.role === 'tool') {
    who = 'Tool·工具结果';
  } else {
    who = nickname ? `${nickname}${userId ? `(${userId})` : ''}` : userId;
    // 剥掉 archive 给入站 user 消息加的 [昵称(ID)]: 前缀（tag 已表达身份，避免双重前缀）。
    // 只对 user 剥：assistant/tool 内容若以 [xxx]: 开头那是正文自身的一部分，剥了会吞标记。
    cleanContent = cleanContent.replace(/^\[[^\]]{1,80}\]:\s+/, '');
  }
  const tag = `[${platformPrefix}${where}${who}${who ? ' ' : ''}@ ${date}]`;

  return `${tag} ${truncate(cleanContent, max)}`;
}

/** 渲染向量命中（user 或 assistant，按 metadata.role 还原；存量旧向量无 role 按 user）。 */
function renderMemoryEntry(m: Message, messageMax: number): string {
  return renderMessage(m, messageMax);
}

/** 存量委派 META 噪音判据（精确形态）：曾有 proactive 委派文本入库（新增已在索引侧
 * 挡住），它们是 AI 撰写、无 userId，被语义命中会以匿名人形行回流——检索期整体剔除。 */
function isLegacyDelegateMeta(meta: Record<string, unknown>): boolean {
  return String(meta.content ?? '').startsWith('[跨会话委派 META]');
}

/** 给消息生成稳定 key 用于跨命中去重（sessionId + timestamp + role） */
function messageKey(sessionId: string, m: Message): string {
  // 不含 content：同一逻辑消息（同 sid+ts+role）不因文本形态差异（存量向量的 metadata.content
  // 无发送者前缀，真消息有）分裂成两个 key，避免扩展路径与兜底对同一 pivot 各注入一次造成可见重复。
  return `${sessionId}|${m.timestamp ?? 0}|${m.role}`;
}

// ----- 服务类型注册（declaration merging）-----
// `semantic-memory` 是**能力标记**而非查询 API：它只声明「本实例具备语义检索能力」，
// 供依赖声明与拓扑排序识别，以及消费方做能力探测。语义检索本身经工具与
// memory 契约走，不从这里取。如实声明它的真实形状，不臆造一个没人实现的查询接口。
// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
/** 存在性标记服务：只表明「语义记忆已就绪」，检索本身走 memory 契约 */
export const semanticMemory = defineService<{ name: string }>('semantic-memory');

// ===== 插件入口 =====

const uses = {
  vectorstore,
  embedding,
  memory: optional(memory),
  tools: optional(tools),
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

async function run({
  vectorstore,
  embedding,
  memory,
  tools,
  events,
  hooks,
  contributions,
  provide,
  logger,
  config,
}: Caps): Promise<void> {
  // memory 是可选依赖，provider 换人不级联 bounce 本插件：引用与能力探测都必须在调用点现算，
  // 否则 provider 晚于本插件注册时 hasRangeQuery 永久为假，或扩窗落在已关闭的旧实例上。
  function hasRangeQuery(): boolean {
    return !!memory.current?.getMessagesBySessionRange;
  }

  const searchRaw = (config.search ?? {}) as Record<string, unknown>;
  const expandRaw = (config.contextExpand ?? {}) as Record<string, unknown>;
  const indexingRaw = (config.indexing ?? {}) as Record<string, unknown>;

  // 配置校验
  const windowRaw = expandRaw.window;
  const windowNum = typeof windowRaw === 'number' ? windowRaw : Number(windowRaw ?? 2);
  if (Number.isNaN(windowNum) || !Number.isFinite(windowNum)) {
    throw new Error(
      'memory-vector 配置错误: contextExpand.window 必须为非负整数（0 表示仅命中本身，N>0 表示前后各 N 条）',
    );
  }
  if (windowNum < 0) {
    throw new Error(`memory-vector 配置错误: contextExpand.window=${windowNum} 不能为负数`);
  }
  if (!Number.isInteger(windowNum)) {
    throw new Error(`memory-vector 配置错误: contextExpand.window=${windowNum} 必须是整数`);
  }

  const cfg: VectorMemoryConfig = {
    search: {
      topK: (searchRaw.topK as number) ?? 5,
      timeWeight: Math.max(0, Math.min(1, (searchRaw.timeWeight as number) ?? 0.3)),
      userPriorityBoost: Math.max(1, (searchRaw.userPriorityBoost as number) ?? 2.0),
      perItemMaxChars: Math.max(0, (searchRaw.perItemMaxChars as number) ?? 0),
      minScore: Math.max(0, Math.min(1, (searchRaw.minScore as number) ?? 0)),
    },
    contextExpand: {
      window: Math.floor(windowNum),
      crossSession: expandRaw.crossSession !== false,
    },
    indexing: {
      concurrency: Math.floor((indexingRaw.concurrency as number) ?? 10),
      maxQueueSize: Math.floor((indexingRaw.maxQueueSize as number) ?? 500),
    },
    crossSessionMode: (config.crossSessionMode as CrossSessionMode) ?? 'all',
    recallRoles: (config.recallRoles as 'all' | 'others-only') ?? 'all',
  };

  // 启动日志与下方 warn 都是启动时刻的快照（此后按调用点现算，不再据此判定）
  logger.info(
    `向量记忆已启动: ${await vectorstore.require().size()} 条向量, 范围查询=${hasRangeQuery() ? '可用' : '不可用'}, ` +
      `userBoost=${cfg.search.userPriorityBoost}, expandWindow=${cfg.contextExpand.window}, ` +
      `单条截断=${cfg.search.perItemMaxChars > 0 ? `${cfg.search.perItemMaxChars}字` : '不截断'}, minScore=${cfg.search.minScore}, ` +
      `indexConcurrency=${cfg.indexing.concurrency <= 0 ? 'unlimited' : cfg.indexing.concurrency}, ` +
      `indexQueue=${cfg.indexing.maxQueueSize <= 0 ? 'unlimited' : cfg.indexing.maxQueueSize}`,
  );

  if (!hasRangeQuery() && cfg.contextExpand.window > 0) {
    logger.warn('当前 memory 后端不支持范围查询，contextExpand 将退化为仅命中本身');
  }

  provide(semanticMemory, { name: 'vector-memory' });

  /** 候选准入（两条检索管线共用）：剔存量委派 META 噪音；others-only 档过滤 AI 自身发言。
   * 存量旧向量无 role 字段 → 不等于 'assistant' → 按对方对待。 */
  function candidateAdmissible(meta: Record<string, unknown>): boolean {
    if (isLegacyDelegateMeta(meta)) return false;
    if (cfg.recallRoles === 'others-only' && meta.role === 'assistant') return false;
    return true;
  }

  // === 索引：入站 user 消息 + assistant 落库回复，触发即写 ===

  /** 待索引项：user 带归档消息（文本与时间戳都以落库形态为准）；assistant 自带 */
  type PendingIndexItem =
    | { kind: 'user'; msg: IncomingMessage; archived: Message }
    | { kind: 'assistant'; sessionId: string; message: Message };
  const pendingIndexMessages: PendingIndexItem[] = [];
  let activeIndexers = 0;

  function enqueueIndexMessage(item: PendingIndexItem): void {
    pendingIndexMessages.push(item);
    if (cfg.indexing.maxQueueSize > 0 && pendingIndexMessages.length > cfg.indexing.maxQueueSize) {
      const dropped = pendingIndexMessages.splice(0, pendingIndexMessages.length - cfg.indexing.maxQueueSize).length;
      logger.warn(`向量索引队列过长，已丢弃 ${dropped} 条最旧待索引消息`);
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
          if (next.kind === 'user') await indexUserMessage(next.msg, next.archived);
          else await indexAssistantMessage(next.sessionId, next.message);
        } finally {
          activeIndexers--;
          void drainIndexQueue();
        }
      })();
    }
  }

  async function indexUserMessage(msg: IncomingMessage, archived: Message): Promise<void> {
    // 跳过非真实用户输入：闲聊主动触发（source 判据）与 proactive 伪 incoming
    //（triggerType 判据；全仓生产者=跨会话委派 + workflow agent 节点，内容是 AI 撰写的
    // 任务与 META 文本），不应进入向量库——AI 生成文本被语义命中后会以「历史用户发言」
    // 形态回流。存量 META 由检索侧 isLegacyDelegateMeta 剔除。
    if (msg.source === 'idle-trigger') return;
    if (msg.triggerType === 'proactive') return;
    // 2026-08-28 用户裁定「三条全堵」：以下伪 incoming 同为 AI/系统撰写文本，不带
    // triggerType（改它们的 triggerType 会连带 message-archive 的 role 判定，故在本侧按
    // source/userId 判据堵）——scheduler 定时内容、workflow send_message 节点、subtask 派发。
    if (msg.source === 'scheduler') return;
    if (msg.source?.startsWith('workflow:')) return;
    if (msg.userId?.startsWith('parent:')) return;
    // 向量文本 = 归档文本（单一来源）：archive 已按平台规则加发送者前缀、烘入引用与
    // 附件描述。若 embed 的是 incoming.content，图片消息只剩 [图片 | ref:…] 占位符，
    // 识别出的描述从未进向量空间，图片记忆不可召回。
    const rawText = clipForEmbed(archived.content?.trim() ?? '');
    if (!rawText) return;
    // 归档写入时间戳：保证后续按时间戳精确删除（如「回滚本轮对话」）能命中向量条目
    const messageTimestamp = archived.timestamp ?? Date.now();
    try {
      const vec = await embedding.require().embed(rawText);
      const mentions = extractMentions(rawText);
      const metadata: Record<string, unknown> = {
        sessionId: msg.sessionId,
        // 前向打角色（2026-08-27 起）：存量旧向量无此字段，检索侧按 user（对方）对待
        role: 'user',
        userId: msg.userId ?? '',
        nickname: msg.nickname ?? '',
        platform: msg.platform ?? parsePlatform(msg.sessionId),
        groupName: msg.groupName ?? '',
        groupId: msg.groupId ?? '',
        sessionType: msg.sessionType ?? '',
        timestamp: messageTimestamp,
        // 兜底内容：归档文本（消息表老化后供渲染兜底；user 角色的发送者前缀由渲染侧剥除）
        content: rawText,
        // @提及到的用户 ID 列表，用于检索时同用户加权
        mentions,
      };
      await vectorstore.require().add(vec, metadata);
      await vectorstore.require().save();
    } catch (err) {
      logger.warn(`向量索引失败: ${formatError(err)}`);
    }
  }

  // 与 plugin-user-profile 等「派生持久数据」插件统一锚点：仅对已成功落库的入站消息建索引，
  // 避免归档失败的消息进入向量库，也消除归档前/后两套订阅时机的不一致。
  events.on('inbound:message:archived', data => {
    enqueueIndexMessage({ kind: 'user', msg: data.incoming, archived: data.archivedMessage });
  });

  // assistant 自身发言入库（2026-08-27，recallRoles 双模式的存储侧）：
  // 经 archive.saveMessage 落库的 assistant 回复（含 image-sender 的出站附件档案）。
  // metadata 带 role='assistant'，检索側据此过滤与标注；渲染必带「Assistant·你自己」。
  events.on('assistant:message:archived', data => {
    enqueueIndexMessage({ kind: 'assistant', sessionId: data.sessionId, message: data.message });
  });

  async function indexAssistantMessage(sessionId: string, message: Message): Promise<void> {
    const rawText = clipForEmbed(message.content?.trim() ?? '');
    if (!rawText) return;
    // 防御性冗余：EventMarker 现产者全是 role:system、被发射门先挡；此处兜第三方发射者
    if (message.kind === WellKnownKinds.EventMarker) return;
    const meta = (message.metadata ?? {}) as Record<string, unknown>;
    try {
      const nickname = (meta.nickname as string | undefined) ?? '';
      // 生产者是 plugin-agent 的 buildAssistantMetadata：自身标识写在 metadata.userId
      //（值=identity.selfId），并带 groupName/groupId/sessionType——全部透传，
      // 使 assistant 条目的渲染位置段（群「X」/私聊/）与 user 侧对齐。
      // 注意没有 metadata.selfId 这个键（2026-08-27 审计抓过一次读错字段名）。
      const selfUserId = (meta.userId as string | undefined) ?? '';
      // 与 user 侧对称：embed 带发送者前缀，身份信号入向量空间
      const embedText = prefixSender(rawText, nickname || undefined, selfUserId || undefined);
      const vec = await embedding.require().embed(embedText);
      const metadata: Record<string, unknown> = {
        sessionId,
        role: 'assistant',
        // userId=自身标识：crossSessionMode='user' 的同用户加权按调用者 userId 匹配，
        // 不会误中 bot 自身；空串与 user 侧缺省语义一致
        userId: selfUserId,
        nickname,
        platform: parsePlatform(sessionId),
        groupName: (meta.groupName as string | undefined) ?? '',
        groupId: (meta.groupId as string | undefined) ?? '',
        sessionType: (meta.sessionType as string | undefined) ?? '',
        timestamp: message.timestamp ?? Date.now(),
        content: rawText,
        mentions: extractMentions(rawText),
      };
      await vectorstore.require().add(vec, metadata);
      await vectorstore.require().save();
    } catch (err) {
      logger.warn(`assistant 向量索引失败: ${formatError(err)}`);
    }
  }

  // === 按时间戳删除向量（供 plugin-checkpoint 回滚整轮对话使用） ===
  events.on('memory:messages-deleted', async data => {
    if (!data?.sessionId || !Array.isArray(data.timestamps) || data.timestamps.length === 0) return;
    const currentStore = vectorstore.require();
    if (!currentStore.deleteByFilter) {
      logger.warn('当前向量存储不支持按条件删除，跳过 memory:messages-deleted');
      return;
    }
    let total = 0;
    for (const ts of data.timestamps) {
      try {
        total += await currentStore.deleteByFilter({ sessionId: data.sessionId, timestamp: ts });
      } catch (err) {
        logger.warn(`按时间戳删除向量失败 (ts=${ts}): ${formatError(err)}`);
      }
    }
    if (total > 0) {
      try {
        await currentStore.save();
      } catch (err) {
        logger.warn(`向量保存失败: ${formatError(err)}`);
      }
      logger.info(`回滚清除向量: session=${data.sessionId}, 删除 ${total} 条`);
    }
  });

  // === 统一记忆清除 ===

  hooks.middleware('memory:clear', async (data, next) => {
    if (data.types && !data.types.includes('vector')) {
      await next();
      return;
    }

    try {
      if (data.scope === 'all') {
        await vectorstore.require().clear();
        await vectorstore.require().save();
        data.results.push({ source: 'vector', success: true, message: '所有向量记忆已清空' });
        logger.info('向量记忆已全部清空');
      } else if (data.sessionId) {
        const currentStore = vectorstore.require();
        if (currentStore.deleteByFilter) {
          const deleted = await currentStore.deleteByFilter({ sessionId: data.sessionId });
          await currentStore.save();
          data.results.push({ source: 'vector', success: true, message: `向量记忆已清空 (${deleted} 条)` });
          logger.info(`向量记忆已清空: session=${data.sessionId}, 删除 ${deleted} 条向量`);
        } else {
          // 老实报告：不支持会话级删除时不能谎称成功（此前会 push success 且「已清空 0 条」误导用户）。
          logger.warn('当前向量存储不支持按条件删除，会话级向量清空跳过');
          data.results.push({
            source: 'vector',
            success: false,
            message: '当前向量存储不支持会话级清空，向量记忆未清除（可改用 /clear.all 或换支持按条件删除的后端）',
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      data.results.push({ source: 'vector', success: false, message: `向量清空失败: ${msg}` });
      logger.warn(`向量清空失败: ${formatError(err)}`);
    }

    await next();
  });

  // === 检索并注入上下文（agent:prompt 贡献 / turn-context 槽：按当前消息检索、每轮必变，落历史后护前缀缓存）===

  contributions.contribute('agent:prompt', {
    id: 'memory-vector',
    anchor: 'turn-context',
    async build(data) {
      // 干跑(token 快照)不做真实的 embedding+检索——那是纯统计路径的昂贵副作用
      if (data.dryRun) return null;
      data.signal?.throwIfAborted();

      const userMessages = data.messages.filter(m => m.role === 'user');
      const lastUserMsg = userMessages[userMessages.length - 1];
      if (!lastUserMsg?.content) return null;

      try {
        const mode = cfg.crossSessionMode;
        const curSessionId = data.sessionId;
        const curPlatform = data.platform ?? (curSessionId ? parsePlatform(curSessionId) : '');
        const curUserId = data.userId ?? '';

        // others-only 档过滤发生在检索后：候选池放大一倍补偿，否则 assistant 语料
        // 占比升高后对方消息会被挤出候选（2026-08-27 审计探针实测同语料 2→0 条）
        const oversample = cfg.recallRoles === 'others-only' ? 8 : 4;
        const candidateCount = Math.min(cfg.search.topK * oversample, await vectorstore.require().size());
        data.signal?.throwIfAborted();
        if (candidateCount === 0) return null;

        const queryVec = await embedding.require().embed(stripTimeLabel(lastUserMsg.content), { signal: data.signal });
        data.signal?.throwIfAborted();
        const candidates = (await vectorstore.require().search(queryVec, candidateCount)).filter(r =>
          candidateAdmissible(r.metadata),
        );
        data.signal?.throwIfAborted();

        // 1. 阈值过滤
        const passThreshold = candidates.filter(c => c.score >= cfg.search.minScore);

        // 2. 跨会话模式过滤
        const filtered = passThreshold.filter(c => {
          switch (mode) {
            case 'isolated':
              return c.metadata.sessionId === curSessionId;
            case 'platform':
              return (
                (c.metadata.platform as string) === curPlatform ||
                parsePlatform(c.metadata.sessionId as string) === curPlatform
              );
            default:
              return true;
          }
        });

        // 3. 时间加权 + 同用户加权（作者匹配 或 当前用户被 @提及，均享 boost）
        const now = Date.now();
        const ranked = filtered.map(c => {
          let score =
            (1 - cfg.search.timeWeight) * c.score +
            cfg.search.timeWeight * recencyScore((c.metadata.timestamp as number) ?? 0, now);
          if (mode === 'user' && curUserId) {
            const isAuthor = (c.metadata.userId as string) === curUserId;
            const mentions = c.metadata.mentions as string[] | undefined;
            const isMentioned = Array.isArray(mentions) && mentions.includes(curUserId);
            if (isAuthor || isMentioned) {
              score *= cfg.search.userPriorityBoost;
            }
          }
          return { ...c, finalScore: score };
        });
        ranked.sort((a, b) => b.finalScore - a.finalScore);

        const topResults = ranked.slice(0, cfg.search.topK);
        if (topResults.length === 0) return null;

        // 4. 命中点 + 上下文窗口扩展（合并区间，去重）
        const W = cfg.contextExpand.window;
        const collected = new Map<string, { sessionId: string; msg: Message }>();
        // sid|ts 占位集：messageKey 含 role，扩窗路径（真实 role，如委派落的 notice）与
        // 兜底路径（强制 user）会对同一逻辑消息各持一 key、双份注入——兜底以此集判断
        // 该 (sid,ts) 是否已被任一角色覆盖（2026-08-27 审计 blocker）。
        const collectedSidTs = new Set<string>();
        const markSidTs = (sid: string, ts: number | undefined) => collectedSidTs.add(`${sid}|${ts ?? 0}`);

        // 当前对话已有的内容用于去重（只比较纯文本）
        const currentContents = new Set(data.messages.map(m => (m.content ?? '').trim()).filter(Boolean));

        // 按 sessionId 聚合命中点的时间戳，决定每个会话需要拉取的时间窗口
        const sessionPivots = new Map<string, number[]>();
        for (const r of topResults) {
          const sid = r.metadata.sessionId as string | undefined;
          const ts = r.metadata.timestamp as number | undefined;
          if (!sid || ts === undefined) continue;
          if (!cfg.contextExpand.crossSession && sid !== curSessionId) {
            // 不允许跨会话扩展时，对非当前会话只放入命中点本身（走兜底分支）
            continue;
          }
          const arr = sessionPivots.get(sid) ?? [];
          arr.push(ts);
          sessionPivots.set(sid, arr);
        }

        // 拉取每个会话的扩展消息
        const mem = memory.current;
        if (W > 0 && mem?.getMessagesBySessionRange) {
          for (const [sid, pivots] of sessionPivots) {
            data.signal?.throwIfAborted();
            // 用宽时间窗一次拉，再按 pivot 切片合并（避免多次小查询）
            const minTs = Math.min(...pivots);
            const maxTs = Math.max(...pivots);
            // 4 小时缓冲，足以覆盖 N=数十条邻居的常见场景
            const bufferMs = 4 * 60 * 60 * 1000;
            try {
              const all = await mem.getMessagesBySessionRange(sid, minTs - bufferMs, maxTs + bufferMs);
              data.signal?.throwIfAborted();
              const sorted = all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

              // 对每个 pivot 在 sorted 中定位并取 ±W 条
              for (const pivotTs of pivots) {
                const pivotIdx = sorted.findIndex(m => (m.timestamp ?? 0) === pivotTs && m.role === 'user');
                const idx = pivotIdx >= 0 ? pivotIdx : sorted.findIndex(m => (m.timestamp ?? 0) === pivotTs);
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
                  if (m.kind === WellKnownKinds.EventMarker) continue;
                  if (currentContents.has((m.content ?? '').trim())) continue;
                  const key = messageKey(sid, m);
                  if (!collected.has(key)) {
                    collected.set(key, { sessionId: sid, msg: m });
                    markSidTs(sid, m.timestamp);
                  }
                }
              }
            } catch (err) {
              data.signal?.throwIfAborted();
              logger.warn(`扩展上下文失败 (session=${sid}): ${err instanceof Error ? err.message : String(err)}`);
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
          // 该 (sid,ts) 已被扩窗以真实角色收录（可能非 user，如委派 notice）→ 不再造 user 拷贝
          if (collectedSidTs.has(`${sid}|${ts}`)) continue;
          const key = messageKey(sid, fakeMsg);
          if (!collected.has(key)) collected.set(key, { sessionId: sid, msg: fakeMsg });
        }

        if (collected.size === 0) return null;

        // 5. 按时间排序混排
        const sortedAll = [...collected.values()].sort((a, b) => (a.msg.timestamp ?? 0) - (b.msg.timestamp ?? 0));

        const lines = sortedAll.map(({ msg }) => renderMemoryEntry(msg, cfg.search.perItemMaxChars));

        // 片段含非 user 角色（扩窗带出的 Assistant/Notice/Tool）时在标题行内附加自指说明，
        // 防模型把自己的历史回复当他人发言引用（自我强化事故的入口形态）。
        // 刻意并入标题行而非另起一行：本块会被 memoryTokenBudget 按字符比例掐尾截断，
        // 多一行说明会在预算贴线时挤掉一条真实记忆（2026-08-27 审计实测 8→7 条）。
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
        logger.warn(`向量记忆检索失败: ${formatError(err)}`);
        return null;
      }
    },
  });

  // === 工具：主动语义召回 ===
  // LLM 可在判断"被动注入不够用"时主动调用，按任意 query 检索
  tools.register({
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
                `默认沿用插件配置（当前=${cfg.crossSessionMode}）。` +
                '为安全起见，scope 只能比插件配置更窄，不能更宽。',
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
    // 读=信息暴露向量（可含跨会话日志/记忆），朋友档挡 level-0；不弹确认
    risk: 'sensitive',
    handler: async (args, callCtx): Promise<string> => {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'query 不能为空' });

      const requestedTopK = Math.min(15, Math.max(1, Number(args.topK) || cfg.search.topK));
      const requestedScope = args.scope as 'session' | 'platform' | 'all' | undefined;

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

      // scope 收紧规则：先把 crossSessionMode 映成**可见范围**，再与请求取较窄者。
      // 两者不能共用一张 rank 表：user 档是「全库可见 + 同用户加权」，作为加权策略它
      // 排在 platform 之前，于是「显式请求 platform」会被静默放宽回 all——与工具描述
      // 承诺的「scope 只能更窄」相反。
      const visibilityRank: Record<'session' | 'platform' | 'all', number> = { session: 0, platform: 1, all: 2 };
      const cfgVisibility: 'session' | 'platform' | 'all' =
        cfg.crossSessionMode === 'isolated' ? 'session' : cfg.crossSessionMode === 'platform' ? 'platform' : 'all';
      const effectiveScope: 'session' | 'platform' | 'all' =
        requestedScope && visibilityRank[requestedScope] < visibilityRank[cfgVisibility]
          ? requestedScope
          : cfgVisibility;

      const curSessionId = callCtx.sessionId;
      const curPlatform = callCtx.platform ?? (curSessionId ? parsePlatform(curSessionId) : '');

      try {
        const storeSize = await vectorstore.require().size();
        if (storeSize === 0) {
          return JSON.stringify({ ok: true, query, results: [], message: '向量库为空' });
        }

        const queryVec = await embedding.require().embed(query);
        const toolOversample = cfg.recallRoles === 'others-only' ? 8 : 4;
        const candidates = (
          await vectorstore.require().search(queryVec, Math.min(requestedTopK * toolOversample, storeSize))
        ).filter(r => candidateAdmissible(r.metadata));

        const passThreshold = candidates.filter(c => c.score >= cfg.search.minScore);

        const filtered = passThreshold.filter(c => {
          if (effectiveScope === 'session') return c.metadata.sessionId === curSessionId;
          if (effectiveScope === 'platform') {
            return (
              (c.metadata.platform as string) === curPlatform ||
              parsePlatform(c.metadata.sessionId as string) === curPlatform
            );
          }
          return true;
        });

        const now = Date.now();
        const ranked = filtered.map(c => {
          const score =
            (1 - cfg.search.timeWeight) * c.score +
            cfg.search.timeWeight * recencyScore((c.metadata.timestamp as number) ?? 0, now);
          return { ...c, finalScore: score };
        });
        ranked.sort((a, b) => b.finalScore - a.finalScore);

        const top = ranked.slice(0, requestedTopK);
        if (top.length === 0) {
          return JSON.stringify({ ok: true, query, results: [], message: '无命中' });
        }

        // 为每个命中按 sessionId 取 ±W 条相邻消息（情景扩展）
        // 仅当 effectiveWindow > 0 且 memory 服务支持范围查询时启用
        type CtxEntry = { ts: number; role: string; text: string };
        const contextBySessionPivot = new Map<string, CtxEntry[]>(); // key = `${sid}|${ts}`
        const mem = memory.current;
        if (effectiveWindow > 0 && mem?.getMessagesBySessionRange) {
          // 按 sessionId 聚合 pivots
          const sessionPivots = new Map<string, number[]>();
          for (const r of top) {
            const sid = r.metadata.sessionId as string | undefined;
            const ts = r.metadata.timestamp as number | undefined;
            if (!sid || ts === undefined) continue;
            if (!effectiveCrossSession && sid !== curSessionId) continue;
            const arr = sessionPivots.get(sid) ?? [];
            arr.push(ts);
            sessionPivots.set(sid, arr);
          }

          for (const [sid, pivots] of sessionPivots) {
            const minTs = Math.min(...pivots);
            const maxTs = Math.max(...pivots);
            const bufferMs = 4 * 60 * 60 * 1000; // 4h 缓冲，足以覆盖 W=10 邻居
            try {
              const all = await mem.getMessagesBySessionRange(sid, minTs - bufferMs, maxTs + bufferMs);
              const sorted = all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
              for (const pivotTs of pivots) {
                const pivotIdx = sorted.findIndex(m => (m.timestamp ?? 0) === pivotTs && m.role === 'user');
                const idx = pivotIdx >= 0 ? pivotIdx : sorted.findIndex(m => (m.timestamp ?? 0) === pivotTs);
                if (idx < 0) continue;
                const start = Math.max(0, idx - effectiveWindow);
                const end = Math.min(sorted.length, idx + effectiveWindow + 1);
                const ctxArr: CtxEntry[] = [];
                for (let i = start; i < end; i++) {
                  if (i === idx) continue; // 命中本身不重复
                  const m = sorted[i];
                  if (!m.content) continue;
                  if (m.kind === WellKnownKinds.EventMarker) continue;
                  ctxArr.push({
                    ts: m.timestamp ?? 0,
                    role: m.role,
                    text: renderMemoryEntry(m, cfg.search.perItemMaxChars),
                  });
                }
                if (ctxArr.length > 0) contextBySessionPivot.set(`${sid}|${pivotTs}`, ctxArr);
              }
            } catch (err) {
              logger.warn(
                `memory_recall 上下文扩展失败 (session=${sid}): ${err instanceof Error ? err.message : String(err)}`,
              );
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
            text: renderMemoryEntry(m, cfg.search.perItemMaxChars),
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
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`memory_recall 失败: ${msg}`);
        return JSON.stringify({ error: `检索失败: ${msg}` });
      }
    },
  });
}
