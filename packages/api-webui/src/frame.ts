// ----- 插件前端 -----
//
// 页面默认声明式；声明式表达不了时，插件可以自带一份静态网页（插件前端），只放在插件页面与会话面板两个位置。
// webui-server 托管它的文件，宿主把它画进 iframe，与宿主页面不同源：拿不到登录状态，发不出网络请求、取不到外站资源。
// 它能做的事只有一条路：经消息通道请宿主代办，调这一页声明过的数据源与动作，或用申请过的宿主数据能力。
//
// 本文件是这条通道的公开契约：协议版本、沙箱值、宿主数据能力的词表与能力表、消息类型与消息的校验函数。
// 校验函数是不碰 DOM 的纯函数，宿主前端与第三方宿主前端共用，换前端时规则不漂；在途与频率上限、确认框与外链对话框
// 涉及界面与计时，由各宿主前端照文档实现。第一版标 experimental：只做加法，加字段、加消息升次版本。
//
// 托管（webui-server，不要登录）：
// GET /frames/:token/<路径>    插件包 webui/ 里的文件；token 是页面登记时随机生成的，页面撤回或重新登记后旧的回 404
// GET /frames/_base/<路径>     宿主给框架的公用文件：助手 frame.js 与样式基线 frame.css，随本包发布

import type { SessionMethodParams, SessionMethodResult, SessionNotificationParams } from '@aalis/api-session-protocol';
import type { ThemeKind, ThemeToken } from './theme.js';

/** 消息通道的协议版本 `<主>.<次>`：握手时主版本不同，宿主卸载框架 */
export const FRAME_PROTOCOL_VERSION = '1.0';

/**
 * 框架的沙箱值：宿主 iframe 的 sandbox 属性与框架文件响应头 CSP 的 sandbox 指令同一份。只给脚本，
 * 不给 allow-same-origin（与 allow-scripts 同给时框架能自己摘掉沙箱），也不给表单、弹窗、原生对话框、顶层跳转与下载
 */
export const FRAME_SANDBOX = 'allow-scripts';

/**
 * 宿主数据能力的词表，封闭集合，按加法扩：
 * - `sessions:read`：读会话树与状态（请求 `sessions.list`，挂载起收到 `sessions.changed`）；
 * - `turn:abort`：停止会话的回合（请求 `turn.abort`）。
 * 申请了的框架与 owner 自己的界面看得一样多，不按会话收窄
 */
export const FRAME_HOST_CAPABILITIES = ['sessions:read', 'turn:abort'] as const;

export type FrameHostCapability = (typeof FRAME_HOST_CAPABILITIES)[number];

/** 名字（数据源名、动作名）最多这么多个字符 */
export const FRAME_NAME_MAX_LENGTH = 128;
/** 标识（会话 id、回合 id、翻页游标、握手的随机数）最多这么多个字符 */
export const FRAME_ID_MAX_LENGTH = 256;
/** 地址最多这么多个字符 */
export const FRAME_URL_MAX_LENGTH = 2048;

// ----- 框架 → 宿主 -----
//
// hello 是窗口消息（parent.postMessage(…, '*')），其余都走握手后交给框架的端口。请求带 id（框架自选的整数，在途的
// 不重复），宿主回 result。实例、页面与会话面板的会话一律取宿主挂载时的值，消息里没有这些字段，带了就是多余的键。

/** 握手：nonce 是宿主放在框架地址片段里的随机数 */
export interface FrameHello {
  type: 'hello';
  protocol: string;
  nonce: string;
}

/** 取这一页一个数据源的数据：数据源名与输入由宿主照原样交给服务端核 */
export interface FrameDataRequest {
  type: 'data';
  id: number;
  source: string;
  input?: Record<string, unknown>;
}

/** 调这一页的一个动作：destructive 的先由宿主弹确认框，框里按输入字段列出这次的值 */
export interface FrameActionRequest {
  type: 'action';
  id: number;
  action: string;
  input?: Record<string, unknown>;
}

/** 请宿主打开：外站地址（只许 http、https，与宿主同源的不收）经宿主的对话框由用户点开；会话在应用内打开 */
export interface FrameOpenRequest {
  type: 'open';
  id: number;
  target: { url: string } | { session: string };
}

/** 列会话（要 sessions:read）：只透传会话协议 sessions/list 的这四个参数 */
export type FrameSessionsListRequest = { type: 'sessions.list'; id: number } & Pick<
  SessionMethodParams<'sessions/list'>,
  'parentId' | 'archived' | 'cursor' | 'limit'
>;

/** 停止一个会话的回合（要 turn:abort）：参数同会话协议的 turn/abort */
export type FrameTurnAbortRequest = { type: 'turn.abort'; id: number } & SessionMethodParams<'turn/abort'>;

/** 框架文档正在被替换（离开了宿主给它的地址）：宿主立即卸载，不回 */
export interface FrameLeaving {
  type: 'leaving';
}

