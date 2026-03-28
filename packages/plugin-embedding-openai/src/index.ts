import type { Context, ConfigSchema } from '@aalis/core';
import type { EmbeddingService } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-embedding-openai';
export const displayName = 'OpenAI Embedding';
export const provides = ['embedding'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, description: 'OpenAI API 密钥' },
  baseUrl: { type: 'string', label: 'API 地址', default: 'https://api.openai.com', description: 'API 端点地址' },
  model: { type: 'select', label: 'Embedding 模型', default: 'text-embedding-3-small', dynamicOptions: 'embedding', description: '用于生成文本向量的模型' },
};

export const defaultConfig = {
  baseUrl: 'https://api.openai.com',
  model: 'text-embedding-3-small',
};

// ===== 配置 =====

interface OpenAIEmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

// ===== 服务实现 =====

class OpenAIEmbeddingService implements EmbeddingService {
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(baseUrl: string, model: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embedding 请求失败: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data: { id: string }[] };
      return data.data.map(m => m.id);
    } catch {
      return [];
    }
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const apiKey = config.apiKey as string;
  if (!apiKey) {
    throw new Error('OpenAI Embedding 插件需要配置 apiKey');
  }

  const baseUrl = (config.baseUrl as string) ?? 'https://api.openai.com';
  const model = (config.model as string) ?? 'text-embedding-3-small';

  const service = new OpenAIEmbeddingService(baseUrl, model, apiKey);

  // 启动时检查连通性（失败不阻塞，只警告）
  try {
    await service.embed('ping');
    ctx.logger.info(`OpenAI Embedding 已就绪: ${model} @ ${baseUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`OpenAI Embedding 连通性检查失败 (${baseUrl}, model=${model}): ${msg}，服务仍将注册`);
  }

  ctx.provide('embedding', service, { label: `OpenAI / ${model}` });
}
