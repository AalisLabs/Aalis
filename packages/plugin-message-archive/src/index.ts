import { authority } from '@aalis/api-authority';
import { media } from '@aalis/api-media';
import { memory } from '@aalis/api-memory';
import type { ArchiveNoticeOptions, MessageArchiveService } from '@aalis/api-message-archive';
import { messageArchive, outboundAddress, speakerOf, unaddressedText } from '@aalis/api-message-archive';
import { sessionManager } from '@aalis/api-session-manager';
import { isStorageUri, parseUriRoot, storage } from '@aalis/api-storage';
import { type BoundOf, config, definePlugin, events, logger, optional, provide } from '@aalis/core';
import { defineConfig, parseConfig } from '@aalis/schema-config';
import { isTextRef, type TextRef, textOf, toSource, truncateParams } from '@aalis/schema-i18n';
import type { ArchivedAttachment, IncomingMessage, Message, OutgoingMessage } from '@aalis/schema-message';
import {
  AttachmentRefKind,
  buildIncomingContent,
  getMessageName,
  outboundMarkerMessage,
  outboundMediaMessage,
  parseAttachmentRefs,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '@aalis/schema-message';

const configSchema = defineConfig({
  debugLogs: {
    type: 'boolean',
    label: '归档调试日志',
    default: true,
    description: '记录图片解释完成和消息写入记忆等调试日志。',
  },
});

/** 从消息文本中抽取 @提及的用户 ID 列表（平台无关：依赖各 adapter 输出统一的 <at id="X"> 标签） */
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

/** 附件引用里的种类名 */
const REF_KINDS: Readonly<Record<ArchivedAttachment['kind'], string>> = {
  image: AttachmentRefKind.Image,
  audio: AttachmentRefKind.Audio,
  video: AttachmentRefKind.Video,
  file: AttachmentRefKind.File,
};

const isWebUrl = (value: string) => /^https?:\/\//i.test(value);

/**
 * 能当地址的写法：网址，以及根在存储服务根表里的存储地址。预处理器换上的私有引用（形似存储地址、根不存在）与相对路径
 * 不算
 */
function addressOf(value: string | undefined, roots: ReadonlySet<string>): string | undefined {
  if (!value) return undefined;
  if (isWebUrl(value)) return value;
  return isStorageUri(value) && roots.has(parseUriRoot(value)) ? value : undefined;
}

/**
 * 入站附件的清单：地址取附件的 data；data 不是地址（内联数据、本机路径、预处理器的私有引用）时，取预处理器给它写的描述里
 * 同种附件的引用（formatAttachmentRef 的写法，如媒体识别把上传的图片落盘后写的）
 */
function attachmentList(incoming: IncomingMessage, roots: ReadonlySet<string>): ArchivedAttachment[] {
  return (incoming.attachments ?? []).map(({ kind, name, data }, i) => {
    const described = parseAttachmentRefs(incoming._attachmentDescriptions?.[i] ?? '').find(
      found => found.kind === REF_KINDS[kind],
    );
    const ref = addressOf(data, roots) ?? addressOf(described?.ref, roots);
    return { kind, ...(name ? { name } : {}), ...(ref ? { ref } : {}) };
  });
}

/** 给人看的那句记进 metadata：参数截到 200 字（同其余落盘方）；截完退成字符串的不记，读历史的一方照旧显示正文 */
function recordText(meta: Record<string, unknown>, text: TextRef | undefined): void {
  const cut = text && truncateParams(text, 200);
  if (isTextRef(cut)) meta[WellKnownMetadataKeys.Text] = cut;
}

/** 她发的网址图片与视频补描述时等识图的上限：视频要抽帧加转写，放得更宽 */
const DESCRIBE_TIMEOUT_MS = { image: 25_000, video: 30_000 } as const;

/** 一条出站记录；pending 是记完之后要在后台补描述的（她发的、没带描述的网址图片与视频） */
interface OutboundRecord {
  message: Message;
  pending?: { kind: keyof typeof DESCRIBE_TIMEOUT_MS; url: string };
}

/** 出站消息在会话历史里的各条，记法见 api-message-archive 的 recordOutbound */
function outboundRecords(msg: OutgoingMessage): OutboundRecord[] {
  const marker = outboundMarkerMessage(msg);
  const records: OutboundRecord[] = marker ? [{ message: marker }] : [];
  for (const att of msg.attachments ?? []) {
    const address = outboundAddress(att);
    if (address === undefined) {
      const text = unaddressedText(att);
      const metadata: Record<string, unknown> = {};
      recordText(metadata, text);
      records.push({
        message: { role: 'system', kind: WellKnownKinds.EventMarker, content: toSource(text), metadata },
      });
      continue;
    }
    const file = att.kind === 'file';
    const message: Message = {
      ...outboundMediaMessage(att.kind, address, { desc: file ? att.name : att.description, source: msg.source }),
      metadata: {
        [WellKnownMetadataKeys.SentRef]: address,
        ...(file && att.name ? { [WellKnownMetadataKeys.SentName]: att.name } : {}),
      },
    };
    const { kind } = att;
    const later = msg.source === 'agent' && (kind === 'image' || kind === 'video') && !att.description;
    records.push(later && isWebUrl(address) ? { message, pending: { kind, url: address } } : { message });
  }
  // 每条记录的元数据带出站的来源、回合 id 与调用 id，都是有才记
  const facts = {
    ...(msg.source ? { [WellKnownMetadataKeys.Source]: msg.source } : {}),
    ...(msg.turnId ? { [WellKnownMetadataKeys.TurnId]: msg.turnId } : {}),
    ...(msg.callId ? { [WellKnownMetadataKeys.CallId]: msg.callId } : {}),
  };
  return records.map(({ message, pending }) => {
    const metadata = { ...facts, ...message.metadata };
    return { message: Object.keys(metadata).length > 0 ? { ...message, metadata } : message, pending };
  });
}

/** work 在 ms 内没有结果就以「超时」拒绝 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`识图超时（${ms / 1000} 秒）`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const uses = {
  memory,
  media: optional(media),
  storage: optional(storage),
  /**
   * 认出子会话：它的出站没人认领时由这里认领；入站的发送者前缀按根会话的房间类别给（speakerOf）。不在时判不出，不认领，
   * 入站一律写这条消息自己的说话人
   */
  sessionManager: optional(sessionManager),
  /** 发送者前缀判谁是 owner、取 owner 在房间所在平台登记的账号；不在时没有人是 owner */
  authority: optional(authority),
  events,
  logger,
  config,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-message-archive',
  displayName: '消息归档',
  subsystem: 'message',
  configSchema,
  provides: [messageArchive],
  uses,
  apply(caps) {
    const cfg = parseConfig(configSchema, caps.config.use, caps.logger.use);
    const archive = createArchiveService(caps, cfg.debugLogs);
    caps.provide.use(messageArchive, archive);
    // 适配器送达之后发的快照记进会话历史；不等它写完，免得拖住同一事件的其它监听
    caps.events.use.on('outbound:delivered', msg => {
      archive
        .recordOutbound(msg)
        .catch(err => caps.logger.use.warn('[message-archive] 出站消息没能记进会话历史:', err));
    });
    // 子会话没有窗口，任何适配器都不认领它的出站：还没人认领的由这里认领，记进子会话自己的历史即算送达
    caps.events.use.on('outbound:message', msg => {
      if (msg.delivery || !caps.sessionManager.present) return;
      if (!caps.sessionManager.use.getSession(msg.sessionId)?.parentId) return;
      msg.delivery = archive.recordOutbound(msg).then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error: textOf(error) }),
      );
    });
  },
});

