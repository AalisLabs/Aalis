// ============================================================
// cache.ts — 图片描述缓存（内容寻址键 + 落盘续命）
//
// 同一张图片在多处被引用（聊天 + analyze_image + 引用消息 + 合并转发）时
// 复用 vision 识别结果。值**只存裸描述**：ref 标记等包装由各消费点按自己的
// 形态重建，存格式化文本会让另一侧拿到嵌套包装（[图片: [图片 | ref:...]]）。
//
// 键：附件落盘的存储地址带着会话目录（`data:/{kind}s/{会话目录}/{写入方}/{文件}`，见 @aalis/api-media 的
// 会话媒体目录约定），同一张图在不同群会落成两个地址。按内容寻址的写入方把文件名写成内容哈希（api-media 的命名
// 约定），**无上下文**的描述取文件名里的内容哈希做键，让表情包这类高频重复内容跨会话只识别一次；**带会话上下文**
// 的描述（contextHistory 开启、识别时带上了会话语境）与文件名不是内容哈希的（如绘图产物）用存储地址做键，只在
// 本会话内复用——否则等于把 A 群的语境搬进 B 群。
// 网址与 data URI 一律原样做键；但这类来源**落盘后**就有存储地址了，落盘点登记一次「来源 → 落盘地址」别名
// （见 rememberDescriptionAlias），此后按原始来源串查也落到落盘地址的键上。
//
// 落盘：一次识别少则十几秒、动图要一分钟，而纯内存缓存进程一重启就全丢。
// 快照写在 `data:/media/descriptions.json`，启动灌回、写入后防抖落盘。
// 未调用 loadDescriptionCache（如单测直接用本模块）时不落盘，退化为纯内存。
// /clear 与删除会话经 clearDescriptionCache 清理内存条目与快照（memory:clear 中间件在 index.ts）。
// ============================================================

import { MEDIA_KIND_DIRS, sessionDirName } from '@aalis/api-media';
import { isStorageNotFound, isStorageUri } from '@aalis/api-storage';
import { TextError } from '@aalis/schema-i18n';
import { createBoundedMap } from '@aalis/util-bounded-map';
import { getMediaRuntime } from './runtime.js';
import { t } from './texts.js';

/** 图片内容不会变，描述也就不会过期；长留才吃得到跨天的表情包复用。 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const MAX_ENTRIES = 5000;
const SNAPSHOT_URI = 'data:/media/descriptions.json';
/** 落盘防抖：识别是低频事件，攒一攒再整体写，避免高峰期反复重写整份快照。 */
const PERSIST_DEBOUNCE_MS = 30_000;

const cache = createBoundedMap<string, string>({ max: MAX_ENTRIES, ttlMs: TTL_MS });

/**
 * 「来源 → 落盘 ref」别名表。网址与 data URI（WebUI 上传的 base64）本身不是存储地址，
 * 落盘后才有存储地址可用。
 *
 * 键空间不变：别名只把来源映到落盘的存储地址，键照它的规则取（内容哈希或存储地址），
 * 不引入新键形态。纯派生、不进快照——快照里只有落盘的键，重启后由新一轮落盘重登记。
 */
const aliases = createBoundedMap<string, string>({ max: MAX_ENTRIES, ttlMs: TTL_MS });

type CacheLogger = { debug: (msg: string) => void; warn: (msg: string) => void };

let persistLogger: CacheLogger | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * /clear all 已删掉快照文件。只在禁写运行（persistLogger 为 null）里查：这时本进程不会再写快照，
 * 磁盘上已没有重启时会灌回的旧描述，会话级清理清完内存即可。
 */
let snapshotDeleted = false;
/**
 * 快照读写与清理串行：清理要等在途的灌回与落盘完成后再动内存与磁盘，
 * 否则清理之前的内容会在清理之后被灌回内存或写回快照。
 */
let snapshotIO: Promise<void> = Promise.resolve();

