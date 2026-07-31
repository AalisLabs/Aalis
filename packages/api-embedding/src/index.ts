// ----- Embedding 服务接口 -----

// 触发 @aalis/core 模块解析，使下方 declare module 增强生效
import type {} from '@aalis/core';

export interface EmbeddingService {
  /** 将文本转为向量 */
  embed(text: string): Promise<number[]>;
  /** 列出远端可用模型（用于前端下拉框）*/
  listModels?(): Promise<string[]>;
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    embedding: EmbeddingService;
  }
}
