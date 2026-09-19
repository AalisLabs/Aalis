// ----- Embedding 服务接口 -----

// 触发 @aalis/core 模块解析，使下方 declare module 增强生效
import type {} from '@aalis/core';
import { defineService } from '@aalis/core';

export interface EmbeddingRequestOptions {
  /** 调用方取消或超时后停止请求，不再重试。 */
  signal?: AbortSignal;
}

export interface EmbeddingService {
  /** 将文本转为向量；支持取消的 provider 应将 signal 传至底层请求。 */
  embed(text: string, options?: EmbeddingRequestOptions): Promise<number[]>;
  /** 列出远端可用模型（用于前端下拉框）*/
  listModels?(): Promise<string[]>;
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    embedding: EmbeddingService;
  }
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const embedding = defineService<EmbeddingService>('embedding');