/** 按内容寻址的文件名（api-media 的命名约定）：分组 1 为内容哈希 */
const CONTENT_NAME = /\/([0-9a-f]{16})\.[a-z0-9]+$/;

/**
 * 描述在 `/clear` 里归属的类型：describeVideo 的视频描述归 video，其余（静态图、动图）归 image。
 * 视频描述的键带 {@link VIDEO_VARIANT} 后缀，与图片描述不共键，才分得开。
 */
export const DESCRIPTION_KINDS = ['image', 'video'] as const;
type DescriptionKind = (typeof DESCRIPTION_KINDS)[number];

/** 视频描述的键后缀，与详略档共用后缀位（见 cacheKey）。 */
export const VIDEO_VARIANT = 'video';

/**
 * 文件名按内容寻址的存储地址 → 内容哈希键；其余来源（网址、data URI、文件名不是内容哈希的存储地址）原样返回。
 *
 * 只认存储地址、且只认小写十六进制（落盘侧 toString('hex') 只产小写），不认网址：图床用
 * `/images/{段}/{16位hex}.jpg` 布局的远端直链同样有这种文件名，按它认会把两张不同的图判成同一张。
 */
export function descriptionKey(source: string): string {
  return (isStorageUri(source) && CONTENT_NAME.exec(source)?.[1]) || source;
}

/**
 * processVideo 取不到视频或抽不出关键帧时写进描述位的说明（给模型看）。它作为失败结果交出，调用方不写进缓存：写进 30 天
 * 缓存的话，同一个视频或动图此后每次命中都直接回这句、永不重试。
 */
export const VIDEO_FAILURE_TEXTS = {
  unreadable: '[视频] 无法下载或读取视频文件内容（URL 不可访问或解码失败）',
  noUrl: '[视频] 来源没有给出视频文件地址，无法获取内容',
  noFrames: '[视频] 已收到视频文件但未能抽取关键帧或音轨（可能缺少 ffmpeg/ffprobe，或视频解码失败）',
} as const;

/**
 * 登记「来源 → 落盘 ref」别名。**落盘时调一次**（本插件 cacheImageRef 落盘成功处；
 * 适配器落远端 URL 时经 MediaService.rememberDescriptionAlias 调进来），
 * 此后按原始来源串读写描述都经别名落到落盘 ref 的键上：同一张图经不同来源
 * （WebUI base64 / 适配器已落盘的存储地址）进来只识别一次，且描述能进快照续命
 * （快照只收落盘的键，原始 base64 串做键的条目重启即丢）。
 *
 * 来源与 ref 相同（http URL 与存储地址原样返回）时不登记——恒等别名无意义。
 *
 * 登记**之前**已按原始来源串写入的条目不迁移：那要求登记时反查旧键搬运，而能走到这一步
 * 的只有「先识别、后落盘」的窄场景，代价是多识别一次，判跳。
 */
export function rememberDescriptionAlias(source: string, landedRef: string): void {
  if (!source || !landedRef || source === landedRef) return;
  aliases.set(source, landedRef);
}

/** 来源串登记过落盘 ref 就换成后者，否则原样。读写共用，两侧必须一致。 */
function resolveAlias(source: string): string {
  return aliases.get(source) ?? source;
}

/**
 * 写入缓存（空串不缓存）。只交识别出的描述：识别失败的说明由调用方挡在外面（见 {@link VIDEO_FAILURE_TEXTS}）。
 *
 * `shareable=false` 时不跨会话共享——描述若掺进了**当前会话的对话上下文**
 * （contextHistory 开启时 vision prompt 里带着近期聊天，senderContext 也开时还有发送者画像），
 * 那它就是「这张图在这个群此刻的解读」，复用到别的群等于把 A 群的语境搬进 B 群。
 * 这类描述退回按存储地址（含会话目录）做键，只在本会话内复用。
 */
