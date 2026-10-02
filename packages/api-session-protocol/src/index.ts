/**
 * @aalis/api-session-protocol — 会话协议（实验性）
 *
 * owner 的客户端（WebUI，以后还有终端）与守护进程之间的线上格式：JSON-RPC 2.0 帧、握手、错误码，会话列表与增量、
 * 订阅与条目、回合控制、在场与审批。帧与参数都写成 zod schema，类型由 schema 推导：服务端按它校验收到的帧，客户端照它实现。
 * 本包只有 schema、协议版本与服务描述符 `sessionProtocol`；实现见 @aalis/plugin-session-server，
 * 传输（WebSocket 等）由宿主插件接到 `sessionProtocol.connect`。
 *
 * 第一版标 experimental：终端客户端接入之前允许不兼容的修改，之后只做加法，加字段升次版本。
 * 对象 schema 不拒多余的键，旧客户端读到新加的字段照常解析。
 */

import type { ApprovalSurface } from '@aalis/api-approval';
import { defineService } from '@aalis/core';
import { z } from 'zod';

/** 协议版本 `<主>.<次>`：握手时主版本不同即断开 */
export const SESSION_PROTOCOL_VERSION = '1.0';

// ════════════════════════════════════════════════════════════
// 帧（JSON-RPC 2.0）
// ════════════════════════════════════════════════════════════

const RpcIdSchema = z.union([z.string(), z.number().int()]);
/** 参数与结果一律是对象（按名传参） */
const RpcObjectSchema = z.object({}).passthrough();

/** 客户端发来的请求：带 id，服务端必回一帧结果或错误 */
export const RequestFrameSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RpcIdSchema,
  method: z.string(),
  params: RpcObjectSchema.optional(),
});

/** 成功的回应 */
export const ResultFrameSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RpcIdSchema,
  result: RpcObjectSchema,
});

/**
 * 业务错误码，放在错误帧的 `error.data.code`：
 * - `not-found`：会话等对象不存在；
 * - `forbidden`：这条连接的身份不能做这件事；
 * - `conflict`：与当前状态冲突；
 * - `approval-settled`、`hash-mismatch`：审批已结算、应答的内容哈希对不上；
 * - `expected-turn-mismatch`：`turn/abort` 带的回合 id 不是正在跑的那一轮；
 * - `unsupported`：协议版本不兼容，或服务端不支持这项操作。
 */
export const ErrorCodeSchema = z.enum([
  'not-found',
  'forbidden',
  'conflict',
  'approval-settled',
  'hash-mismatch',
  'expected-turn-mismatch',
  'unsupported',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * 错误帧的数值码。前五个是 JSON-RPC 的标准码，帧本身或参数不合时用；业务错误一律用 `applicationError`，
 * 具体原因看 `error.data.code`。认不出请求 id（不是 JSON、缺 id）时错误帧的 id 为 null。
 */
export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  applicationError: -32000,
} as const;

/** 失败的回应 */
export const ErrorFrameSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RpcIdSchema.nullable(),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.object({ code: ErrorCodeSchema }).optional(),
  }),
});

/** 服务端推送：不带 id，客户端不回 */
export const NotificationFrameSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: RpcObjectSchema,
});

const EmptySchema = z.object({});

// ════════════════════════════════════════════════════════════
// 握手
// ════════════════════════════════════════════════════════════

/** 连接所代表的身份（平台与用户 id），由传输层认证后给出 */
export const IdentitySchema = z.object({ platform: z.string(), userId: z.string() });
export type Identity = z.infer<typeof IdentitySchema>;

export const InitializeParamsSchema = z.object({
  protocolVersion: z.string().regex(/^\d+\.\d+$/),
  client: z.object({ name: z.string(), version: z.string() }),
});

export const InitializeResultSchema = z.object({
  protocolVersion: z.string(),
  experimental: z.literal(true),
  server: z.object({ name: z.string() }),
  identity: IdentitySchema,
  /** 这条连接所在审批面的登记名（webui、cli）；审计记的是登记身份 */
  surface: z.string(),
});

