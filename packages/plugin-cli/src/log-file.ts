// latest.log 是 runtime 约定的"持久化日志单一数据源"（每次启动覆盖）；
// CLI 启动时尾读它来恢复 boot 期早期日志（plugin apply 时 LogHub 已 emit 过若干
// 早期 entry 但 CLI 还未订阅）。与 webui-server 走相同契约，避免插件直连 runtime。
//
// 路径（宿主目录布局）是「环境知识」，归 storage 的 logs 根所有；本插件只用
// storage URI 寻址、对 cwd/落盘位置无知。写入方（runtime/file-logger）跑在
// storage 起来之前，是 bootstrap 期的合法 raw-fs 例外，不在此处管辖。
import { type LogEntry, parseLogLine } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';

/** 日志单一数据源的 storage URI（logs 根默认落在 data/ 下，与写入方 data/latest.log 对偶）。 */
const LOG_FILE_URI = 'logs:/latest.log';

export async function readLogFileTail(storage: StorageService, limit: number): Promise<LogEntry[]> {
  let raw: string;
  try {
    raw = (await storage.readFile(LOG_FILE_URI, 'utf8')) as string;
  } catch {
    return []; // 文件未就绪 / storage 暂不可用 → 无早期历史
  }
  const out: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const entry = parseLogLine(line);
    if (entry) out.push(entry);
  }
  return out.slice(-limit);
}
