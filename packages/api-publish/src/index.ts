// ============================================================
// @aalis/api-publish — 作品发布契约
//
// 提名方（如 plugin-paper）经 publish 服务提名作品，提供者（plugin-publish-review）审核并维护发布账本，
// 展示面（如 plugin-works-site）登记自己、读已发布的作品并回报上线。契约不涉及白纸、Cloudflare 与 Pages：
// 提名输入是「来源描述、隔离组、文件快照」，隔离组键不透明。
//
// 另带两份数据，各消费方共用、不各写一份：公开路径规则（审核按它收，展示面部署前再判一次）；
// 作品与展示页的响应头策略（展示面的中间件与 _headers、审核的本机隔离预览）。
// ============================================================

import type { ServiceRef } from '@aalis/core';
import { defineService, serviceRef } from '@aalis/core';

// ----- 作品编号与公开路径 -----

/** 作品编号：10 位 [a-z2-7]，由提供者生成 */
export const WORK_ID_PATTERN = /^[a-z2-7]{10}$/;

/**
 * 公开路径允许的扩展名（小写、不带点）与 Content-Type。不收 wasm（作品的 CSP 没有 'wasm-unsafe-eval'）
 * 与音频（审核不听声音）。没有原型：按扩展名查表时 `constructor`、`__proto__` 这类名字取不到东西。
 */
export const PUBLIC_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    woff2: 'font/woff2',
  }),
);

const MAX_PATH_LENGTH = 200;
const MAX_SEGMENTS = 4;
/** 不以点、下划线、连字符开头，不含空格与非 ASCII，每段至多 64 字符 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 静态站点托管按名字特殊处理的文件与目录。首字符规则已排除这些文件名，显式列出作纵深防御 */
const RESERVED_NAMES = new Set(['_headers', '_redirects', '_worker.js', '_routes.json', '.assetsignore']);
const RESERVED_TOP = 'functions';

/**
 * 作品目录内的相对路径能否上站；不能时返回原因。审核按它收，展示面部署前再判一次。
 *
 * 原因只写类别、不回显路径：路径来自远端给的文件名，拒绝理由会经工具回执进模型上下文。
 * 同一作品内的路径按小写比较不得重复，由调用方对整组路径判定（公开根可能在大小写不敏感的文件系统上）。
 */
export function publicPathProblem(path: string): string | undefined {
  if (path === '') return '路径为空';
  if (path.length > MAX_PATH_LENGTH) return '路径过长';
  if (path.startsWith('/') || path.endsWith('/')) return '路径以斜杠开头或结尾';
  const segments = path.split('/');
  if (segments.length > MAX_SEGMENTS) return '路径层级过多';
  if (segments.some(s => RESERVED_NAMES.has(s.toLowerCase()))) return '路径含保留的文件名';
  if (segments[0].toLowerCase() === RESERVED_TOP) return '路径占用了保留的目录名';
  if (!segments.every(s => SEGMENT.test(s))) return '路径段含不允许的字符';
  const name = segments[segments.length - 1];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!Object.hasOwn(PUBLIC_CONTENT_TYPES, ext)) return '扩展名不在白名单';
  if (ext === 'html' && path !== 'index.html') return '网页文件只能是作品根目录的 index.html';
  return undefined;
}

// ----- 提名与已发布作品 -----

export interface PublishFile {
  /** 作品目录内的相对路径，须过 {@link publicPathProblem} */
  path: string;
  bytes: Uint8Array;
}

export interface PublishOrigin {
  /** 提名方插件实例 id（审计） */
  producer: string;
  /** 提名方内部引用（审计，只在本机） */
  ref: string;
  /** owner 在 WebUI 看到的来源称呼 */
  label: string;
  /** 结论送回的房间；缺省不通知 */
  notify?: { sessionId: string; platform: string };
  /** 提名人（审计，只在本机） */
  actorKey?: string;
}

export interface NominateInput {
  origin: PublishOrigin;
  /** 隔离组键（不透明）：同组作品可以同源，不同组绝不同源 */
  group: string;
  /** owner 可见的组称呼 */
  groupLabel: string;
  /** 要上的展示面，如 ['works'] */
  surfaces: string[];
  /** 1–40 字 */
  title: string;
  /** 0–300 字 */
  summary: string;
  /** 署名，由提名方给 */
  credit: string;
  files: PublishFile[];
  /** 封面（只收位图）：照常审核，只用来生成缩略图，不作为作品文件上站 */
  cover?: Uint8Array;
}

