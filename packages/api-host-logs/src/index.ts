/**
 * @aalis/api-host-logs — 宿主日志契约
 *
 * 写日志是 core 发给每个插件的 logger；读整个日志流是宿主的管理能力（日志里有用户消息、路径与报错细节），插件在 uses
 * 里声明本描述符才拿得到。Node 宿主 @aalis/runtime 把它独占登记在根上：历史读家目录的 logs/latest.log（本轮启动以来的
 * 全部日志，启动期的也在里面），实时的接 App 的日志通道。别的宿主要给插件读日志，自己提供本描述符。
 */

import { defineService, type LogEntry } from '@aalis/core';

export interface RecentLogsOptions {
  /** 只看 seq 比它小的：往前翻页 */
  before?: number;
  /** 只收符合的 */
  match?(entry: LogEntry): boolean;
}

export interface SubscribeLogsOptions {
  /** 先补发最近的这么多条，缺省 0 */
  history?: number;
}

export interface HostLogs {
  /**
   * 本轮启动以来最后 limit 条（按 seq 升序）。宿主往前只扫有限的一段（Node 宿主是文件末尾 16 MiB），筛得很窄、翻得很深时
   * 可能不满 limit 条；宿主不写文件日志时没有历史，回空数组
   */
  recent(limit: number, options?: RecentLogsOptions): Promise<LogEntry[]>;
  /**
   * 先补发最近的 history 条，再送此后的每一条：按 seq 递增，不重不漏。返回退订。listener 抛错只丢掉这一次，不影响订阅
   */
  subscribe(listener: (entry: LogEntry) => void, options?: SubscribeLogsOptions): () => void;
}

/** 业务层：调用转发给提供者，subscribe 的订阅归本次激活，关闭时撤回 */
export const hostLogs = defineService<HostLogs, HostLogs>('host-logs', port => {
  let seq = 0;
  const subscriptions = port.registrar<{
    seq: number;
    listener: (entry: LogEntry) => void;
    options?: SubscribeLogsOptions;
  }>({
    key: item => `subscribe#${item.seq}`,
    register: (provider, item) => provider.subscribe(item.listener, item.options),
  });
  return Object.assign(Object.create(port.provider) as HostLogs, {
    subscribe: (listener: (entry: LogEntry) => void, options?: SubscribeLogsOptions) =>
      subscriptions.add({ seq: ++seq, listener, options }),
  });
});
