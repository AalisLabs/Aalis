import type { Context, EmbeddingService, ConfigSchema } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-embedding-ollama';
export const provides = ['embedding'];

export const configSchema: ConfigSchema = {
  baseUrl: { type: 'string', label: 'Ollama 地址', default: 'http://localhost:11434' },
  model: { type: 'select', label: 'Embedding 模型', default: 'nomic-embed-text', dynamicOptions: 'embedding' },
};

// ===== 配置 =====

interface OllamaEmbeddingConfig {
  baseUrl: string;
  model: string;
}

// ===== 服务实现 =====

class OllamaEmbeddingService implements EmbeddingService {
  private baseUrl: string;
  private model: string;
  /** 缓存新旧 API 检测结果：true=新版 /api/embed，false=旧版 /api/embeddings */
  private useNewApi: boolean | null = null;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    // 如果还没检测过，先尝试新版 API
    if (this.useNewApi === null) {
      try {
        const vec = await this.embedNew(text);
        this.useNewApi = true;
        return vec;
      } catch {
        this.useNewApi = false;
        return this.embedLegacy(text);
      }
    }
    return this.useNewApi ? this.embedNew(text) : this.embedLegacy(text);
  }

  /** 新版 Ollama API: POST /api/embed */
  private async embedNew(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embedding 请求失败: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  /** 旧版 Ollama API: POST /api/embeddings */
  private async embedLegacy(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embedding 请求失败: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { embedding: number[] };
    return data.embedding;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models: { name: string }[] };
      // 过滤出 embedding 类模型（名称中包含 embed 的）
      // 如果没有特征可辨别，返回全部让用户自己选
      return data.models.map(m => m.name);
    } catch {
      return [];
    }
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const baseUrl = (config.baseUrl as string) ?? 'http://localhost:11434';
  const model = (config.model as string) ?? 'nomic-embed-text';

  const service = new OllamaEmbeddingService(baseUrl, model);

  // 启动时检查连通性（失败不阻塞，只警告）
  try {
    await service.embed('ping');
    ctx.logger.info(`Ollama Embedding 已就绪: ${model} @ ${baseUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Ollama Embedding 连通性检查失败 (${baseUrl}, model=${model}): ${msg}，服务仍将注册`);
  }

  ctx.provide('embedding', service, {
    capabilities: ['embed', 'ollama'],
  });
}