// ════════════════════════════════════════════════════════════
// 会话与列表
// ════════════════════════════════════════════════════════════

/** 列表的分区：owner 是「我的」会话，rooms 是 IM 房间；子会话归在根会话的区里 */
export const SessionSectionSchema = z.enum(['owner', 'rooms']);
export type SessionSection = z.infer<typeof SessionSectionSchema>;

/** 会话摘要：列表一行所需的全部字段 */
export const SessionSummarySchema = z.object({
  id: z.string(),
  /** 标题，没有时是会话名 */
  title: z.string(),
  parentId: z.string().optional(),
  childCount: z.number().int().nonnegative(),
  /** room 是聊天用的会话（IM 房间与 owner 自己的会话），task 是子任务 */
  kind: z.enum(['room', 'task']),
  section: SessionSectionSchema,
  /** 出生平台；owner 自己的会话没有 */
  platform: z.string().optional(),
  /** 房间：接管它的适配器实例（插件实例 id），列表按它分组；还没有适配器认领的没有 */
  instance: z.string().optional(),
  /** 房间：会话 id 里的机器人账号；同一实例带多个账号时界面据此标出 */
  account: z.string().optional(),
  /** 根会话的受众：group、private 为 IM 房间，owner 为其余 */
  audience: z.enum(['owner', 'private', 'group']).optional(),
  createdAt: z.number(),
  /** 最后活动时间：会话档案最近一次变化 */
  updatedAt: z.number(),
  /** 她最近一次开口（回合结局为 replied）的时间 */
  lastReplyAt: z.number().optional(),
  /** 有回合在跑 */
  running: z.boolean(),
  /** 最近一轮出错 */
  error: z.boolean(),
  /** 只用于「我的」区：她最近一次开口晚于 owner 上次看过（session/markSeen）；房间恒为 false */
  unread: z.boolean(),
  /** 需要我处理：有未结的审批 */
  attention: z.boolean(),
  archived: z.boolean(),
  /** 房间：生效配置是否开着白纸 */
  paper: z.boolean().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** 房间的一组：一个适配器实例一组；还没记下实例的房间按平台成一组，没有 instance */
export const RoomGroupSchema = z.object({
  platform: z.string(),
  instance: z.string().optional(),
  /** 组里的房间数 */
  rooms: z.number().int().nonnegative(),
  /** 组里房间涉及的机器人账号数 */
  accounts: z.number().int().nonnegative(),
  /** 组里需要我处理的房间数 */
  attention: z.number().int().nonnegative(),
});
export type RoomGroup = z.infer<typeof RoomGroupSchema>;

/**
 * 不给 parentId 时列根会话：「我的」区在前，按需要处理的程度（需要我处理、出错、完成未读、运行中）排在前面，其余按最后活动从新到旧；
 * 房间在后，按最后活动从新到旧。给 parentId 时列它的直接子会话，按最后活动从新到旧，不看 section。
 * query 按名称、标题、id 匹配（不分大小写），也认「平台:群号」。cursor 取上一页的 nextCursor。
 */
export const SessionsListParamsSchema = z.object({
  section: SessionSectionSchema.optional(),
  parentId: z.string().optional(),
  query: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const SessionsListResultSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  /** 还有下一页时给出 */
  nextCursor: z.string().optional(),
  /** 全部房间的分组，不受分区、搜索与分页影响 */
  groups: z.array(RoomGroupSchema),
});

/** `sessions/watch` 之后的增量：变了的会话给完整摘要，删掉的给 id，另附最新的分组 */
export const SessionsChangedParamsSchema = z.object({
  upserts: z.array(SessionSummarySchema),
  removes: z.array(z.string()),
  groups: z.array(RoomGroupSchema),
});

const SessionTargetSchema = z.object({ sessionId: z.string() });

/** 新建会话：给 parentId 时建它的子会话，复制父会话的生效配置（房间专属的键除外） */
export const SessionCreateParamsSchema = z.object({
  name: z.string().min(1).optional(),
  parentId: z.string().optional(),
});

export const SessionRenameParamsSchema = z.object({ sessionId: z.string(), title: z.string().min(1) });

/** 批量归档或删除；归档连同子会话。开始前就不存在的会话列进 failed */
export const SessionBatchParamsSchema = z.object({
  op: z.enum(['archive', 'delete']),
  ids: z.array(z.string()).min(1),
});

export const SessionBatchResultSchema = z.object({
  failed: z.array(z.object({ sessionId: z.string(), message: z.string() })),
});

// ----- 会话配置 -----

/** 会话配置的各项（与 api-session-manager 的 SessionConfig 同义） */
const sessionConfigFields = {
  llm: z.object({ provider: z.string(), model: z.string() }),
  enabledToolGroups: z.array(z.string()),
  persona: z.string(),
  think: z.boolean(),
  systemPromptExtra: z.string(),
  maxToolIterations: z.number(),
  disableOutputFormat: z.boolean(),
  clientSideJsonRendering: z.boolean(),
  paperEnabled: z.boolean(),
  paperName: z.string(),
  remoteAgentTypes: z.array(z.string()),
  remoteAgentUserDailyCents: z.number(),
  remoteAgentUserDailyTasks: z.number(),
  remoteAgentRoomDailyCents: z.number(),
  memoryRecallScope: z.enum(['session', 'platform', 'all']),
};

/** 配置值（生效值与继承值不含子会话默认配置） */
export const SessionConfigValuesSchema = z.object(sessionConfigFields).partial();

/** 会话自己的覆盖，另含给子会话的默认配置 */
export const SessionConfigSchema = SessionConfigValuesSchema.extend({
  sessionDefaults: SessionConfigValuesSchema.optional(),
});

/** 改配置的补丁：给值即写成会话自己的覆盖，null 删掉这一项、恢复继承，没给的键不动 */
export const SessionConfigPatchSchema = z
  .object({
    ...(Object.fromEntries(Object.entries(sessionConfigFields).map(([key, field]) => [key, field.nullable()])) as {
      [K in keyof typeof sessionConfigFields]: z.ZodNullable<(typeof sessionConfigFields)[K]>;
    }),
    sessionDefaults: SessionConfigValuesSchema.nullable(),
  })
  .partial();

/** 继承来的值出自哪一层：全局默认、平台档、平台档的受众条目、父会话给子会话的默认配置 */
export const InheritanceSourceSchema = z.enum(['defaults', 'platform', 'audience', 'parent']);

export const SessionConfigViewSchema = z.object({
  /** 会话自己的覆盖 */
  config: SessionConfigSchema,
  /** 生效值：继承值叠上会话自己的覆盖 */
  effective: SessionConfigValuesSchema,
  /** 继承链：选档用的平台与受众、继承值，以及每一项出自哪一层 */
  inheritance: z.object({
    platform: z.string().optional(),
    audience: z.enum(['private', 'group']).optional(),
    values: SessionConfigValuesSchema,
    sources: z.record(SessionConfigValuesSchema.keyof(), InheritanceSourceSchema),
  }),
  /** 可选项 */
  options: z.object({
    personas: z.array(z.string()),
    models: z.array(z.object({ provider: z.string(), model: z.string(), capabilities: z.array(z.string()) })),
    toolGroups: z.array(z.object({ name: z.string(), label: z.string() })),
  }),
});

export const SessionConfigUpdateParamsSchema = z.object({
  sessionId: z.string(),
  patch: SessionConfigPatchSchema,
});

// ════════════════════════════════════════════════════════════
// 订阅与条目
// ════════════════════════════════════════════════════════════

const AttachmentKindSchema = z.enum(['image', 'audio', 'video', 'file']);

/**
 * 条目里的附件：图片、音频、视频的 src 是媒体地址（存储地址或网址），其他文件的 src 是会话服务签发的不透明句柄。
 * 句柄绑定这个会话与文件，只在签发它的那次启动（同一个 epoch）内有效，客户端不解析它，按传输层给的下载入口取。
 * 取不到可下载的来源时没有 src，只有名字（如存档只记了文件名的用户上传、存在插件状态目录里的文件）
 */
export const ItemAttachmentSchema = z.object({
  kind: AttachmentKindSchema,
  src: z.string().optional(),
  name: z.string().optional(),
});

/** 客户端随消息发出的附件，data 是 data URL */
export const OutgoingAttachmentSchema = z.object({
  kind: AttachmentKindSchema,
  data: z.string(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  byteSize: z.number().optional(),
  durationSec: z.number().optional(),
});

/** 说话的人或发起回合的一方；source 是内部注入的来源（定时任务、子任务等），真人发言没有 */
export const SpeakerSchema = z.object({
  platform: z.string(),
  userId: z.string().optional(),
  nickname: z.string().optional(),
  source: z.string().optional(),
  owner: z.boolean(),
});

/** 回合的结局，取值同 api-agent 的 agent:turn:after */
export const TurnOutcomeSchema = z.enum(['replied', 'silent', 'aborted', 'error']);

const itemBase = {
  /** 会话里唯一；tool-call 的 itemId 就是工具调用的 callId（存档里没记 callId 的旧数据与没有执行的调用除外） */
  itemId: z.string(),
  /** 所在回合的 id；入站消息、回合外的宿主事件没有 */
  turnId: z.string().optional(),
  at: z.number(),
};

/**
 * 时间线上的一个条目。推送分 item/started、item/delta、item/completed，completed 里的全文是唯一正本；
 * 一次成形的条目不经 started 直接 completed，同一条目可以再次 completed（如送达结果晚到），按 itemId 覆盖：
 * - user-message：说话人的文字与附件；
 * - agent-message：她的文字与附件（可以只有附件）、模型；房间里没发出去的（工具调用之前说的、重试丢掉的、没回复就收尾的一轮里说的、
 *   平台没收下的）带 undelivered；
 * - reasoning：思考文字；
 * - tool-call：工具名、参数、状态、流式输出（exec 等）、结果摘要、耗时；sentToRoom 标出经平台工具发进房间、平台收下的消息。
 *   送达结果不落库，历史里只标得出工具调用之前说的话，其余 undelivered 与 sentToRoom 只在实时推送里。
 *   这次调用要 owner 批准时带 approvalId，再推一次 item/started；没批准的（拒绝、没人应答、撤销）状态是 denied。
 *   approvalId 与 denied 也只在实时推送里，历史里被拦下的调用显示为 failed；
 * - notice：宿主事件（压缩、白纸与作品通知、工具调用达到上限等），topic 区分种类，canContinue 表示可以 turn/continue；
 * - plan：待办，整份替换；每个会话一条，itemId 固定为 plan；
 * - usage：最近一次的 token 用量与分项；每个会话一条，itemId 固定为 usage；
 * - turn：回合开始（by 是发起方）与结束（outcome）。
 */
export const SessionItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user-message'),
    ...itemBase,
    text: z.string(),
    attachments: z.array(ItemAttachmentSchema),
    speaker: SpeakerSchema,
  }),
  z.object({
    kind: z.literal('agent-message'),
    ...itemBase,
    text: z.string(),
    attachments: z.array(ItemAttachmentSchema),
    model: z.object({ provider: z.string().optional(), model: z.string().optional() }).optional(),
    undelivered: z.object({ reason: z.string() }).optional(),
  }),
  z.object({ kind: z.literal('reasoning'), ...itemBase, text: z.string() }),
  z.object({
    kind: z.literal('tool-call'),
    ...itemBase,
    name: z.string(),
    args: z.record(z.unknown()),
    status: z.enum(['running', 'completed', 'failed', 'denied']),
    output: z.string().optional(),
    result: z.string().optional(),
    durationMs: z.number().optional(),
    sentToRoom: z.boolean().optional(),
    approvalId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('notice'),
    ...itemBase,
    topic: z.string(),
    text: z.string(),
    attachments: z.array(ItemAttachmentSchema),
    canContinue: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('plan'),
    ...itemBase,
    entries: z.array(
      z.object({ id: z.number(), title: z.string(), status: z.enum(['not-started', 'in-progress', 'completed']) }),
    ),
  }),
  z.object({
    kind: z.literal('usage'),
    ...itemBase,
    contextWindow: z.number(),
    maxTokens: z.number(),
    tokenBudget: z.number(),
    used: z.number(),
    usageRatio: z.number(),
    breakdown: z.record(z.number()),
    /** 其余系统提示的按注入者明细 */
    injectors: z.record(z.number()).optional(),
  }),
  z.object({
    kind: z.literal('turn'),
    ...itemBase,
    turnId: z.string(),
    by: SpeakerSchema,
    outcome: TurnOutcomeSchema.optional(),
  }),
]);
export type SessionItem = z.infer<typeof SessionItemSchema>;

