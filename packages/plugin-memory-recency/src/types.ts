import type { RecentEntry } from './buffer.js';

/** 作用域：off=禁用；same-platform=只看当前 platform 的所有 session；cross-platform=全部 platform 的所有 session */
export type RecencyScope = 'off' | 'same-platform' | 'cross-platform';

export interface RecencyConfig {
  /** 默认作用域（per-session 可通过未来扩展点覆盖；本期暂不支持） */
  scope: RecencyScope;
  /** 注入 / tool 默认返回的最大条数 */
  limit: number;
  /** 仅返回最近 N 分钟内的消息；0 = 不限时间 */
  maxAgeMinutes: number;
  /** 启动预热：每个已知 sessionId 拉多少条 */
  preheatPerSession: number;
  /** ring buffer 全局容量上限 */
  bufferCapacity: number;
  /** 白名单：空数组 = 不限制；否则只允许列表中的 platform / sessionId */
  whitelist: { platforms: string[]; sessions: string[] };
  /** 黑名单：永远排除这些 sessionId（优先级高于白名单） */
  blacklist: { sessions: string[] };
  /** 注入 system-block 时的开头说明文本（可包含安全/隐私提示） */
  headerText: string;
  /** 是否注册 recent_messages 工具供 agent 主动查询 */
  toolEnabled: boolean;
  /** 工具名（默认 recent_messages） */
  toolName: string;
  /** 注入到 messages[] 的 system 消息标记，用于排重 */
  injectMetadataSource: string;
}

export interface QueryOptions {
  scope?: RecencyScope;
  currentPlatform?: string;
  currentSessionId?: string;
  limit?: number;
  maxAgeMinutes?: number;
}

export interface RecencyService {
  /** 查询近期消息（按时间升序返回） */
  query(opts: QueryOptions): RecentEntry[];
  /** 当前 buffer 大小（调试用） */
  size(): number;
  /** 清空（仅供测试 / 命令） */
  clear(): void;
}
