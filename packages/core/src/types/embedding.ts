// ----- Embedding 服务接口 -----

export interface EmbeddingService {
  /** 将文本转为向量 */
  embed(text: string): Promise<number[]>;
  /** 列出远端可用模型（用于前端下拉框）*/
  listModels?(): Promise<string[]>;
}