// ════════════════════════════════════════════════════════════
// 审批
// ════════════════════════════════════════════════════════════

const ApprovalStateSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']);
/** 结算之后的四种结局 */
const SettledStateSchema = ApprovalStateSchema.exclude(['pending']);

/**
 * 审批对象，与 @aalis/api-approval 的 Approval 同形。卡片显示 facts 之前一律经 api-approval 的 sanitizeForCard 清洗：
 * facts 是逐字的参数，可能带控制符、双向控制符与零宽字符
 */
export const ApprovalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().optional(),
  callId: z.string().optional(),
  /** 发起回合的直接主体与它的类别（能产生审批的只有 owner 与 owner-chain） */
  origin: z.object({
    kind: z.enum(['owner', 'owner-chain', 'subtask', 'autonomous', 'room', 'other']),
    platform: z.string(),
    userId: z.string().optional(),
  }),
  target: z.literal('tool'),
  tool: z.string(),
  facts: z.object({
    command: z.string().optional(),
    cwd: z.string().optional(),
    /** 路径或内容疑似含密钥时没有 patch */
    diff: z.object({ path: z.string(), patch: z.string().optional() }).optional(),
    params: z.record(z.unknown()),
  }),
  options: z.array(z.enum(['approve', 'deny'])),
  /** 应答时原样带回 */
  contentHash: z.string(),
  state: ApprovalStateSchema,
});