export function rememberDescription(key: string, raw: string, shareable = true, variant?: string): void {
  if (!raw) return;
  cache.set(cacheKey(key, shareable, variant), raw);
  schedulePersist();
}

/** 查询缓存。命中且未过期返回字符串，否则返回 null（有界 Map 自行处理过期与淘汰）。 */
export function lookupCachedDescription(key: string, shareable = true, variant?: string): string | null {
  return cache.get(cacheKey(key, shareable, variant)) ?? null;
}

/**
 * 最终缓存键：别名解析 → 内容哈希（shareable）→ 可选的变体后缀。
 * variant 是 describeImage 的非默认详略档（casual/detailed/professional）：同一张图按档位各存一条，
 * 默认档（auto）与到达识别共用无后缀的那条。后缀加在哈希之后，别名与跨会话共享对各档同样生效。
 * describeVideo 的视频描述带 {@link VIDEO_VARIANT} 后缀。
 */
function cacheKey(key: string, shareable: boolean, variant?: string): string {
  const src = resolveAlias(key);
  const base = shareable ? descriptionKey(src) : src;
  return variant ? `${base}#${variant}` : base;
}

/**
 * 从快照灌回缓存并启用落盘。apply() 时调用一次；读不到快照（首次运行）不是错误。
 * 返回灌回条数。
 */
export function loadDescriptionCache(logger: CacheLogger): Promise<number> {
  return queueSnapshotIO(async () => {
    try {
      const { storage } = getMediaRuntime();
      const text = await storage.readFile(SNAPSHOT_URI, 'utf8');
      const parsed: unknown = JSON.parse(typeof text === 'string' ? text : text.toString('utf8'));
      if (!Array.isArray(parsed)) return 0;
      let n = 0;
      for (const pair of parsed) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
        cache.set(pair[0], pair[1]);
        n++;
      }
      persistLogger = logger; // 读成功才开落盘：读失败还写盘，会用一份空缓存整体覆盖掉磁盘上的好快照
      return n;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 首次运行读不到文件是正常的；其余错因（存储根未就绪、权限、JSON 损坏）要能被看见，
      // 否则表现只是「重启后缓存莫名从头开始」。两种情况都不开落盘，宁可不复用也不覆盖。
      if (isStorageNotFound(err)) {
        persistLogger = logger;
        logger.debug(`图片描述缓存快照不存在，按首次运行处理: ${msg}`);
      } else {
        logger.warn(`图片描述缓存快照读取失败，本次运行不落盘（避免覆盖磁盘上的旧快照）: ${msg}`);
      }
      return 0;
    }
  });
}

/** 立即落盘并解除防抖定时器。dispose 时调用，避免最后一段识别结果白丢。 */
export async function flushDescriptionCache(): Promise<void> {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  if (!persistLogger) return;
  await persist();
}

/**
 * 清理描述缓存里属于 kinds 的条目，按类型回删掉的条目数。/clear 与删除会话（memory:clear）用。
 * 条目按键归类（视频描述带 {@link VIDEO_VARIANT} 后缀），别名按落盘地址所在的种类目录归类（视频目录下的归 video）。
 *
 * 不传会话即全局清理：删掉所选类型的全部条目与别名。两类都清时删掉快照文件；只清一类时重写快照，
 * 另一类留在快照里。本次运行因读快照失败而禁写时，全局清理一律删掉快照文件：读不出就无从只删一类，
 * 那份旧快照里也有要清的描述；另一类随之从磁盘上消失，代价只是重启后重新识别。
 *
 * 传会话只删键与别名落在这个会话的媒体目录下（`data:/<种类目录>/<会话目录>/`，不论哪家写的）的：带该会话语境的
 * 描述与文件名不是内容哈希的描述以存储地址为键；内容哈希键跨会话共享，无从按会话归属，保留。别名不进快照，删掉了
 * 条目时重写快照。禁写时磁盘上的旧快照无从改写，内存侧清完后抛错说明；本次运行里全局清理已删掉快照文件时不抛，
 * 那时磁盘上已没有会在重启时恢复的描述。
 */
