/**
 * @aalis/api-session-protocol — 会话协议（实验性）
 *
 * owner 的客户端（WebUI，以后还有终端）与守护进程之间的线上格式：JSON-RPC 2.0 帧、握手、错误码，会话列表与增量、
 * 订阅与条目、回合控制、后台任务、在场与审批。帧与参数都写成 zod schema，类型由 schema 推导：服务端按它校验收到的帧，
 * 客户端照它实现。
 * 本包只有 schema、协议版本与服务描述符 `sessionProtocol`；实现由提供 `sessionProtocol` 的插件给出，
 * 传输（WebSocket 等）由宿主插件接到 `sessionProtocol.connect`。
 *
 * 第一版标 experimental：终端客户端接入之前允许不兼容的修改，之后只做加法，加字段升次版本。
 * 对象 schema 不拒多余的键，旧客户端读到新加的字段照常解析。
 */

import type { ApprovalSurface } from '@aalis/api-approval';
import { defineService } from '@aalis/core';
import type { SchemaField } from '@aalis/schema-config';
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

/**
 * 功能位：发送、回滚、压缩，各看对话、检查点、压缩服务在不在。界面按它决定入口出现与否；服务上下线时推
 * features/changed。计划、审批、用量按数据出现，不在这里
 */
export const FeaturesSchema = z.object({
  send: z.boolean(),
  rewind: z.boolean(),
  compress: z.boolean(),
});
export type Features = z.infer<typeof FeaturesSchema>;

export const InitializeResultSchema = z.object({
  protocolVersion: z.string(),
  experimental: z.literal(true),
  server: z.object({ name: z.string() }),
  identity: IdentitySchema,
  /** 这条连接所在审批面的登记名（webui、cli）；审计记的是登记身份 */
  surface: z.string(),
  features: FeaturesSchema,
  /** 应用名：宿主配置里的 name，每次握手现读，改名之后新的连接就拿到新名字；没有宿主配置时是 Aalis */
  appName: z.string(),
});

// ════════════════════════════════════════════════════════════
// 会话与列表
// ════════════════════════════════════════════════════════════

/** 列表的分区：owner 是「我的」会话，rooms 是 IM 房间；子会话归在根会话的区里 */
export const SessionSectionSchema = z.enum(['owner', 'rooms']);
export type SessionSection = z.infer<typeof SessionSectionSchema>;

/** 回合的结局，取值同 api-agent 的 agent:turn:after */
export const TurnOutcomeSchema = z.enum(['replied', 'silent', 'aborted', 'error']);

