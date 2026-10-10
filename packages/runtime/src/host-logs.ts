import { open } from 'node:fs/promises';
import type { HostLogs } from '@aalis/api-host-logs';
import type { LogEntry, Logger, LogHub } from '@aalis/core';
import { parseLogLine } from '@aalis/schema-log';
import type { FileLoggerHandle } from './file-logger.js';

/** 从文件末尾往前最多扫这么多字节：筛得很窄、往前翻得很深时也有界，更早的去看 logs/latest.log 本体 */
const SCAN_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/**
 * 文件末尾往前分块读，返回最后 limit 条符合 accept 的日志（文件内的先后）。latest.log 可能几百 MB，不整个载入。
 * 按字节切行：UTF-8 的多字节序列里没有 0x0A，块边界劈不开字符。文件不在时没有历史
 */
async function readTail(path: string, limit: number, accept: (entry: LogEntry) => boolean): Promise<LogEntry[]> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const { size } = await file.stat();
    const batches: LogEntry[][] = [];
    let count = 0;
    let pos = size;
    // 已读、开头可能是半行的字节：留着与前一块拼起来
    let carry = Buffer.alloc(0);
    while (pos > 0 && count < limit && size - pos < SCAN_BYTES) {
      const start = Math.max(0, pos - CHUNK_BYTES);
      const chunk = Buffer.alloc(pos - start);
      await file.read(chunk, 0, chunk.length, start);
      pos = start;
      const bytes = Buffer.concat([chunk, carry]);
      const cut = pos > 0 ? bytes.indexOf(0x0a) + 1 : 0;
      if (pos > 0 && cut === 0) {
        carry = bytes;
        continue;
      }
      carry = bytes.subarray(0, cut);
      const batch = bytes
        .subarray(cut)
        .toString('utf8')
        .split('\n')
        .map(parseLogLine)
        .filter((entry): entry is LogEntry => entry !== null && accept(entry));
      batches.push(batch);
      count += batch.length;
    }
    return batches.reverse().flat().slice(-limit);
  } finally {
    await file.close();
  }
}

/**
 * host-logs 服务的实现：历史读文件日志（先等它把已记下的写完），实时接中枢。`file` 不给时没有历史。
 * 订阅带历史时先攒着实时的，历史送完再接着送比它新的，之后直通；补发途中 listener 抛错只丢掉那一条，与中枢同一规则
 */
export function createHostLogs(
  hub: LogHub,
  file: Pick<FileLoggerHandle, 'path' | 'flush'> | undefined,
  logger: Logger,
): HostLogs {
  const recent: HostLogs['recent'] = async (limit, options = {}) => {
    if (!file || limit <= 0) return [];
    await file.flush();
    const { before, match } = options;
    return readTail(
      file.path,
      limit,
      entry => (before === undefined || entry.seq < before) && (match?.(entry) ?? true),
    );
  };
  return {
    recent,
    subscribe(listener, options = {}) {
      const history = options.history ?? 0;
      if (history <= 0) return hub.onEntry(listener);
      let last = Number.NEGATIVE_INFINITY;
      let queued: LogEntry[] | undefined = [];
      let closed = false;
      const deliver = (entry: LogEntry) => {
        if (closed || entry.seq <= last) return;
        last = entry.seq;
        // 订阅者就是日志的去处，它的错误（含返回被拒的 Promise）无处可报
        try {
          Promise.resolve(listener(entry) as unknown).catch(() => {});
        } catch {}
      };
      const off = hub.onEntry(entry => (queued ? queued.push(entry) : deliver(entry)));
      void recent(history)
        .catch(err => {
          logger.warn('日志订阅没能补发历史，只送此后的:', err);
          return [];
        })
        .then(tail => {
          const pending = queued ?? [];
          queued = undefined;
          for (const entry of [...tail, ...pending]) deliver(entry);
        });
      return () => {
        closed = true;
        off();
      };
    },
  };
}
