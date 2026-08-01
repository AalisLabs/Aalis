// ----- 记忆服务接口 -----
import type {} from '@aalis/core';
import type { Message } from '@aalis/schema-message';

/** 跨会话最近消息查询参数 */
export interface RecentMessagesAcrossSessionsQuery {
  /** 最大返回条数（按 timestamp DESC 取最近 N 条；最终返回时升序） */
  limit: number;
  /** 仅返回 timestamp >= sinceTs 的消息（毫秒）；省略则不限 */
  sinceTs?: number;
  /** 按 `metadata.platform` 过滤；省略则不限平台 */
  platform?: string;
  /** 排除这些 sessionId（通常排除当前会话避免与会话内 history 重复） */
  excludeSessionIds?: string[];
  /** 角色过滤；省略时默认为 ['user', 'assistant']（system / tool 不会出现在跨会话注入里） */
  roles?: Array<Message['role']>;
  /**
   * Kind 白名单：仅返回 `message.kind ∈ kinds` 的条目；省略=不限。
   * 与 `roles` 配合用作"role + kind"双维度细筛（例如 `roles:['notice'], kinds:['cross-session-delegation']`）。
   */
  kinds?: string[];
  /**
   * Kind 黑名单：排除 `message.kind ∈ excludeKinds` 的条目（即使在 `kinds` 白名单内也排除）。
   * 典型用法：`excludeKinds: ['event-marker', 'cross-session-delegation']` 屏蔽控制类与委派类。
   */
  excludeKinds?: string[];
}

/** 跨会话查询结果条目 */
export interface RecentMessageRecord {
  sessionId: string;
  message: Message;
}

/** `listMetadata` 的一条结果。 */
export interface MetadataEntry {
  key: string;
  data: Record<string, unknown>;
  /**
   * 最后写入时间（毫秒时间戳）。
   *
   * 三家后端本来就存着这一列（sqlite 的 `metadata.updatedAt`、mongodb 的 `updatedAt: Date`），
   * 只是从不返回 —— 于是应用层**拿不到任何时间信息**，「按时间清理」这件事在契约上不可能做到。
   * 实测后果：`plugin-adapter-onebot` 每收一条合并转发就持久化完整原文，内存缓存那侧有 1 小时
   * TTL，持久化那侧一条清理路径都没有，磁盘只增不减。
   */
  updatedAt: number;
}

/** `commitMetadata` 的一条操作。`put` 覆盖写，`del` 删除（不存在则忽略）。 */
export type MetadataOp =
  | { op: 'put'; namespace: string; key: string; data: Record<string, unknown> }
  | { op: 'del'; namespace: string; key: string };

export interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
  /** 清空所有会话的所有消息和归档 */
  clearAll?(): Promise<void>;
  /** 归档旧消息，仅保留最近 keepRecent 条为活跃状态，返回被归档的条数 */
  trimHistory?(sessionId: string, keepRecent: number): Promise<number>;
  /** 获取完整历史（含已归档消息），用于 UI 展示 */
  getFullHistory?(sessionId: string, limit?: number): Promise<Message[]>;

  // ----- 范围查询（供向量检索的上下文窗口扩展使用） -----

  /**
   * 范围查询：取指定会话内 [fromTs, toTs] 区间的消息（按时间升序）。
   * - `roles`：role 白名单，省略=不限。
   * - `excludeKinds`：kind 黑名单（典型："event-marker" 等控制类标记），省略=不排除。
   */
  getMessagesBySessionRange?(
    sessionId: string,
    fromTs: number,
    toTs: number,
    roles?: Array<Message['role']>,
    excludeKinds?: string[],
  ): Promise<Message[]>;

  /**
   * 跨会话取最近 N 条消息（按 timestamp 升序返回），供"跨会话历史注入"等场景使用。
   *
   * 实现需保证：
   * - 仅返回未归档（archived=false）消息
   * - 按 `timestamp DESC` 取最近 `limit` 条后再升序输出
   * - 按 `query.platform` / `query.excludeSessionIds` / `query.roles` / `query.sinceTs` 过滤
   * - 返回结果中每条带 `sessionId`，调用方可据此区分来源
   */
  getRecentMessagesAcrossSessions?(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]>;

  // ═══════════════════════════════════════════════════════════════════════
  // 结构化元数据存储
  //
  // 四个方法**必填**。曾经全部可选（`?`），而三家后端从来都是全实现——可选性只产生成本：
  // 八个消费方各写各的守卫，写法四种（静默 return / 直接 throw / 自定义错误类型 / 有就存没有
  // 就丢），且都是死分支。第三方 memory 后端本来也必须实现，否则一半插件在它上面跑不起来。
  //
  // ── 这一面**刻意停在 KV**，以下四条是经实测的决定，不是尚未做的待办 ──
  //
  // 1. **不加查询原语（where / orderBy / join / 聚合）。**
  //    实测八个消费方里七个只需要 KV；唯一被撑爆的是 `user-relation` 的关系图，而它已用
  //    进程内快照缓存解决。查询一旦进契约，第三方后端的门槛就从「实现几个 KV 方法」变成
  //    「实现一个查询引擎」——那会废掉 memory 多实现（inmemory/sqlite/mongodb）这件事本身。
  //
  // 2. **不加 key 前缀扫描。** 曾以为它是主要需求，实测推翻：11 个 `listMetadata` 调用点里
  //    只有一个低频清理路径要子集，其余都要全量（`loadAll` 本来就要全部四类，加了前缀反而
  //    要发四次查询）。
  //
  // 3. **不加载荷字段索引。** 技术上可行且快——sqlite 的 `json_extract` 表达式索引实测把
  //    2 万行的点查从 15ms 降到 0.019ms（818×），mongodb 更简单（`data` 是真子文档）。
  //    但那只有一个消费方需要，且是低频路径。真出现第二个需要按字段查的插件再说。
  //
  // 4. **namespace 不做 `ctx.id` stamping。** 现状是无主的全局字符串空间，与 events /
  //    services / hooks 三原语「注册经闭包 ctx.id 的门面」的纪律确实背离。但它拦不住恶意
  //    ——插件与内核同进程同权限，绕过门面直接 `getService('memory')` 就能读任意 namespace
  //    ——只拦得住手滑。而唯一的实例（`plugin-media` 读 `plugin-user-profile` 的档案）是
  //    **有意的跨插件读**，正解是 DI（user-profile 导出服务）而非 stamping，且该并入
  //    「避免污染共享契约」那次统一处置，不单修一处留下不一致。
  //    代价则是一次带迁移的破坏性变更（既有数据的 namespace 全变，而存量数据没有任何标记
  //    能告诉我们哪个 namespace 归谁）。
  //
  // 若将来真要上结构化存储：**不自建 ORM**。`minato`（MIT、仅依赖 cosmokit、四个 driver
  // 覆盖 sqlite/mongo/mysql/postgres）是现成的，且它不依赖 koishi；drizzle / kysely 都不支持
  // mongo，与本项目已有的 mongodb 后端对不上。届时它应作为**实现细节**藏在某个存储插件里，
  // 而不是把 minato 的 API 抬成 Aalis 的公开契约。
  // ═══════════════════════════════════════════════════════════════════════

  /** 保存结构化元数据（namespace 隔离，key 唯一） */
  saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void>;
  /** 读取元数据 */
  getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined>;
  /** 列出指定 namespace 下所有元数据条目 */
  listMetadata(namespace: string): Promise<MetadataEntry[]>;
  /** 删除元数据条目 */
  deleteMetadata(namespace: string, key: string): Promise<void>;
  /**
   * 批量提交一组元数据变更。
   *
   * **要的是「一次调用交付整批」，不是速度**（实测 500 条批量写只快 1.1×）。没有它的时候，
   * `plugin-session-manager` 的刷盘是「逐条 saveMetadata + 全表扫删孤儿」，任何一条抛错
   * 就停在半新半旧，而它已经把 dirty 置 false、下一次 debounce 不会重试。
   *
   * ⚠️ **原子性按后端分档，不是统一承诺** —— 不要按「要么全成要么全不成」来依赖它：
   * - **sqlite**：真事务，全成或全不成，并发读不撕裂。
   * - **inmemory**：先整批序列化再同步落，等价于事务。
   * - **mongodb**：`bulkWrite({ordered:true})`，**不是事务**（多文档事务要求副本集，而本项目
   *   对单机部署也要能用）。语义是「按序执行、遇错即停」：失败点之前的写已生效、之后的未执行，
   *   不会乱序，但会停在半新半旧；大批量还会被驱动分批，并发读能采到中间态。
   *
   * 因此调用方要么容忍半新半旧、要么自己具备重试能力（如 session-manager 每次写全量快照，
   * 失败后 dirty 复位、下次自愈）。
   *
   * `data` 必须是 **JSON 可序列化**的值。三家后端都会因此抛错（sqlite/inmemory 在
   * `JSON.stringify`、mongodb 在 BSON 序列化），且都是整批不生效。
   */
  commitMetadata(ops: readonly MetadataOp[]): Promise<void>;

  /** 在指定会话的最近 N 条消息中，将 content 里的 oldText 替换为 newText，返回受影响的条数 */
  updateMessageContent?(sessionId: string, oldText: string, newText: string, recentLimit?: number): Promise<number>;

  /** 按时间戳批量删除指定会话的消息（用于回滚整轮对话），返回实际删除条数 */
  deleteMessagesByTimestamps?(sessionId: string, timestamps: number[]): Promise<number>;
}

declare module '@aalis/core' {
  interface HookContextMap {
    /** 记忆清除钩子（统一编排） */
    'memory:clear': {
      /** 清除范围: session=当前会话, all=全局 */
      scope: 'session' | 'all';
      /** 指定清除的子系统（为空则全部清除） */
      types?: string[];
      /** 当前会话 ID（scope=session 时必填） */
      sessionId?: string;
      /** 各子系统报告的结果（由中间件填充） */
      results: Array<{ source: string; success: boolean; message: string }>;
    };
  }
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    memory: MemoryService;
  }
}

// ----- 记忆变更事件契约 -----
//
// 发射方：plugin-checkpoint（回滚删除消息时）；
// 消费方：plugin-memory-vector（清理同时间戳向量）、plugin-webui-server（刷新历史视图）。
declare module '@aalis/core' {
  interface AalisEvents {
    /** 某会话的若干消息被按时间戳删除（回滚等场景），下游存储应同步清理 */
    'memory:messages-deleted': [payload: { sessionId: string; timestamps: number[] }];
    /** 某会话的历史发生结构性变化（删除/回滚），前端应重新拉取 */
    'history:changed': [payload: { sessionId: string }];
  }
}

// ----- 会话记忆压缩事件契约 -----
//
// 压缩协作：plugin-webui-server（手动触发）/ plugin-memory-summary（usage 超阈值
// 自动触发）emit 'session:compress'；plugin-memory-summary 执行压缩并以
// 'session:compressing' 广播进度（webui-server 转发给订阅客户端）。
declare module '@aalis/core' {
  interface AalisEvents {
    /** 请求压缩某会话的记忆。usageRatio 仅 auto 触发时携带 */
    'session:compress': [req: { sessionId: string; reason: 'manual' | 'auto'; usageRatio?: number }];
    /** 压缩进度通知 */
    'session:compressing': [info: { sessionId: string; status: 'start' | 'done' | 'error' }];
  }
}
