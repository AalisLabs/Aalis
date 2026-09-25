// ----- Embedding 服务接口 -----

import { defineService } from '@aalis/core';

export interface EmbeddingRequestOptions {
  /** 调用方取消或超时后停止请求，不再重试。 */
  signal?: AbortSignal;
}

export interface EmbeddingService {
  /**
   * 向量空间标识：modelId 相同的两次 embed 结果可直接比较；换模型必须换值。
   * 消费方把它并入向量缓存的失效键，换模型后即可识别并重算旧向量（含同维度换模型）。
   * 不声明时消费方无法区分模型。
   */
  readonly modelId?: string;
  /** 将文本转为向量；支持取消的 provider 应将 signal 传至底层请求。 */
  embed(text: string, options?: EmbeddingRequestOptions): Promise<number[]>;
  /** 列出远端可用模型（用于前端下拉框）*/
  listModels?(): Promise<string[]>;
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const embedding = defineService<EmbeddingService>('embedding');