function createArchiveService(
  { memory, media, storage, sessionManager, authority, events, logger }: Caps,
  debugLogs: boolean,
): MessageArchiveService {
  // 经 memory 的业务句柄调用：一次激活内胜者也可能换人（偏好变更、更高优先级的提供者登场），
  // 句柄每次调用都打到当时选中的那一家。
  async function saveMessage(sessionId: string, message: Message, options?: { debugLabel?: string }): Promise<void> {
    await memory.use.saveMessage(sessionId, message);
    void announce(sessionId, message);
    if (debugLogs && options?.debugLabel) {
      logger.use.debug(options.debugLabel);
    }
  }

  /**
   * 落库之后通知监听者，回这次派发（落库的一方不等它）。只发 assistant「对外可见的回复」（memory-vector 据此索引 AI 自身发言）：
   * 带 toolCalls 的行是工具调用回合的内部前言（「我来查一下」），从未发给任何人，不该进语义记忆；tool/摘要等其他 saveMessage
   * 用途同理不发。core 的 emit 恒 resolve（per-handler try/catch），无需 catch。
   */
  function announce(sessionId: string, message: Message): Promise<void> {
    if (message.role !== 'assistant' || !message.content?.trim() || message.toolCalls?.length) return Promise.resolve();
    return events.use.emit('assistant:message:archived', { sessionId, message });
  }

  /**
   * 她发的网址图片与视频记完之后补描述：识图拿到描述就把这一条正文里的附件引用换成带描述的（只改这个会话里最近一条含它的），
   * 改到了发 memory:messages-rewritten。记忆后端不支持改写或媒体服务不在时不补；识图超时或失败记一条 warn，这一条保持不带描述
   */
  async function describeLater(
    sessionId: string,
    record: Message,
    { kind, url }: NonNullable<OutboundRecord['pending']>,
  ) {
    const mem = memory.use;
    if (!mem.updateMessageContent || !media.present) return;
    const service = media.use;
    const described = kind === 'image' ? service.describeImage(url) : service.describeVideo(url);
    const desc = (await withTimeout(described, DESCRIBE_TIMEOUT_MS[kind])).trim();
    if (!desc) return;
    const before = outboundMediaMessage(kind, url, { source: 'agent' }).content;
    const { content } = outboundMediaMessage(kind, url, { desc, source: 'agent' });
    if ((await mem.updateMessageContent(sessionId, before, content, 1)) === 0) return;
    await events.use.emit('memory:messages-rewritten', { sessionId, messages: [{ ...record, content }] });
  }

  /** 上次出站记录用掉的时间戳：同一毫秒里的几次出站往后错开，同一会话里的出站记录时间戳各不相同 */
  let lastOutboundAt = 0;

  return {
    saveMessage,

    async recordOutbound(msg: OutgoingMessage): Promise<void> {
      // 要记的内容在第一次等待之前取走（契约：调用之后对消息的改写不算）
      const { sessionId } = msg;
      const at = Math.max(Date.now(), lastOutboundAt + 1);
      const records = outboundRecords(msg).map(({ message, pending }, i) => ({
        message: { ...message, timestamp: at + i },
        pending,
      }));
      lastOutboundAt = Math.max(lastOutboundAt, at + records.length - 1);
      const announced: Promise<void>[] = [];
      for (const { message } of records) {
        await memory.use.saveMessage(sessionId, message);
        announced.push(announce(sessionId, message));
      }
      // 补描述等这一条的落库通知派发完再开始：改写通知赶在它前面到的话，收录它的一方（memory-vector）删不到还没收录的旧条目
      records.forEach(({ message, pending }, i) => {
        if (!pending) return;
        announced[i]
          .then(() => describeLater(sessionId, message, pending))
          .catch(err => logger.use.warn('[message-archive] 发出的附件没能补上描述，这一条不带描述:', err));
      });
    },

    async archiveIncoming(incoming: IncomingMessage) {
      // 调用 plugin-media 一站式处理（识别 attachments 并写回 _attachmentDescriptions）
      // 仅在 preprocessor 尚未运行（_attachmentDescriptions 未预设）时才调用，避免重复识别。
      // 对传入的消息对象调用（识别结果随之写回入参）：processMessage 按消息对象只处理一次，
      // 触发判定已启动的识别在这里命中（在途则等它），对拷贝调用会再识别一遍
      if (incoming.attachments && incoming.attachments.length > 0 && !incoming._attachmentDescriptions) {
        const mediaSvc = media.present ? media.use : undefined;
        if (mediaSvc) {
          const report = await mediaSvc.processMessage(incoming);
          if (debugLogs && report.total > 0) {
            logger.use.debug(`附件识别完成: ${report.successCount}/${report.total} 个成功 | ${incoming.content}`);
          }
        }
      }

      const working: IncomingMessage = {
        ...incoming,
        attachments: incoming.attachments ? incoming.attachments.map(a => ({ ...a })) : incoming.attachments,
        _attachmentDescriptions: incoming._attachmentDescriptions
          ? [...incoming._attachmentDescriptions]
          : incoming._attachmentDescriptions,
      };

      const content = buildIncomingContent(
        working,
        speakerOf(working, {
          sessionManager: sessionManager.present ? sessionManager.use : undefined,
          authority: authority.present ? authority.use : undefined,
        }),
      );

      // 把会话身份信息存入 metadata，供向量检索/上下文渲染等场景使用
      const meta: Record<string, unknown> = {};
      if (working.userId) meta[WellKnownMetadataKeys.UserId] = working.userId;
      if (working.nickname) meta[WellKnownMetadataKeys.Nickname] = working.nickname;
      if (working.platform) meta[WellKnownMetadataKeys.Platform] = working.platform;
      if (working.groupId) meta[WellKnownMetadataKeys.GroupId] = working.groupId;
      if (working.groupName) meta[WellKnownMetadataKeys.GroupName] = working.groupName;
      if (working.sessionType) meta[WellKnownMetadataKeys.SessionType] = working.sessionType;
      // 平台侧消息 ID（如 OneBot message_id），用于"引用回复"反查归档原文
      if (working.messageId) meta[WellKnownMetadataKeys.MessageId] = working.messageId;
      // 发言人写的话与附件清单：归档正文拼进了发送者前缀、引用与附件描述（给模型看），读历史给人看的一方取这两样
      if (working.content !== content) meta[WellKnownMetadataKeys.SpokenContent] = working.content;
      const roots = new Set(storage.present ? storage.use.listRoots().map(root => root.name) : []);
      const attachments = attachmentList(working, roots);
      if (attachments.length > 0) meta[WellKnownMetadataKeys.Attachments] = attachments;
      // 触发与来源溯源：用于区分真实用户消息 vs proactive 代发任务/调度等系统注入，
      // 也方便事后审计"agent 在 X 群做过什么"
      if (working.triggerType) meta.triggerType = working.triggerType;
      if (working.source) meta[WellKnownMetadataKeys.Source] = working.source;
      // 平台事件合成的入站给人看的那句：读历史的一方据此把它画成通知
      recordText(meta, working.text);
      const mentions = extractMentions(content);
      if (mentions.length > 0) meta.mentions = mentions;

      // proactive 代发任务（如 workflow agent 节点）：作为 notice 角色 + kind='cross-session-delegation' 落盘，
      // 与 plugin-agent 的 buildMessages 保持一致，避免目标会话下次回看历史时
      // 把派发任务误读为「曾经有用户说过这个」。
      //
      // 宿主通知同样落成 notice，kind='host-notice'。只归档宿主正文：注入方包好的不可信段
      // （hostNotice.untrusted）不写进消息也不写进 metadata——归档的 notice 出口转成 system，
      // 之后这个房间每一轮都看得到它，不可信段只能在当轮出现。子类、id、给界面的事实与给人看的文字另记，读历史的一方据此画通知
      if (working.hostNotice) {
        const { kind, id, facts, text } = working.hostNotice;
        meta[WellKnownMetadataKeys.HostNoticeKind] = kind;
        if (id) meta[WellKnownMetadataKeys.HostNoticeId] = id;
        if (facts) meta[WellKnownMetadataKeys.HostNoticeFacts] = facts;
        recordText(meta, text);
      }
      const directive = working.hostNotice
        ? WellKnownKinds.HostNotice
        : working.triggerType === 'proactive'
          ? WellKnownKinds.CrossSessionDelegation
          : undefined;

      // 平台事件转成的入站（如戳一戳）仍是 user 消息，子类（noticeType）记成 kind，读历史的一方据此给出通知的种类
      const message: Message = {
        role: directive ? 'notice' : 'user',
        kind: directive ?? working.noticeType,
        content,
        name: directive ? undefined : getMessageName(working.userId),
        timestamp: Date.now(),
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      };

      await memory.use.saveMessage(working.sessionId, message);

      if (debugLogs && working.attachments?.length) {
        logger.use.debug(
          `附件消息已写入记忆: session=${working.sessionId}, attachments=${working.attachments.length} | ${content}`,
        );
      }

      // 通知监听者：入站消息已落库（用于触发用户档案事实提取等后台任务）
      // 与 agent 是否回复无关，所有走 archiveIncoming 的消息都会发出
      events.use
        .emit('inbound:message:archived', {
          sessionId: working.sessionId,
          incoming: working,
          archivedMessage: message,
        })
        .catch(err => logger.use.debug(`inbound:message:archived 事件分发失败: ${err}`));

      return {
        message,
        content,
      };
    },

    async archiveNotice(opts: ArchiveNoticeOptions): Promise<Message | null> {
      const text = (opts.content ?? '').trim();
      if (!text) return null;

      const metadata: Record<string, unknown> = {};
      if (opts.subType) metadata.subType = opts.subType;
      if (opts.platform) metadata[WellKnownMetadataKeys.Platform] = opts.platform;
      if (opts.userId) metadata[WellKnownMetadataKeys.UserId] = opts.userId;
      if (opts.targetId) metadata.targetId = opts.targetId;
      if (opts.groupId) metadata[WellKnownMetadataKeys.GroupId] = opts.groupId;
      if (opts.operatorId) metadata.operatorId = opts.operatorId;
      if (opts.data) Object.assign(metadata, opts.data);
      recordText(metadata, opts.text);

      const message: Message = {
        role: 'notice',
        kind: opts.noticeType,
        content: text,
        timestamp: opts.timestamp ?? Date.now(),
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };

      await memory.use.saveMessage(opts.sessionId, message);

      if (debugLogs) {
        logger.use.debug(
          `[notice 入档] session=${opts.sessionId} type=${opts.noticeType}${opts.subType ? `/${opts.subType}` : ''} | ${text}`,
        );
      }

      return message;
    },

    async findByMessageId(sessionId: string, messageId: string, scanLimit?: number): Promise<Message | null> {
      if (!messageId) return null;
      // 缺省 100；撤回反查按需显式传大窗（见 onebot 撤回处）。不把缺省抬到 500：
      // 引用回填热路径也调本方法并按 maxDepth 递归，抬缺省会让它每层多扫 400 条。
      const limit = Math.max(1, Math.min(500, Math.floor(scanLimit ?? 100)));
      const history = await memory.use.getHistory(sessionId, limit);
      // 从最新往旧找：引用通常指向最近发的消息
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const m = history[i];
        const mid = m.metadata?.[WellKnownMetadataKeys.MessageId];
        if (mid != null && String(mid) === messageId) return m;
      }
      return null;
    },
  };
}
