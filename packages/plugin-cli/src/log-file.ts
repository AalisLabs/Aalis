// data/latest.log 是 runtime 约定的"持久化日志单一数据源"（每次启动覆盖）；
// CLI 启动时尾读它来恢复 boot 期早期日志（plugin apply 时 LogHub 已 emit 过若干
// 早期 entry 但 CLI 还未订阅）。与 webui-server 走相同契约，避免插件直连 runtime。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type LogEntry, parseLogLine } from '@aalis/core';

const LOG_FILE_PATH = resolve(process.cwd(), 'data/latest.log');

export async function readLogFileTail(limit: number): Promise<LogEntry[]> {
  if (!existsSync(LOG_FILE_PATH)) return [];
  const raw = await readFile(LOG_FILE_PATH, 'utf8');
  const out: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const entry = parseLogLine(line);
    if (entry) out.push(entry);
  }
  return out.slice(-limit);
}
