// ============================================================
// @aalis/plugin-image-sender — 让 agent 主动发送图片/语音/视频
//
// 工具：
//   1. preview_image    —— 在选图前用 vision 看清候选图（搜索结果标题常误导）
//   2. send_attachment  —— 统一的出站附件接口：把 image/audio/video 发出去；
//                          送达之后由 message-archive 记进会话历史（recordOutbound），
//                          让"AI 之前发过的图/视频"能被 memory_recall 召回
//
// 出站中间件：带 markup 的正文（她的回复）里存储地址的媒体标记（<image|video|record url>）转成附件，受众只有 owner 的会话
// 不过判据，其余会话按 send_attachment 的判据、不带授权身份，转之前同样核文件头；只摘掉转成了附件的标记，别的留在正文里交给
// 适配器。
//
// send_attachment 来源：url / storage_uri / history_ref（不接受裸本地路径）；
// 存储库里的文件先过媒体判据（@aalis/api-media 的 mediaScopeOf：别的会话的媒体按会话管理的取用规则，本机文件按这一轮的
// 主体，多人的一轮逐个参与者判、有人过不了时发参与者审批），再读文件头核对格式（见 @aalis/util-media-signature）。
// 此插件不直接调用平台 API，而是 emit `outbound:message`（含 attachments[]）；
// 由各 platform adapter（OneBot / WebUI）按自身能力处理结构化附件。
// ============================================================

import { authority } from '@aalis/api-authority';
import type {} from '@aalis/api-gateway'; // declaration merging 锚点（outbound:dispatch 钩子）
import { hooks } from '@aalis/api-hooks';
import { historyMediaRefs, media, mediaRef, mediaScopeOf } from '@aalis/api-media';
import { memory } from '@aalis/api-memory';
import { roomClass, sessionManager } from '@aalis/api-session-manager';
import { isStorageNotFound, isStorageUri, storage } from '@aalis/api-storage';
import { actingIdentity, tools } from '@aalis/api-tools';
import { type BoundOf, definePlugin, events, logger, optional } from '@aalis/core';
import { toSource } from '@aalis/schema-i18n';
import { awaitDelivery, type Message, type MessageAttachment, type OutgoingMessage } from '@aalis/schema-message';
import { checkMediaHead, MEDIA_HEAD_BYTES, type MediaKind } from '@aalis/util-media-signature';

/** preview_image 单张候选识别等待上限。preview 的目的就是"看清"图，
 *  本地视觉模型（如 33B）单图常需 15-25s，必须给足预算，否则必然超时使 preview 形同虚设。 */
const PREVIEW_TIMEOUT_MS = 25_000;
/** preview_image 单次允许的候选数量上限。 */
const PREVIEW_MAX_CANDIDATES = 8;
/** 过不了媒体判据时回给模型的话：先判后读，不存在与不是媒体也回这一句，拿它探测不出存储根里有什么 */
const OUT_OF_SCOPE =
  '这个文件不在这一轮能取的范围里：别的会话的媒体按这个会话的取用范围与开关；本机文件要这一轮里有 owner 的话、有别人时经她批准，或是 owner 授权的自动运行且会话里没有别人';
/** 判媒体归属与找 history_ref 回看的历史条数 */
const HISTORY_LIMIT = 200;
/** 回复正文里的媒体标记：与 onebot 适配器解析的写法相同 */
const MEDIA_MARKUP = /<(image|video|record)\s+url=["']([^"']*)["']\s*\/>/g;
const MARKUP_KIND: Record<string, MediaKind> = { image: 'image', video: 'video', record: 'audio' };

// tools 与 hooks 不入激活闸：工具与中间件登记走注册账本，提供者上线后自动补挂。
// 会话管理、权限与记忆给媒体判据用，缺席时判据按它的约定取值（不取别的会话的、主体是 other、没人是 owner、历史为空）。
const uses = {
  tools: optional(tools),
  hooks: optional(hooks),
  events,
  logger,
  storage: optional(storage),
  media: optional(media),
  memory: optional(memory),
  sessionManager: optional(sessionManager),
  authority: optional(authority),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-image-sender',
  displayName: '图片发送',
  subsystem: 'tools',
  uses,
  apply: registerImageSender,
});