/** refused 只写类别，不含路径与文件名；fileIndex 是出问题的 files 下标（从 0 起），-1 为封面 */
export type NominateResult = { id: string } | { refused: string; fileIndex?: number };

export type WorkKind = 'media' | 'html';

export interface PublishedItem {
  id: string;
  group: string;
  groupLabel: string;
  surfaces: string[];
  kind: WorkKind;
  title: string;
  summary: string;
  credit: string;
  publishedAt: number;
  files: Array<{ path: string; size: number; contentType: string }>;
  /** 生成得了缩略图时为真 */
  hasThumbnail: boolean;
}

export type ItemState =
  | 'queued'
  | 'checking'
  | 'awaiting-owner'
  | 'published'
  | 'withdrawn'
  | 'rejected'
  | 'expired'
  | 'failed';

// ----- 展示面 -----

export interface PublishSurface {
  /** 展示面名，与 NominateInput.surfaces、listPublished 的参数对应 */
  name: string;
  /** 作品在这个展示面上的公开网址（上线通知里给出） */
  urlFor(id: string): string;
  /** 现在能不能把变化送上线；暂停、鉴权失败、状态文件读失败、连续部署失败时给类别 */
  health(): { ok: true } | { ok: false; reason: string };
}

export interface SurfaceBinding {
  /** 展示面确认这些作品已经在线（部署的切换确认与内容核对都通过）；可重复报，发布服务只处理还没通知过的 */
  live(ids: readonly string[]): void;
  /** 撤下这个展示面；幂等 */
  detach(): void;
}

// ----- 服务 -----

/** 提供者契约。变更订阅与展示面不直接在这里登记：经 {@link publish} 的绑定门面登记，随激活撤回 */
export interface PublishService {
  /** 同步做静态检查，不合格直接拒；合格即入审核队列 */
  nominate(input: NominateInput): Promise<NominateResult>;
  /** 队列与账本里的条目（待审、已发布、已撤下）；拒绝、超时、失败的只在审计里 */
  get(id: string): { state: ItemState; origin: PublishOrigin; title: string } | undefined;
  /** 这个展示面上已发布的作品 */
  listPublished(surface: string): PublishedItem[];
  /** 按账本 sha256 核对；不符时把这件作品撤下（by: integrity）并抛 {@link IntegrityError} */
  readFile(id: string, path: string): Promise<Uint8Array>;
  /** 缩略图（只对 hasThumbnail 为真的作品）；与 readFile 同样按账本核对 */
  readThumbnail(id: string): Promise<Uint8Array>;
  /** 已发布的撤出公开根；待审的撤回提名。degraded：这件作品所在的展示面有 health 不正常时，给出类别 */
  withdraw(
    id: string,
    by: { kind: 'origin' | 'owner' | 'integrity'; actorKey?: string },
    reason: string,
  ): Promise<{ ok: true; degraded?: string } | { refused: string }>;
  /** 已发布集合变化（发布、撤下）时调 listener；返回退订 */
  onChange(listener: () => void): () => void;
  /** 登记展示面；返回的绑定用来回报上线与撤下 */
  attachSurface(surface: PublishSurface): SurfaceBinding;
}

/** 公开根里的文件与账本不符，提供者已把这件作品撤下。消费方用 {@link isIntegrityError} 认，不用 instanceof */
export class IntegrityError extends Error {
  override name = 'IntegrityError';
}

/**
 * 是否为提供者抛出的 {@link IntegrityError}。只按 `name` 判定：进程里装有两份本包时，提供者抛出的是
 * 它解析到的那份类，消费方换一份做 instanceof 就不成立。
 */
export function isIntegrityError(err: unknown): err is IntegrityError {
  return (err as { name?: unknown } | null | undefined)?.name === 'IntegrityError';
}

// ----- 服务描述符（按激活绑定）-----

/** `publish` 的绑定接口：调用那一半是 ServiceRef，变更订阅与展示面登记自动归属这次激活 */
export interface BoundPublish extends ServiceRef<PublishService> {
  /** 订阅已发布集合的变化：提供者换人自动重挂，随激活撤回 */
  onChange(listener: () => void): () => void;
  /**
   * 登记展示面：同一激活同名再登记替换旧的；提供者换人自动重挂，随激活撤回。
   * 返回的 live 送到当前提供者；提供者不在场、或这条登记已被替换或撤回时不生效（不排队）。
   */
  attachSurface(surface: PublishSurface): SurfaceBinding;
}