/** 会话摘要：列表一行所需的全部字段 */
export const SessionSummarySchema = z.object({
  id: z.string(),
  /** 标题，没有时是会话名 */
  title: z.string(),
  parentId: z.string().optional(),
  childCount: z.number().int().nonnegative(),
  /**
   * 会话种类（api-session-manager 的 sessionKind）：task 是子任务，room 是 IM 房间（受众为群或私聊，含 owner 自己的私聊），
   * owner 是其余（owner 在 WebUI、终端的会话等）。适用于这个会话的设置项按它选
   */
  kind: z.enum(['owner', 'room', 'task']),
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
  /**
   * 在跑的后台工作数：本会话在跑的后台任务，加各级子会话里有回合在跑或有后台任务在跑的会话数。本会话自己的回合不算，
   * 那是 running
   */
  background: z.number().int().nonnegative(),
  /** 本会话与各级子会话的模型调用累计的输入与输出 token；都还没有时没有 */
  tokens: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
  /** 最近结束的一轮：结局与结束时间 */
  lastTurn: z.object({ outcome: TurnOutcomeSchema, endedAt: z.number() }).optional(),
  /** 出错（error 为真）时最近一轮的一句原因；没有原因的没有 */
  reason: z.string().optional(),
  /** 子会话才有：各级父会话的 id 与标题，根会话在前 */
  ancestors: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** 房间的一组：一个适配器实例一组；还没记下实例的房间按平台成一组，没有 instance */
export const RoomGroupSchema = z.object({
  platform: z.string(),
  instance: z.string().optional(),
  /** 组名：实例的显示名（插件显示名，非默认实例另带实例名）；没有实例的组是平台名 */
  label: z.string(),
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
 * - instance 只列这个适配器实例接管的房间，platform 只列这个平台还没记下实例的房间（groups 里没有 instance 的那一组），
 *   两者不同时给；房间表据此一次取全一组；
 * - archived 缺省不含已归档的会话，为 true 时只列已归档的；
 * - background 只列 background 大于 0 的会话，已归档的与没归档的都列，不与 archived 同时给；
 * - query 按名称、标题、id 匹配（不分大小写），也认「平台:群号」。cursor 取上一页的 nextCursor。
 */
export const SessionsListParamsSchema = z
  .object({
    section: SessionSectionSchema.optional(),
    parentId: z.string().optional(),
    instance: z.string().optional(),
    platform: z.string().optional(),
    archived: z.boolean().optional(),
    background: z.literal(true).optional(),
    query: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .refine(p => p.instance === undefined || p.platform === undefined, { message: 'instance 与 platform 不同时给' })
  .refine(p => p.background === undefined || p.archived === undefined, { message: 'background 与 archived 不同时给' });

export const SessionsListResultSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  /** 还有下一页时给出 */
  nextCursor: z.string().optional(),
  /** 没归档的房间的分组，不受分区、搜索与分页影响 */
  groups: z.array(RoomGroupSchema),
});

/** `sessions/watch` 之后的增量：变了的会话给完整摘要，删掉的给 id，另附最新的分组 */
export const SessionsChangedParamsSchema = z.object({
  upserts: z.array(SessionSummarySchema),
  removes: z.array(z.string()),
  groups: z.array(RoomGroupSchema),
});

const SessionTargetSchema = z.object({ sessionId: z.string() });

/** 新建会话：给 parentId 时建它的子会话，复制父会话的生效配置（只经继承链实时解析的设置项除外） */
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

// ----- 会话设置 -----

/** schema-config 的字段：类型、标签、说明、默认值、校验与可选项来源（dynamicOptions），词汇见 @aalis/schema-config */
const SettingFieldSchema = z.custom<SchemaField>(
  value =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { label?: unknown }).label === 'string',
  { message: '期望 schema-config 字段（带 type 与 label）' },
);

/** 生效值出自哪一层：本会话、父会话给子会话的默认值（旧数据）、受众条目、平台档、全局默认 */
export const SettingSourceSchema = z.enum(['session', 'parent', 'audience', 'platform', 'defaults']);

/**
 * 一个设置项的一行。设置项由插件登记，协议与客户端都不认识具体的键，按 field 渲染。一组行已排好：composer、common
 * 在前，advanced 在后，同一显眼程度按登记的先后；composer 也出现在输入框旁的快捷切换，同一组最多两项，多出的已退到 common
 */
export const SettingRowSchema = z.object({
  key: z.string(),
  field: SettingFieldSchema,
  /** 登记它的插件实例 id：「高级」里按它分组，组名取插件显示名 */
  plugin: z.string(),
  prominence: z.enum(['composer', 'common', 'advanced']),
  /** 可选项依赖的另一行的键：取这一行的动态可选项时带上那一行的生效值，那一行变了就重取 */
  dependsOn: z.string().optional(),
  /** 哪一层都没设、字段又没有默认值时这一项的含义（登记方给），界面写在生效值的位置 */
  unset: z.string().optional(),
  /** 这一层自己的值：会话的读写里是本会话的覆盖，层的读写里是这一层写的值；没写的没有 */
  value: z.unknown().optional(),
  /** 生效值；哪一层都没设时没有，界面按字段的默认值显示 */
  effective: z.unknown().optional(),
  /** 生效值出自哪一层；哪一层都没设时没有 */
  source: SettingSourceSchema.optional(),
});
export type SettingRow = z.infer<typeof SettingRowSchema>;

export const SettingRowsSchema = z.object({ items: z.array(SettingRowSchema) });

/**
 * 写设置：给值即写入这一层（按登记的校验与字段），null 删掉这一项、恢复继承，没给的键不动。给值的键须适用于这个会话种类
 * （受众条目按房间），null 不受限
 */
const SettingPatchSchema = z.record(z.unknown());

/** 改本会话的覆盖；没登记的键、不合字段的值、不适用于这个会话种类的项回参数错误，什么都不改 */
export const SessionConfigUpdateParamsSchema = z.object({ sessionId: z.string(), patch: SettingPatchSchema });

/**
 * 会话之上的一层：全局默认、平台档（按平台名生效，不区分适配器实例）、平台档的受众条目（只对这个平台的群或私聊房间）。
 * 继承的先后：本会话、父会话、受众条目、平台档、全局默认
 */
export const SettingLayerSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('defaults') }),
  z.object({ scope: z.literal('platform'), platform: z.string().min(1) }),
  z.object({ scope: z.literal('audience'), platform: z.string().min(1), audience: z.enum(['group', 'private']) }),
]);
export type SettingLayer = z.infer<typeof SettingLayerSchema>;