export function clearDescriptionCache(
  sessionId: string | undefined,
  kinds: readonly DescriptionKind[],
): Promise<Record<DescriptionKind, number>> {
  return queueSnapshotIO(async () => {
    const prefixes =
      sessionId === undefined
        ? undefined
        : Object.values(MEDIA_KIND_DIRS).map(dir => `${dir}/${sessionDirName(sessionId)}/`);
    const inScope = (landed: string) => !prefixes || prefixes.some(prefix => landed.startsWith(prefix));
    const removed: Record<DescriptionKind, number> = { image: 0, video: 0 };
    for (const [key] of cache.entries()) {
      const kind = kindOfKey(key);
      if (kinds.includes(kind) && inScope(key)) {
        cache.delete(key);
        removed[kind]++;
      }
    }
    for (const [source, ref] of aliases.entries()) {
      if (kinds.includes(kindOfRef(ref)) && inScope(ref)) aliases.delete(source);
    }
    if (sessionId === undefined && (!persistLogger || DESCRIPTION_KINDS.every(k => kinds.includes(k)))) {
      try {
        await getMediaRuntime().storage.delete(SNAPSHOT_URI);
      } catch (err) {
        if (!isStorageNotFound(err)) throw err;
      }
      snapshotDeleted = true;
      return removed;
    }
    const total = removed.image + removed.video;
    if (!persistLogger) {
      if (snapshotDeleted) return removed;
      throw new TextError(t('snapshotUnreadable', { count: total }));
    }
    if (total > 0) await writeSnapshot();
    return removed;
  });
}

function kindOfKey(key: string): DescriptionKind {
  return key.endsWith(`#${VIDEO_VARIANT}`) ? 'video' : 'image';
}

function kindOfRef(ref: string): DescriptionKind {
  return ref.startsWith(`${MEDIA_KIND_DIRS.video}/`) ? 'video' : 'image';
}

/** 可进快照的键：落盘的两种键，内容哈希键与存储地址键（都可带详略档或视频后缀）。 */
function isDurableKey(key: string): boolean {
  const base = key.replace(/#[a-z]+$/, '');
  return /^[0-9a-f]{16}$/.test(base) || isStorageUri(base);
}

function queueSnapshotIO<T>(op: () => Promise<T>): Promise<T> {
  const run = snapshotIO.then(op);
  snapshotIO = run.then(
    () => {},
    () => {},
  );
  return run;
}

function schedulePersist(): void {
  if (!persistLogger || persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persist();
  }, PERSIST_DEBOUNCE_MS);
  // 防抖定时器不该拖住进程退出：宿主在 Node 下 unref，其它环境无此方法即跳过。
  (persistTimer as unknown as { unref?: () => void }).unref?.();
}

async function persist(): Promise<void> {
  const logger = persistLogger;
  if (!logger) return;
  try {
    await queueSnapshotIO(writeSnapshot);
  } catch (err) {
    logger.warn(`图片描述缓存落盘失败（仅影响重启后的复用）: ${err instanceof Error ? err.message : err}`);
  }
}

async function writeSnapshot(): Promise<void> {
  // 只落落盘的键：内容哈希键，以及带会话上下文的描述、文件名不是内容哈希的描述所用的存储地址键
  // （体积可控，重启后同会话重发的图照样命中）。
  // 网址与 data URI 做键的条目（WebUI 上传的整条 base64 data URI 可达数 MB）写进快照
  // 会让这份纯派生缓存产生数量级的写放大，且重启后也无从复用。
  const durable = cache.entries().filter(([k]) => isDurableKey(k));
  await getMediaRuntime().storage.writeFile(SNAPSHOT_URI, JSON.stringify(durable));
}
