// ============================================================
// cache.ts — 图片描述缓存（内容寻址键 + 落盘续命）
//
// 同一张图片在多处被引用（聊天 + analyze_image + 引用消息 + 合并转发）时
// 复用 vision 识别结果。值**只存裸描述**：ref 标记等包装由各消费点按自己的
// 形态重建，存格式化文本会让另一侧拿到嵌套包装（[图片: [图片 | ref:...]]）。
//
// 键：附件落盘是内容寻址的（`{kind}s/{session}/{sha256前16}.{ext}`，见 adapter 的
// attachment-cache 与 service.cacheImageRef），路径里带着会话名，同一张图在不同群会
// 落成两条路径。**无上下文**的描述取其中的内容哈希做键，让表情包这类高频重复内容
// 跨会话只识别一次；**带会话上下文**的描述（contextHistory/senderContext 开启时）
// 用原路径做键，只在本会话内复用——否则等于把 A 群的语境搬进 B 群。
// 非内容寻址来源（http URL / data: base64）一律原样做键，与改前行为一致。
//
// 落盘：一次识别少则十几秒、动图要一分钟，而纯内存缓存进程一重启就全丢。
// 快照写在 `data:/media/descriptions.json`，启动灌回、写入后防抖落盘。
// 未调用 loadDescriptionCache（如单测直接用本模块）时不落盘，退化为纯内存。
// ============================================================

import { createBoundedMap } from '@aalis/util-bounded-map';
import { getMediaRuntime } from './runtime.js';

/** 图片内容不会变，描述也就不会过期；长留才吃得到跨天的表情包复用。 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const MAX_ENTRIES = 5000;
const SNAPSHOT_URI = 'data:/media/descriptions.json';
/** 落盘防抖：识别是低频事件，攒一攒再整体写，避免高峰期反复重写整份快照。 */
const PERSIST_DEBOUNCE_MS = 30_000;

const cache = createBoundedMap<string, string>({ max: MAX_ENTRIES, ttlMs: TTL_MS });

type CacheLogger = { debug: (msg: string) => void; warn: (msg: string) => void };

let persistLogger: CacheLogger | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 本地落盘布局 → 内容哈希键；其余来源（远端 URL、data URI）原样返回。
 *
 * 只认**本地**落盘布局 `data:/{kind}s/{会话目录}/{16 位十六进制}.{ext}` 与其历史相对
 * 形式，故锚定 `data:` / `data/` 起头、且只认小写十六进制（落盘侧 toString('hex')
 * 只产小写）。不做宽泛的「结尾像哈希就当哈希」：图床用 `/images/{段}/{16位hex}.jpg`
 * 布局的远端直链同样会命中那种宽正则，把两张不同的图判成同一张。
 */
export function descriptionKey(source: string): string {
  const m = /^data[:/](?:\/)?(?:images|videos|audios|files)\/[^/]+\/([0-9a-f]{16})\.[a-z0-9]+$/.exec(source);
  return m ? m[1] : source;
}

/**
 * 写入缓存（空串、占位符 `[图片: ...]` 不缓存）。
 *
 * `shareable=false` 时不跨会话共享——描述若掺进了**当前会话的对话上下文**
 * （contextHistory / senderContext 开启时 vision prompt 里带着近期聊天与发送者画像），
 * 那它就是「这张图在这个群此刻的解读」，复用到别的群等于把 A 群的语境搬进 B 群。
 * 这类描述退回按落盘路径（含会话目录）做键，只在本会话内复用。
 */
export function rememberDescription(key: string, raw: string, shareable = true): void {
  if (!raw) return;
  if (raw.startsWith('[图片:') || raw.startsWith('[动图:')) return;
  cache.set(shareable ? descriptionKey(key) : key, raw);
  schedulePersist();
}

/** 查询缓存。命中且未过期返回字符串，否则返回 null（有界 Map 自行处理过期与淘汰）。 */
export function lookupCachedDescription(key: string, shareable = true): string | null {
  return cache.get(shareable ? descriptionKey(key) : key) ?? null;
}

/**
 * 从快照灌回缓存并启用落盘。apply() 时调用一次；读不到快照（首次运行）不是错误。
 * 返回灌回条数。
 */
export async function loadDescriptionCache(logger: CacheLogger): Promise<number> {
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
    if (/ENOENT|不存在|no such file/i.test(msg)) {
      persistLogger = logger;
      logger.debug(`图片描述缓存快照不存在，按首次运行处理: ${msg}`);
    } else {
      logger.warn(`图片描述缓存快照读取失败，本次运行不落盘（避免覆盖磁盘上的旧快照）: ${msg}`);
    }
    return 0;
  }
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
    const { storage } = getMediaRuntime();
    // 只落内容哈希键：非内容寻址的来源（WebUI 上传的整条 base64 data URI 可达数 MB）
    // 写进快照会让这份纯派生缓存产生数量级的写放大，且重启后也无从复用。
    const durable = cache.entries().filter(([k]) => /^[0-9a-f]{16}$/.test(k));
    await storage.writeFile(SNAPSHOT_URI, JSON.stringify(durable));
  } catch (err) {
    logger.warn(`图片描述缓存落盘失败（仅影响重启后的复用）: ${err instanceof Error ? err.message : err}`);
  }
}