/**
 * 订阅一律先回快照：最近一页历史、在途回合已产出的条目、会话当前的计划与用量，以及未结的审批。之后的推送带 epoch 与 seq：
 * seq 在一个 epoch 内递增，客户端丢掉 seq 不大于快照 seq 的推送；epoch 变了（会话服务重启过）就重新订阅。
 * 快照回应发出之前，这条连接收不到这个会话的推送。before 是更早一页历史的游标。
 */
export const SessionSnapshotSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  session: SessionSummarySchema,
  items: z.array(SessionItemSchema),
  /** 这个会话已推给审批面、还没结算的审批 */
  approvals: z.array(ApprovalSchema),
  before: z.string().optional(),
});

/**
 * 历史一页：before 取上一页（或快照）的 before，缺省是最新一页。limit 是这一页最多归并多少条存档消息（缺省 100）；
 * 一轮的工具调用组不拆在两页，所以一页可能略多。在途回合的条目不在历史里，由订阅的快照与推送给出
 */
export const SessionHistoryParamsSchema = z.object({
  sessionId: z.string(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const SessionHistoryResultSchema = z.object({
  items: z.array(SessionItemSchema),
  before: z.string().optional(),
});

const pushBase = { sessionId: z.string(), epoch: z.string(), seq: z.number().int().nonnegative() };

export const ItemPushParamsSchema = z.object({ ...pushBase, item: SessionItemSchema });

/** 流式增量：text 接在这个条目的流式文字后面（消息与思考的正文，tool-call 的输出） */
export const ItemDeltaParamsSchema = z.object({ ...pushBase, itemId: z.string(), text: z.string() });

/** 会话的历史被改写（如连对话一起回滚）：之前收到的条目作废，客户端重新 session/subscribe 取快照 */
export const SessionResyncParamsSchema = z.object(pushBase);

// ════════════════════════════════════════════════════════════
// 回合控制
// ════════════════════════════════════════════════════════════

/** 发一条消息：沿用现有语义，同一会话的新消息中止在途回合。只有附件、没写文字的照常发出 */
export const TurnSendParamsSchema = z
  .object({
    sessionId: z.string(),
    content: z.string(),
    attachments: z.array(OutgoingAttachmentSchema).optional(),
  })
  .refine(p => p.content.trim() !== '' || (p.attachments?.length ?? 0) > 0, { message: '文字与附件不能都为空' });

/** 停止：带 turnId 时只停那一轮，不是正在跑的那一轮回 expected-turn-mismatch */
export const TurnAbortParamsSchema = z.object({ sessionId: z.string(), turnId: z.string().optional() });

/** 回滚一轮：code 只回滚文件，code-and-chat 连这一轮的对话一起删 */
export const TurnRewindParamsSchema = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  scope: z.enum(['code', 'code-and-chat']),
});

/** 回滚结果，含义同 api-checkpoint 的 RollbackResult；连对话一起回滚时另有删掉的消息数 */
export const TurnRewindResultSchema = z.object({
  ok: z.boolean(),
  restored: z.array(z.string()),
  deleted: z.array(z.string()),
  errors: z.array(z.object({ uri: z.string(), reason: z.string() })),
  alsoChangedBy: z.array(z.object({ uri: z.string(), turnIds: z.array(z.string()) })),
  deletedMessages: z.number().int().nonnegative().optional(),
  chatDeleted: z.boolean().optional(),
});

// ════════════════════════════════════════════════════════════
// 在场与审批的方法与推送
// ════════════════════════════════════════════════════════════

export const PresenceUpdateParamsSchema = z.object({ active: z.boolean() });

export const ApprovalRespondParamsSchema = z.object({
  approvalId: z.string(),
  decision: z.enum(['approve', 'deny']),
  contentHash: z.string(),
  /** 说明：拒绝时回给模型 */
  note: z.string().optional(),
});

/** 有审批要处理：连接级推送，按在场推给在场的连接，不要求这条连接订阅了那个会话 */
export const ApprovalRequestedParamsSchema = z.object({ approval: ApprovalSchema });

/** 审批结算了：推给拿到过 approval/requested 的连接 */
export const ApprovalSettledParamsSchema = z.object({ approvalId: z.string(), state: SettledStateSchema });

// ════════════════════════════════════════════════════════════
// 方法与通知表
// ════════════════════════════════════════════════════════════

/** 客户端可调的方法：名字 → 参数与结果的 schema。没有参数的方法传 {} 或不传 */
export const sessionMethods = {
  initialize: { params: InitializeParamsSchema, result: InitializeResultSchema },
  'sessions/list': { params: SessionsListParamsSchema, result: SessionsListResultSchema },
  'sessions/watch': { params: EmptySchema, result: EmptySchema },
  'session/create': {
    params: SessionCreateParamsSchema,
    result: z.object({ session: SessionSummarySchema }),
  },
  'session/rename': { params: SessionRenameParamsSchema, result: EmptySchema },
  'session/archive': { params: SessionTargetSchema, result: EmptySchema },
  /** 删除会话连同子会话，并清空它们的消息历史与长期记忆 */
  'session/delete': { params: SessionTargetSchema, result: EmptySchema },
  'session/batch': { params: SessionBatchParamsSchema, result: SessionBatchResultSchema },
  'session/config/get': { params: SessionTargetSchema, result: SessionConfigViewSchema },
  'session/config/update': { params: SessionConfigUpdateParamsSchema, result: SessionConfigViewSchema },
  /** 记下 owner 看过这个会话，用于「我的」区的完成未读 */
  'session/markSeen': { params: SessionTargetSchema, result: EmptySchema },
  'session/subscribe': { params: SessionTargetSchema, result: SessionSnapshotSchema },
  'session/unsubscribe': { params: SessionTargetSchema, result: EmptySchema },
  'session/history': { params: SessionHistoryParamsSchema, result: SessionHistoryResultSchema },
  'turn/send': { params: TurnSendParamsSchema, result: EmptySchema },
  /** 工具调用达到上限后继续 */
  'turn/continue': { params: SessionTargetSchema, result: EmptySchema },
  'turn/abort': { params: TurnAbortParamsSchema, result: EmptySchema },
  /** 手动压缩 */
  'session/compress': { params: SessionTargetSchema, result: EmptySchema },
  'turn/rewind': { params: TurnRewindParamsSchema, result: TurnRewindResultSchema },
  /** 清空待办 */
  'plan/clear': { params: SessionTargetSchema, result: EmptySchema },
  /**
   * 在场上报：active 为真表示页面可见且刚有键盘或指针活动，为假表示页面转到后台、即刻不在场。
   * 最近一次为真的上报在 10 分钟内即算在场；客户端在有活动时按需重报
   */
  'presence/update': { params: PresenceUpdateParamsSchema, result: EmptySchema },
  /** 应答一个审批：先答先得，后到的回 approval-settled；应答人须是 owner，内容哈希须一致 */
  'approval/respond': { params: ApprovalRespondParamsSchema, result: EmptySchema },
} as const;

/** 服务端推送：名字 → 参数的 schema */
export const sessionNotifications = {
  'sessions/changed': SessionsChangedParamsSchema,
  'item/started': ItemPushParamsSchema,
  'item/delta': ItemDeltaParamsSchema,
  'item/completed': ItemPushParamsSchema,
  'session/resync': SessionResyncParamsSchema,
  'approval/requested': ApprovalRequestedParamsSchema,
  'approval/settled': ApprovalSettledParamsSchema,
} as const;

export type SessionMethod = keyof typeof sessionMethods;
export type SessionMethodParams<M extends SessionMethod> = z.infer<(typeof sessionMethods)[M]['params']>;
export type SessionMethodResult<M extends SessionMethod> = z.infer<(typeof sessionMethods)[M]['result']>;
export type SessionNotification = keyof typeof sessionNotifications;
export type SessionNotificationParams<N extends SessionNotification> = z.infer<(typeof sessionNotifications)[N]>;

// ════════════════════════════════════════════════════════════
// 服务
// ════════════════════════════════════════════════════════════

/** 一条连接的对端，由传输层在认证之后给出 */
export interface SessionPeer {
  identity: Identity;
  /**
   * 这条连接所在的审批面：传输层经 approvals 的 registerSurface 登记得到的句柄。连接上的在场上报与应答都记在它的
   * 登记身份名下，连接自己报不了别的面
   */
  surface: ApprovalSurface;
  /** 服务端要断开这条连接（握手版本不合、会话服务停止）时调用，传输层据此关闭底层连接 */
  disconnect(reason: string): void;
}

/** 服务端这一侧的连接 */
export interface SessionConnection {
  /** 收到一帧文本。返回的 Promise 在这一帧处理完、回应已发出时落定，不会被拒 */
  receive(frame: string): Promise<void>;
  /** 底层连接已关闭：撤掉这条连接上的订阅，此后不再发送 */
  close(): void;
}

export interface SessionProtocolService {
  /** 接入一条连接；send 发出一帧文本 */
  connect(peer: SessionPeer, send: (frame: string) => void): SessionConnection;
  /**
   * 核验条目附件里的文件句柄：是这次启动内为这个会话签发的，回它指向的存储地址与文件名；伪造的、改动过的、
   * 别的会话的、会话服务重启之前签发的回 undefined。传输层据此读出文件，一律当附件下发
   */
  resolveFile(sessionId: string, handle: string): { uri: string; name: string } | undefined;
}

export const sessionProtocol = defineService<SessionProtocolService>('session-protocol');