export const SettingLayerTargetSchema = z.object({ layer: SettingLayerSchema });
export const SettingLayerUpdateParamsSchema = z.object({ layer: SettingLayerSchema, patch: SettingPatchSchema });

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

const ApprovalStateSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']);
/** 结算之后的四种结局 */
const SettledStateSchema = ApprovalStateSchema.exclude(['pending']);

/**
 * 审批的结算，与 @aalis/api-approval 的 ApprovalSettlement 同形：结局、从哪里来（owner 应答、没人在场、超时、发起者不能产生审批、
 * 子任务、频率上限、回合结束、服务停止）与结算的时刻
 */
export const ApprovalSettlementSchema = z.object({
  state: SettledStateSchema,
  source: z.enum(['owner', 'absent', 'timeout', 'ineligible', 'subtask', 'rate-limit', 'turn-ended', 'shutdown']),
  at: z.number(),
});

/**
 * 工具卡的展示：会话服务按工具定义上声明的展示种类，从参数里逐字取出各字段的值。种类是宿主维护的封闭集合，
 * 以后按加法加：command 是命令与工作目录，以及结果里的退出码（工具声明了取自结果的哪个键、调用已结束且取得到时才有），
 * file-change 是路径与删、加两侧的文本
 */
export const ToolDisplaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string().optional(),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('file-change'),
    path: z.string(),
    removed: z.string().optional(),
    added: z.string().optional(),
  }),
]);

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
 * - agent-message：她的文字与附件（可以只有附件）、模型与这一轮的 token；房间里没发出去的（工具调用之前说的、重试丢掉的、没回复就收尾的一轮里说的、
 *   平台没收下的）带 undelivered。没回复就收尾的一轮说的话不落库，只在实时推送里，历史里没有这几条；其余几种历史里同样标出；
 * - reasoning：思考文字；
 * - tool-call：工具名、参数、状态、流式输出（exec 等）、结果摘要、耗时；display 是按工具声明解析好的展示，没声明的没有，
 *   界面逐字列出参数；sentToRoom 标出房间里经平台工具发出、平台收下的消息。模型还在生成参数时先推一次，状态是 generating，
 *   只有工具名、args 为空；开始执行时同一个 itemId 转为 running。结果带 error、或展示里的退出码不为 0 的是 failed。
 *   回合被停止时还没结束的调用（包括生成了还没执行的）是 aborted，停止之后工具照样返回了结果也不改；生成了却没有执行、
 *   回合不是被停止的（达到工具调用上限、回合出错）在回合结束时以 failed 收尾。历史里没有结果的调用（重启或中断）是 aborted。
 *   这次调用要 owner 批准、审批推给了审批面时带 approvalId，再推一次 item/started；结算后带 approvalId 与 settlement，
 *   再推一次，发起时就结算、没推给审批面的（没人在场、发起者不能产生审批、子任务、频率上限）同样带；没批准的（拒绝、
 *   没人应答、撤销）状态是 denied。转到后台的调用带 taskId（后台任务的 id），结果是转后台时回给模型的那段，任务的状态、
 *   最后一行与输出看后台任务。sentToRoom、approvalId、settlement、taskId 与停止时还没结束随工具结果落库，历史里同样还原；
 * - notice：宿主事件（压缩、插件的成品通知、工具调用达到上限等），topic 区分种类，canContinue 表示可以 turn/continue；
 * - plan：待办，整份替换；每个会话一条，itemId 固定为 plan；
 * - usage：最近一次的 token 用量与分项；每个会话一条，itemId 固定为 usage。它不是时间线上的一条，界面画在会话头部；
 *   parts 是产出方给的拆分表，显示名与次序照它，界面不认分项；compressAt 是自动压缩的使用率（由压缩服务给出），
 *   没有压缩服务或不自动压缩时没有；
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
    /**
     * 生成这条回复的模型与这一轮的 token：promptTokens 是这一轮最后一次调用的上下文，completionTokens 是这一轮各次调用的
     * 输出合计
     */
    model: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
        promptTokens: z.number().optional(),
        completionTokens: z.number().optional(),
      })
      .optional(),
    undelivered: z.object({ reason: z.string() }).optional(),
  }),
  z.object({ kind: z.literal('reasoning'), ...itemBase, text: z.string() }),
  z.object({
    kind: z.literal('tool-call'),
    ...itemBase,
    name: z.string(),
    args: z.record(z.unknown()),
    status: z.enum(['generating', 'running', 'completed', 'failed', 'denied', 'aborted']),
    output: z.string().optional(),
    result: z.string().optional(),
    durationMs: z.number().optional(),
    display: ToolDisplaySchema.optional(),
    sentToRoom: z.boolean().optional(),
    approvalId: z.string().optional(),
    settlement: ApprovalSettlementSchema.optional(),
    taskId: z.string().optional(),
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
    /**
     * 不含为回复预留（maxTokens）。injectors 是这一项按注入者的明细：键是注入者的全局键「插件实例 id/局部 id」，
     * 界面按实例前缀合并到插件
     */
    parts: z.array(z.object({ label: z.string(), tokens: z.number(), injectors: z.record(z.number()).optional() })),
    /** 自动压缩的使用率（0 到 1，与 usageRatio 同一口径） */
    compressAt: z.number().optional(),
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
// 后台任务
// ════════════════════════════════════════════════════════════

/**
 * 一个后台任务，取自后台任务登记（api-tools 的 backgroundTasks）。kind 是宿主维护的封闭集合，以后按加法加：现在只有
 * tool-call，即转到后台的工具调用。界面按通用字段画，不认种类以外的细节。不下发模型给的参数与工具的结果；display 是
 * 会话服务按工具声明的展示种类解析好的，同工具卡（命令种类在结束后带退出码）
 */
export const BackgroundTaskSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(['tool-call']),
  /** 显示名：工具调用是工具名 */
  label: z.string(),
  /** tool-call 才有：起它的那次工具调用的工具名、所在回合与调用的 id（即工具卡的 itemId） */
  call: z.object({ tool: z.string(), turnId: z.string(), callId: z.string() }).optional(),
  /** 在跑、完成、失败（结果带 error 或退出码不为 0）、被停止、被中断（工具撤回、停用、重启） */
  status: z.enum(['running', 'completed', 'failed', 'stopped', 'aborted']),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** 输出的最后一行 */
  lastLine: z.string().optional(),
  /** 最后一次有输出的时刻 */
  lastOutputAt: z.number().optional(),
  /** 失败或中断的一句原因 */
  reason: z.string().optional(),
  display: ToolDisplaySchema.optional(),
});
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>;