/** 框架发的请求 */
export type FrameRequest =
  | FrameDataRequest
  | FrameActionRequest
  | FrameOpenRequest
  | FrameSessionsListRequest
  | FrameTurnAbortRequest;

/** 框架经端口发的消息 */
export type FrameMessage = FrameRequest | FrameLeaving;

// ----- 宿主 → 框架 -----

/**
 * 请求失败的原因，封闭集合：
 * - `invalid`：消息或输入不对（转发的 HTTP 400、414、431）；
 * - `denied`：没申请的能力；这个框架已开着一个宿主对话框时，再请求外链或要确认的动作；
 * - `not-found`：页面、会话、数据源或动作不在（HTTP 404）；
 * - `busy`：超出在途上限；
 * - `cancelled`：用户在宿主的确认框或外链对话框里取消；
 * - `unavailable`：会话服务不在、连接断开（HTTP 503 与连不上）；
 * - `failed`：插件的处理函数或宿主服务出错（其余 4xx 与 5xx），message 写原因。
 */
export type FrameErrorCode = 'invalid' | 'denied' | 'not-found' | 'busy' | 'cancelled' | 'unavailable' | 'failed';

/** 当前主题：深浅与主题令牌的值（THEME_TOKENS 里的名字到值）。尺寸不传，框架在同一个浏览器里自己求值 */
export interface FrameTheme {
  kind: ThemeKind;
  tokens: Record<ThemeToken, string>;
}

/** 握手时随端口交出；sessionId 只给会话面板，换会话时宿主重新挂载 */
export interface FrameInit {
  type: 'init';
  protocol: string;
  experimental: true;
  sessionId?: string;
  theme: FrameTheme;
}

/** 回一个请求 */
export type FrameResult = { type: 'result'; id: number } & (
  | { ok: true; value: unknown }
  | { ok: false; error: { code: FrameErrorCode; message: string } }
);

/** 主题切换，或跟随系统时深浅变了 */
export type FrameThemeChange = { type: 'theme' } & FrameTheme;

/**
 * 数据变了，重取：带 source 时只重取这个数据源。插件调了 invalidate 时推，带会话的只推给挂在那个会话上的框架；
 * 会话或管理连接断线重连后，给每个框架推一次不带 source 的，意思是全部重取（含会话列表）
 */
export interface FrameInvalidate {
  type: 'invalidate';
  source?: string;
}

/** 会话列表的增量（申请了 sessions:read 的框架挂载起就收）：转发会话协议的 sessions/changed，不带 groups */
export type FrameSessionsChanged = { type: 'sessions.changed' } & Omit<
  SessionNotificationParams<'sessions/changed'>,
  'groups'
>;

/** 宿主经端口发给框架的消息 */
export type FrameHostMessage = FrameInit | FrameResult | FrameThemeChange | FrameInvalidate | FrameSessionsChanged;

// ----- 框架侧的助手 -----
//
// GET /frames/_base/frame.js 是给插件前端用的浏览器模块，随本包发布，不用构建就能导入：
//   import { connect } from '/frames/_base/frame.js';
//   const frame = await connect();
// 它握手，把主题令牌写到根元素上（设 data-theme 与 color-scheme，主题变了跟着更新），按 id 配对请求，在 pagehide 时
// 发 leaving；不画界面、不缓存数据、不改地址。用 TypeScript 写插件前端时从这里取类型。

/** connect() 给出的连接。请求失败时抛出 Error，带 code（FrameErrorCode） */
export interface FrameClient {
  /** 会话面板挂在哪个会话上；插件页面没有 */
  readonly sessionId?: string;
  /** 取这一页一个数据源的数据 */
  data(source: string, input?: Record<string, unknown>): Promise<unknown>;
  /** 调这一页的一个动作，回处理函数给的一句话或 null；destructive 的由宿主先弹确认框，取消时抛 cancelled */
  action(name: string, input?: Record<string, unknown>): Promise<string | null>;
  /** 请宿主打开外站地址（经宿主的对话框）或应用内的会话 */
  open(target: FrameOpenRequest['target']): Promise<void>;
  /** 数据变了：带 source 时只重取这个数据源，不带时全部重取。回退订 */
  onInvalidate(listener: (source?: string) => void): () => void;
  /** 列会话（要 sessions:read） */
  listSessions(
    params?: Omit<FrameSessionsListRequest, 'type' | 'id'>,
  ): Promise<Omit<SessionMethodResult<'sessions/list'>, 'groups'>>;
  /** 会话列表的增量（要 sessions:read）。回退订 */
  onSessionsChanged(listener: (change: Omit<FrameSessionsChanged, 'type'>) => void): () => void;
  /** 停止一个会话的回合（要 turn:abort） */
  abortTurn(params: Omit<FrameTurnAbortRequest, 'type' | 'id'>): Promise<void>;
}

