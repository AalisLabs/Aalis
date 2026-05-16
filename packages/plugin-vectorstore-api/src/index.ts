// ----- 向量数据库服务接口 -----

// 触发 @aalis/core 模块解析，使文末 declare module 增强生效
import type {} from '@aalis/core';

/** 向量搜索结果条目 */
export interface VectorSearchResult {
  /** 余弦相似度分数 */
  score: number;
  /** 存储时附带的元数据 */
  metadata: Record<string, unknown>;
}

/** 向量数据库服务——由 vectorstore 插件提供 */
export interface VectorStoreService {
  /** 添加一条向量及其元数据 */
  add(vector: number[], metadata: Record<string, unknown>): Promise<void>;
  /** 搜索最近邻，返回 [分数, 元数据][] */
  search(queryVector: number[], topK: number): Promise<VectorSearchResult[]>;
  /** 当前存储的向量总数 */
  size(): Promise<number>;
  /** 清空所有向量数据 */
  clear(): Promise<void>;
  /** 按 metadata 字段过滤删除（如 { sessionId: 'xxx' }） */
  deleteByFilter?(filter: Record<string, unknown>): Promise<number>;
  /** 持久化（由调用方或 dispose 触发） */
  save(): Promise<void>;
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    vectorstore: VectorStoreService;
  }
}