function registerImageSender(caps: Caps): void {
  const { tools, hooks, events, logger, media, memory, sessionManager, authority } = caps;
  const storage = caps.storage.use;

  /** 调用所在会话最近的历史：记忆不在时为空 */
  async function recentHistory(sessionId: string): Promise<Message[]> {
    if (!memory.present) return [];
    const service = memory.use;
    return service.getFullHistory
      ? service.getFullHistory(sessionId, HISTORY_LIMIT)
      : service.getHistory(sessionId, HISTORY_LIMIT);
  }

  /** owner 判定：权限服务不在时恒为否 */
  const isOwner = (platform: string, userId: string) => authority.present && authority.use.isOwner(platform, userId);

  /** 媒体判据要的服务：每次判时按一次调用交给 mediaScopeOf（工具交这次调用，回复里的标记不带授权身份） */
  const scopeServices = { sessionManager, authority, history: recentHistory };

  // 核对存储库内的文件能否按 kind 发送：只读文件头，按 kind 核对格式，不符拒发（存储根里还有配置、令牌、
  // 记忆库等非媒体文件）。放行的交出 storage URI，送达形态由平台适配器决定：onebot 读回内容内联，超过内联上限
  // 时再核对一次文件头才交宿主路径；预先换成 file:// 的话，适配器落不了盘的大文件只能原样透传、无从核对
  async function loadStorageMedia(
    uri: string,
    kind: MediaKind,
  ): Promise<{ ok: true; data: string } | { ok: false; error: string }> {
    let head: Uint8Array;
    try {
      head = await storage.readFileRange(uri, 0, MEDIA_HEAD_BYTES);
    } catch (err) {
      if (isStorageNotFound(err)) return { ok: false, error: `存储资源不存在: ${uri}` };
      throw err;
    }
    const rejection = checkMediaHead(head, kind);
    if (rejection) return { ok: false, error: rejection };
    return { ok: true, data: uri };
  }

  // ── preview_image ─────────────────────────────────────────────────────────
  // 识别全靠 media：media 在场才挂，离场即撤（follow 在 media 上线 / 换人时各调一次，
  // 返回的退订函数即清理），media 缺席的部署里 agent 看不到这个用不了的工具。
  media.follow(service =>
    tools.use.register({
      definition: {
        type: 'function',
        function: {
          name: 'preview_image',
          description:
            '在真正发送前，先让自己"看见"候选图片的实际内容（vision 模型识别）。' +
            '适用场景：search_images 返回了若干 URL，但标题常常误导/含糊，' +
            '你想从中挑出最符合语境的一张再 send_attachment 发出。' +
            '本工具不发送任何消息，只返回每张图的描述。',
          parameters: {
            type: 'object',
            properties: {
              urls: {
                type: 'array',
                items: { type: 'string' },
                description: `要识别的图片 URL 列表（http/https），最多 ${PREVIEW_MAX_CANDIDATES} 张。`,
              },
              hint: {
                type: 'string',
                description: '可选：给 vision 模型的关注点提示（例如"这张图里有猫吗"）。',
              },
            },
            required: ['urls'],
          },
        },
      },
      handler: async args => {
        const urls = Array.isArray(args.urls) ? (args.urls as unknown[]).map(String) : [];
        const hint = (args.hint as string) || undefined;
        if (urls.length === 0) return JSON.stringify({ error: 'urls 不能为空' });
        if (urls.length > PREVIEW_MAX_CANDIDATES) {
          return JSON.stringify({ error: `最多 ${PREVIEW_MAX_CANDIDATES} 张` });
        }

        // 顺序识别（非并发）：本地视觉模型通常单实例串行处理，并发只会让多个请求
        // 互相排队、共同超时；逐张识别配合宽松超时，命中率远高于并发。
        // detailLevel='casual'：preview 只为"挑图"，短 prompt 短输出即可，不需要 auto 档的详尽路由。
        const results: Array<Record<string, unknown>> = [];
        for (let index = 0; index < urls.length; index++) {
          const trimmed = urls[index].trim();
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            results.push({ index, url: trimmed, ok: false, error: 'url 必须是 http/https' });
            continue;
          }
          try {
            const desc = await Promise.race([
              service.describeImage(trimmed, { hint, detailLevel: 'casual' }),
              new Promise<string>((_resolve, reject) =>
                setTimeout(() => reject(new Error('vision 超时')), PREVIEW_TIMEOUT_MS),
              ),
            ]);
            const description = (desc ?? '').trim();
            results.push(
              description
                ? { index, url: trimmed, ok: true, description }
                : { index, url: trimmed, ok: false, error: 'vision 返回空' },
            );
          } catch (err) {
            results.push({ index, url: trimmed, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return JSON.stringify({ ok: true, count: results.length, results });
      },
    }),
  );

  // ── send_attachment ───────────────────────────────────────────────────────
  tools.use.register({
    definition: {
      type: 'function',
      function: {
        name: 'send_attachment',
        description:
          '主动向当前会话发送一个附件（图片 / 语音 / 视频，仅附件本身，不带文字）。\n' +
          '使用场景：用户请求"发个表情包"、"发刚才那张图/那段语音给我"、"在网上找张猫的图"等。\n' +
          'kind 必填，指定附件类型；来源三选一：\n' +
          '  - url：网络资源 URL（http/https）。\n' +
          '  - storage_uri：存储库内的资源 URI（如 data:/images/xxx）。\n' +
          '  - history_ref：本会话历史消息中的引用（[图片/音频/视频: ... | ref:xxx] 中完整的 xxx），\n' +
          '    用于"把之前那条媒体重发/转发回去"。\n' +
          'storage_uri 能指向本会话收到或产生的媒体；别的会话的媒体按 owner 给这个会话设的取用范围与开关；' +
          '不属于任何会话的本机文件要这一轮里有 owner 的话（有别人的话一起进来时要她批），' +
          '或这一轮是按 owner 的授权自动运行的（如她建的定时任务）而所在会话里没有别人。history_ref 只在本会话历史里找。\n' +
          '建议流程（图片）：search_images 拿候选 URL →（有 preview_image 时可先看清内容）→ send_attachment 选其一发出。\n' +
          '只有返回 ok:true 才能说已发送；返回 error 时没有成功确认，下载失败可改选另一张图片，不要反复重发同一失效地址。\n' +
          '若想重发自己之前在本会话发过的媒体，先用 memory_recall 按描述检索历史，从命中消息里找到 ref 再传 history_ref。\n' +
          '注意：本工具不发送任何文字。如需配文，请把文字写在你本轮最终输出的 message 字段里——' +
          '不要在 message 中重复媒体描述。',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['image', 'audio', 'video'],
              description: '附件类型：image=图片，audio=语音，video=视频。',
            },
            url: { type: 'string', description: '网络资源 URL（http/https）。' },
            storage_uri: { type: 'string', description: '存储库内资源 URI（如 data:/images/xxx）。' },
            history_ref: {
              type: 'string',
              description: '本会话历史消息中的引用路径（[... | ref:xxx] 中完整的 xxx）。',
            },
          },
          required: ['kind'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const kind = (args.kind as string)?.trim() as MediaKind;
      if (kind !== 'image' && kind !== 'audio' && kind !== 'video') {
        return JSON.stringify({ error: 'kind 必须是 image / audio / video 之一' });
      }
      const url = (args.url as string)?.trim();
      const storageUri = (args.storage_uri as string)?.trim();
      const historyRef = (args.history_ref as string)?.trim();

      let data: string | null = null;
      let refTag: string | null = null;
      let via: 'url' | 'storage_uri' | 'history_ref' = 'url';
      try {
        if (url) {
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return JSON.stringify({ error: 'url 必须是 http/https 开头' });
          }
          data = url;
          refTag = url;
          via = 'url';
        } else if (storageUri) {
          // 先判后读：判据、读取与附件引用用同一个规整后的地址
          const uri = mediaRef(storageUri);
          if (!uri || !isStorageUri(uri)) {
            return JSON.stringify({ error: 'storage_uri 要写存储地址（如 data:/images/…），不能写本机路径' });
          }
          if (!(await mediaScopeOf(callCtx, scopeServices)(uri))) return JSON.stringify({ error: OUT_OF_SCOPE });
          const loaded = await loadStorageMedia(uri, kind);
          if (!loaded.ok) return JSON.stringify({ error: loaded.error });
          data = loaded.data;
          refTag = uri;
          via = 'storage_uri';
        } else if (historyRef) {
          refTag = historyRef.replace(/^ref:/, '').trim();
          // 网址照旧当 url 用；其余只在调用所在会话历史里系统记下的引用中按全等找。找到的就是判据第 1 类里的历史引用，
          // 不再另判
          const ref = mediaRef(refTag);
          if (ref && !isStorageUri(ref)) {
            data = ref;
          } else if (!ref || !historyMediaRefs(await recentHistory(callCtx.sessionId)).includes(ref)) {
            return JSON.stringify({ error: `未在本会话历史中找到引用: ${historyRef}` });
          } else {
            const loaded = await loadStorageMedia(ref, kind);
            if (!loaded.ok) return JSON.stringify({ error: loaded.error });
            data = loaded.data;
          }
          via = 'history_ref';
        } else {
          return JSON.stringify({ error: '必须提供 url / storage_uri / history_ref 之一' });
        }

        // 等待传输确认，不等识图：送达之后由 message-archive 记进会话历史，网址的图在后台补描述。
        // ref 是稳定的地址，平台落盘后改写 data 也不影响记进历史的那一份
        const attachment: MessageAttachment = { kind, data, ref: refTag ?? data };
        const outgoing: OutgoingMessage = {
          sessionId: callCtx.sessionId,
          platform: callCtx.platform,
          content: '',
          attachments: [attachment],
          source: 'agent',
          turnId: callCtx.turnId,
          callId: callCtx.callId,
        };
        await events.use.emit('outbound:message', outgoing);
        if (!outgoing.delivery) return JSON.stringify({ error: '没有目标适配器确认附件发送，请勿声称已发出' });
        const result = await awaitDelivery(outgoing.delivery, callCtx.signal);
        if (!result) return JSON.stringify({ error: '附件仍在发送，结果未确认，请勿重发' });
        if (!result.ok) {
          return JSON.stringify({
            error: result.unconfirmed ? '附件发送结果未知（可能已经送达），请勿重发' : toSource(result.error),
          });
        }

        return JSON.stringify({ ok: true, sent: { kind, via, ref: refTag } });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  logger.use.info('[image-sender] 工具 send_attachment 已注册（preview_image 随 media 在场注册）');

  // ── 带 markup 的正文里的媒体标记：存储地址的转成附件 ─────────────────────────────────
  // 适配器只解析带 markup 的正文（她的回复）；onebot 只把网址的标记经受保护下载与文件头核对后内联，其余地址的去掉并报投递失败，
  // 存储里的媒体要靠这里转成附件才发得出。存储地址在受众只有 owner 的会话里不过判据：发给 owner 看不越权；其余会话过判据，出站
  // 不带授权身份：别的会话的按不带授权身份的取用规则判，本机文件不能取；会话管理不在时判不出受众，按不是只有 owner。转之前与
  // send_attachment 一样核文件头。这里只摘掉转成了附件的标记：不过判据、读不出、不是对应媒体的与别的写法（网址、file://、
  // 本机路径、data URI 等）都留在正文里，去不去掉由适配器定；摘掉标记后两边的文字拼出的新标记同样留给它，它在解析出的消息段上
  // 判。转出的附件与别的附件一样，送达之后记进会话历史。网关缺席时出站不经这条链，存储地址的标记由适配器去掉、发不出
  hooks.use.middleware('outbound:dispatch', async ({ message }, next) => {
    if (message.markup) await markupToAttachments(message);
    await next();
  });

  async function markupToAttachments(message: OutgoingMessage): Promise<void> {
    // 各标记的存储地址：不是存储地址的为 undefined
    const tags = [...message.content.matchAll(MEDIA_MARKUP)].map(([, tag, url]) => {
      const ref = mediaRef(url);
      return { kind: MARKUP_KIND[tag], ref: ref && isStorageUri(ref) ? ref : undefined };
    });
    if (!tags.some(({ ref }) => ref)) return;
    const call = { sessionId: message.sessionId, participants: [] };
    const inScope = mediaScopeOf({ ...call, approveFor: async check => check(actingIdentity(call)) }, scopeServices);
    const getSession = (id: string) => sessionManager.use.getSession(id);
    const ownerOnly =
      sessionManager.present && roomClass(getSession(message.sessionId), getSession, isOwner) === 'owner-only';
    // 各标记转成的附件：没转成的为 undefined，标记留在正文里
    const converted: Array<MessageAttachment | undefined> = [];
    for (const { kind, ref } of tags) {
      converted.push(
        ref && (await markupMediaAllowed(ref, kind, ownerOnly, inScope)) ? { kind, data: ref } : undefined,
      );
    }
    let i = 0;
    message.content = message.content.replace(MEDIA_MARKUP, whole => (converted[i++] ? '' : whole));
    message.attachments = [...(message.attachments ?? []), ...converted.filter(att => att !== undefined)];
  }

  /**
   * 回复里存储地址的标记能不能转成附件：受众只有 owner 的会话不过判据，其余不带授权身份判；再按 kind 核文件头。判不出、读不出
   * （如读历史出错、根不存在）的按不能，标记留在正文里
   */
  async function markupMediaAllowed(
    uri: string,
    kind: MediaKind,
    ownerOnly: boolean,
    inScope: (uri: string) => Promise<boolean>,
  ): Promise<boolean> {
    try {
      if (!ownerOnly && !(await inScope(uri))) return false;
      return (await loadStorageMedia(uri, kind)).ok;
    } catch (err) {
      logger.use.warn(
        `[image-sender] 回复里的媒体标记判不出归属或读不出，不转成附件: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }
}
