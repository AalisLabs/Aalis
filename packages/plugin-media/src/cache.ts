// ============================================================
// cache.ts — 图片描述缓存（内容寻址键 + 落盘续命）
//
// 同一张图片在多处被引用（聊天 + analyze_image + 引用消息 + 合并转发）时
// 复用 vision 识别结果。值**只存裸描述**：ref 标记等包装由各消费点按自己的
// 形态重建，存格式化文本会让另一侧拿到嵌套包装（[图片: [图片 | ref:...]]）。
//
// 键：附件落盘是内容寻址的（`{kind}s/{session}/{sha256前16}.{ext}`，见
// adapter 的 attachment-cache 与 service.cacheImageRef），路径里带着会话名，
// 同一张图在不同群会落成两条路径。这里取出其中的**内容哈希**做键，让表情包
// 这类高频重复内容跨会话只识别一次。非内容寻址来源（http URL / data: base64）
// 原样做键，与改前行为一致。
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
 * 内容寻址路径 → 内容哈希键；其余来源原样返回。
 *
 * 只认落盘布局 `{images|videos|audios|files}/{会话目录}/{16 位十六进制}.{ext}`，
 * 不做宽泛的「结尾像哈希就当哈希」——远端 URL 的文件名也可能是十六进制，
 * 认错了会把两张不同的图判成同一张。
 */
export function descriptionKey(source: string): string {
  const m = /(?:^|\/)(?:images|videos|audios|files)\/[^/]+\/([0-9a-f]{16})\.[a-z0-9]+$/i.exec(source);
  return m ? m[1].toLowerCase() : source;
}

/** 写入缓存（空串、占位符 `[图片: ...]` 不缓存）。 */
export function rememberDescription(key: string, raw: string): void {
  if (!raw) return;
  if (raw.startsWith('[图片:') || raw.startsWith('[动图:')) return;
  cache.set(descriptionKey(key), raw);
  schedulePersist();
}

/** 查询缓存。命中且未过期返回字符串，否则返回 null（有界 Map 自行处理过期与淘汰）。 */
export function lookupCachedDescription(key: string): string | null {
  return cache.get(descriptionKey(key)) ?? null;
}

/**
 * 从快照灌回缓存并启用落盘。apply() 时调用一次；读不到快照（首次运行）不是错误。
 * 返回灌回条数。
 */
export async function loadDescriptionCache(logger: CacheLogger): Promise<number> {
  persistLogger = logger;
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
    return n;
  } catch (err) {
    logger.debug(`图片描述缓存快照未加载（首次运行或读取失败）: ${err instanceof Error ? err.message : err}`);
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
    await storage.writeFile(SNAPSHOT_URI, JSON.stringify(cache.entries()));
  } catch (err) {
    logger.warn(`图片描述缓存落盘失败（仅影响重启后的复用）: ${err instanceof Error ? err.message : err}`);
  }
}