/**
 * 能力表：每种请求与推送要哪种宿主数据能力，null 为不要。宿主转发请求前按页面的 `frame.host` 核，没申请的回 denied；
 * 推送只发给申请了的框架
 */
export const FRAME_REQUIRED_CAPABILITY: Readonly<
  Record<FrameRequest['type'] | FrameSessionsChanged['type'], FrameHostCapability | null>
> = {
  data: null,
  action: null,
  open: null,
  'sessions.list': 'sessions:read',
  'turn.abort': 'turn:abort',
  'sessions.changed': 'sessions:read',
};

// ----- 校验 -----

/** 校验的结果：不过时给出原因；消息里认得出请求 id 时一并给出，宿主据它回 invalid */
export type FrameParseResult<T> = { ok: true; message: T } | { ok: false; id?: number; problem: string };

/** 一个字段的规则：合格回 undefined，不合格回原因 */
type Rule = (value: unknown) => string | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text =
  (max: number): Rule =>
  value =>
    typeof value === 'string' && value !== '' && value.length <= max ? undefined : `要是 1 到 ${max} 个字符的字符串`;
const name = text(FRAME_NAME_MAX_LENGTH);
const ident = text(FRAME_ID_MAX_LENGTH);
const integer: Rule = value => (Number.isSafeInteger(value) ? undefined : '要是整数');
const flag: Rule = value => (typeof value === 'boolean' ? undefined : '要是布尔值');
const object: Rule = value => (isRecord(value) ? undefined : '要是对象');
const version: Rule = value =>
  typeof value === 'string' && /^\d{1,4}\.\d{1,4}$/.test(value) ? undefined : '要是「主.次」形式的版本';

/** 外站地址：http 或 https 的绝对地址。与宿主同源的由宿主按自己的来源再拒 */
function webUrl(value: unknown): string | undefined {
  const problem = text(FRAME_URL_MAX_LENGTH)(value);
  if (problem) return problem;
  try {
    const { protocol } = new URL(value as string);
    return protocol === 'http:' || protocol === 'https:' ? undefined : '只许 http、https 地址';
  } catch {
    return '不是绝对地址';
  }
}

const target: Rule = value => {
  if (!isRecord(value) || Object.keys(value).length !== 1) return '要是 { url } 或 { session }';
  if ('url' in value) return webUrl(value.url);
  if ('session' in value) return ident(value.session);
  return '要是 { url } 或 { session }';
};

/** 每种消息的字段：键 → [规则, 是否必填]；type 以外的键都要在表里 */
type Fields = Record<string, readonly [Rule, boolean]>;

const HELLO_FIELDS: { hello: Fields } = {
  hello: { protocol: [version, true], nonce: [ident, true] },
};

const MESSAGE_FIELDS: { [T in FrameMessage['type']]: Fields } = {
  data: { id: [integer, true], source: [name, true], input: [object, false] },
  action: { id: [integer, true], action: [name, true], input: [object, false] },
  open: { id: [integer, true], target: [target, true] },
  'sessions.list': {
    id: [integer, true],
    parentId: [ident, false],
    archived: [flag, false],
    cursor: [ident, false],
    limit: [integer, false],
  },
  'turn.abort': { id: [integer, true], sessionId: [ident, true], turnId: [ident, false] },
  leaving: {},
};

function parse<T>(value: unknown, table: Record<string, Fields>): FrameParseResult<T> {
  if (!isRecord(value)) return { ok: false, problem: '消息要是对象' };
  const id = Number.isSafeInteger(value.id) ? (value.id as number) : undefined;
  const fail = (problem: string): FrameParseResult<T> => ({ ok: false, ...(id === undefined ? {} : { id }), problem });
  const fields = typeof value.type === 'string' && Object.hasOwn(table, value.type) ? table[value.type] : undefined;
  if (!fields) return fail(`不认识的消息 ${String(value.type)}`);
  for (const key of Object.keys(value)) {
    if (key !== 'type' && !Object.hasOwn(fields, key)) return fail(`多余的键：${key}`);
  }
  for (const [key, [rule, required]] of Object.entries(fields)) {
    if (value[key] === undefined) {
      if (required) return fail(`缺少 ${key}`);
      continue;
    }
    const problem = rule(value[key]);
    if (problem) return fail(`${key} ${problem}`);
  }
  return { ok: true, message: value as T };
}

/** 校验框架发来的握手（窗口消息）。来源窗口、nonce 与主版本由宿主另核；不过的窗口消息一律忽略 */
export const parseFrameHello = (value: unknown): FrameParseResult<FrameHello> => parse(value, HELLO_FIELDS);

/** 校验框架经端口发来的消息：类型标记、字段类型、多余的键与字符串长度；不过的请求回 invalid，不往下走 */
export const parseFrameMessage = (value: unknown): FrameParseResult<FrameMessage> => parse(value, MESSAGE_FIELDS);