export const publish = defineService<PublishService, BoundPublish>('publish', port => {
  // 变更订阅没有「同键替换」：每条订阅一个账目
  let changeSeq = 0;
  const changes = port.registrar<{ seq: number; listener: () => void }>({
    key: item => `change#${item.seq}`,
    register: (service, item) => service.onChange(item.listener),
  });
  // 展示面按名登记。条目记着当前提供者给的绑定：交给调用方的句柄经它转发 live，
  // 换提供者后跟到新的，撤回后清空、不再送到任何提供者
  interface SurfaceEntry {
    surface: PublishSurface;
    binding?: SurfaceBinding;
  }
  const surfaces = port.registrar<SurfaceEntry>({
    key: entry => entry.surface.name,
    register: (service, entry) => {
      const binding = service.attachSurface(entry.surface);
      entry.binding = binding;
      return () => {
        if (entry.binding === binding) entry.binding = undefined;
        binding.detach();
      };
    },
  });
  return serviceRef(port, {
    onChange: (listener: () => void) => changes.add({ seq: ++changeSeq, listener }),
    // 箭头函数：对象字面量方法带隐式 this，会被当成上下文敏感、让 E 改从返回类型推断
    attachSurface: (surface: PublishSurface): SurfaceBinding => {
      const entry: SurfaceEntry = { surface };
      const detach = surfaces.add(entry);
      return { live: ids => entry.binding?.live(ids), detach };
    },
  });
});

// ----- 响应头策略 -----
//
// 数据，不含主机知识：作品站的中间件与 _headers、审核的本机隔离预览都从这里取，不各写一份。
// 拼进头里的来源与目录按语法核对：带分号、空白或换行的值会注入 CSP 指令或（写进 _headers 时）整行头，
// 不合格直接抛错。

/** 作品框的 sandbox 值：包装页 `<iframe sandbox>` 与作品 CSP 的 sandbox 指令同一份。只给脚本 */
export const WORK_IFRAME_SANDBOX = 'allow-scripts';

/** http(s)://主机[:端口]，不带路径 */
const ORIGIN = /^https?:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/;
/** 以斜杠开头与结尾的目录；段只含非保留字符，不是点段 */
const BASE_PATH = /^\/(?:(?!\.{1,2}\/)[A-Za-z0-9._~-]+\/)*$/;

function origin(value: string): string {
  if (!ORIGIN.test(value)) throw new TypeError('来源不是 http(s)://主机[:端口]，拼不进响应头');
  return value;
}

function sourceList(values: readonly string[]): string {
  return values.length === 0 ? "'none'" : values.map(origin).join(' ');
}

/**
 * 作品文件的响应头。scope 是作品自己的目录：`{ origin, basePath }` 写成 `<origin><basePath>`（中间件与预览按请求
 * 主机逐件写），`'self'` 用于没法逐件写的 `_headers` 底层。frameAncestors 是允许框住作品的来源，空时为 'none'。
 * 不加 Cross-Origin-Resource-Policy：沙箱文档是 null 源，会挡住作品自己的子资源。
 */
export function workHeaders(p: {
  scope: { origin: string; basePath: string } | 'self';
  frameAncestors: readonly string[];
}): Record<string, string> {
  let s = "'self'";
  if (p.scope !== 'self') {
    if (!BASE_PATH.test(p.scope.basePath)) throw new TypeError('作品目录不是 /…/ 形式的路径，拼不进响应头');
    s = `${origin(p.scope.origin)}${p.scope.basePath}`;
  }
  const csp = [
    `sandbox ${WORK_IFRAME_SANDBOX}`,
    "default-src 'none'",
    `script-src 'unsafe-inline' blob: data: ${s}`,
    `style-src 'unsafe-inline' data: ${s}`,
    `img-src data: blob: ${s}`,
    `media-src data: blob: ${s}`,
    `font-src data: ${s}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${sourceList(p.frameAncestors)}`,
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    // Sandboxed work documents have an opaque origin; module scripts need CORS even for their own directory.
    'Access-Control-Allow-Origin': '*',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // 同一网址在框里取与顶层打开时响应不同（顶层打开回 302），浏览器缓存不能混用
    Vary: 'Sec-Fetch-Dest',
    'X-DNS-Prefetch-Control': 'off',
  };
}

/**
 * 作品集首页与包装页的响应头：没有脚本，只从自己取样式与媒体，只框 frameOrigins 里的作品来源（空时为 'none'），
 * 自己不许被框。
 */
export function galleryHeaders(p: { frameOrigins: readonly string[] }): Record<string, string> {
  const csp = [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    "media-src 'self'",
    `frame-src ${sourceList(p.frameOrigins)}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}
