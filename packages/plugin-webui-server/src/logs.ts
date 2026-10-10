// ============================================================
// logs.ts — 日志的筛选
//
// 历史与实时都由宿主的 host-logs 服务给（@aalis/api-host-logs）。筛选（api-webui 的 LogFilter）在这里一处定，
// 历史（/api/logs/*）与 /admin 的实时推送用同一个判定。
// ============================================================

import type { LogFilter } from '@aalis/api-webui';
import type { LogEntry, LogLevel } from '@aalis/core';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 读出筛选：三项都只收字符串，级别要是四种之一，空字符串当没给；写法不对回 undefined */
export function parseLogFilter(value: unknown): LogFilter | undefined {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null) return undefined;
  const { level, plugin, text } = value as Record<string, unknown>;
  const fields = { level, plugin, text };
  if (Object.values(fields).some(field => field !== undefined && typeof field !== 'string')) return undefined;
  if (level && !LEVELS.includes(level as LogLevel)) return undefined;
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => field)) as LogFilter;
}

/**
 * 一条日志所属的插件实例：作用域是根作用域、实例 id、插件自己分出的子作用域依次用「:」接起来（core 给每个激活的 logger
 * 是根 logger 的 child）。后缀实例（name:suffix）与主实例的子作用域同形，取 known 认得的最长的那个
 */
function ownerOf(scope: string, known: (instance: string) => boolean): string | undefined {
  const segments = scope.split(':').slice(1);
  for (let n = segments.length; n > 0; n--) {
    const instance = segments.slice(0, n).join(':');
    if (known(instance)) return instance;
  }
  return undefined;
}

/**
 * 按筛选判定日志的函数。registered 是此刻登记着的插件实例：按插件筛时用它分开后缀实例与子作用域；筛的那个实例本身
 * 总认得，卸掉了的插件照样能按名字筛它留下的日志
 */
export function logMatcher(registered: (instance: string) => boolean) {
  return (filter: LogFilter) => {
    const floor = filter.level === undefined ? 0 : LEVELS.indexOf(filter.level);
    const text = filter.text?.toLowerCase();
    const { plugin } = filter;
    const known = (instance: string) => instance === plugin || registered(instance);
    return (entry: LogEntry): boolean =>
      LEVELS.indexOf(entry.level) >= floor &&
      (text === undefined || entry.message.toLowerCase().includes(text)) &&
      (plugin === undefined || ownerOf(entry.scope, known) === plugin);
  };
}