const TaskTargetSchema = z.object({ taskId: z.string() });

/** 取输出：after 是上次回的 end，只取之后新增的；缺省从缓冲的开头取 */
export const BackgroundOutputParamsSchema = z.object({
  taskId: z.string(),
  after: z.number().int().nonnegative().optional(),
});

/**
 * 一段输出：text 是 after 之后的部分；end 是至今的输出总字数，下次带作 after；缓冲只留末尾，after 早于缓冲的开头时
 * truncated 为真。Aalis 重启之前的任务没有留下输出
 */
export const BackgroundOutputSchema = z.object({
  text: z.string(),
  end: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

/** `background/watch` 之后的增量：变了的任务给完整的一份，删掉的给 id */
export const BackgroundChangedParamsSchema = z.object({
  upserts: z.array(BackgroundTaskSchema),
  removes: z.array(z.string()),
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
export const ApprovalSettledParamsSchema = ApprovalSettlementSchema.extend({ approvalId: z.string() });

/** 功能位变了（对话、检查点或压缩服务上线或下线）：给出最新的功能位 */
export const FeaturesChangedParamsSchema = z.object({ features: FeaturesSchema });

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
  /** 归档会话连同子会话 */
  'session/archive': { params: SessionTargetSchema, result: EmptySchema },
  /** 恢复归档的会话连同子会话 */
  'session/unarchive': { params: SessionTargetSchema, result: EmptySchema },
  /** 删除会话连同子会话，并清空它们的消息历史与长期记忆 */
  'session/delete': { params: SessionTargetSchema, result: EmptySchema },
  'session/batch': { params: SessionBatchParamsSchema, result: SessionBatchResultSchema },
  /** 适用于这个会话的设置项，各带本会话的值、生效值与来源 */
  'session/config/get': { params: SessionTargetSchema, result: SettingRowsSchema },
  /** 按键改本会话的覆盖，回最新的各行 */
  'session/config/update': { params: SessionConfigUpdateParamsSchema, result: SettingRowsSchema },
  /**
   * 可以设的各层：全局默认总在第一个，其后按平台名，每个平台先平台档、再群与私聊的受众条目。平台档是已装适配器的平台加上
   * 配置里写过的平台；受众条目按适配器声明的会话类型出，加上配置里写过的
   */
  'session/config/layers': { params: EmptySchema, result: z.object({ layers: z.array(SettingLayerSchema) }) },
  /** 一层的各行，形状与会话的相同；受众条目只列适用于房间的项 */
  'session/config/layer/get': { params: SettingLayerTargetSchema, result: SettingRowsSchema },
  /** 按键改一层的值，回最新的各行；改动写进宿主的配置文档 */
  'session/config/layer/update': { params: SettingLayerUpdateParamsSchema, result: SettingRowsSchema },
  /** 记下 owner 看过这个会话，用于「我的」区的完成未读 */
  'session/markSeen': { params: SessionTargetSchema, result: EmptySchema },
  'session/subscribe': { params: SessionTargetSchema, result: SessionSnapshotSchema },
  'session/unsubscribe': { params: SessionTargetSchema, result: EmptySchema },
  'session/history': { params: SessionHistoryParamsSchema, result: SessionHistoryResultSchema },
  'turn/send': { params: TurnSendParamsSchema, result: EmptySchema },
  /** 工具调用达到上限后继续 */
  'turn/continue': { params: SessionTargetSchema, result: EmptySchema },
  'turn/abort': { params: TurnAbortParamsSchema, result: EmptySchema },
  /**
   * 手动压缩：压完才回；没有压缩服务回 unsupported，没压成回内部错误（时间线上的压缩通知同样写明失败）。这个会话正在
   * 压缩或生成摘要时直接拒绝，同样回内部错误，时间线上没有新的通知
   */
  'session/compress': { params: SessionTargetSchema, result: EmptySchema },
  /**
   * 回滚之前查一轮的检查点：execUsed 为真表示这一轮执行过命令，命令的效果不经存储，回滚撤不回；没有这一轮的检查点时为 false
   */
  'turn/checkpoint': {
    params: z.object({ sessionId: z.string(), turnId: z.string() }),
    result: z.object({ execUsed: z.boolean() }),
  },
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
  /** 全部会话在跑的与保留的结束的后台任务；没有后台任务登记时回 unsupported */
  'background/list': { params: EmptySchema, result: z.object({ tasks: z.array(BackgroundTaskSchema) }) },
  /** 之后推 background/changed；后台任务登记晚些上线时照样推 */
  'background/watch': { params: EmptySchema, result: EmptySchema },
  /** 不认识的任务回 not-found，没有后台任务登记时回 unsupported */
  'background/output': { params: BackgroundOutputParamsSchema, result: BackgroundOutputSchema },
  /** 停一个后台任务：等它落定（最多几秒）才回，之后的状态经 background/changed 推出。被停止的不通知她 */
  'background/stop': { params: TaskTargetSchema, result: EmptySchema },
  /**
   * 停掉这个会话下面的全部后台工作：它自己的后台任务、各级子会话的回合与它们的后台任务。不停它自己的回合（那是 turn/abort）
   */
  'background/stopAll': { params: SessionTargetSchema, result: EmptySchema },
} as const;

/** 服务端推送：名字 → 参数的 schema */
export const sessionNotifications = {
  'features/changed': FeaturesChangedParamsSchema,
  'sessions/changed': SessionsChangedParamsSchema,
  /**
   * 会话设置变了：插件启停使设置项增减，或某一层、某个会话的覆盖被改写。不带参数，客户端重取打开着的会话的设置
   * 与输入框旁的快捷切换
   */
  'session/config/changed': EmptySchema,
  'item/started': ItemPushParamsSchema,
  'item/delta': ItemDeltaParamsSchema,
  'item/completed': ItemPushParamsSchema,
  'session/resync': SessionResyncParamsSchema,
  'approval/requested': ApprovalRequestedParamsSchema,
  'approval/settled': ApprovalSettledParamsSchema,
  /** 后台任务变了：开始、结束、停止与删除立即推；只有最后一行与最后输出时间变了的合并起来，每秒至多一次 */
  'background/changed': BackgroundChangedParamsSchema,
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
