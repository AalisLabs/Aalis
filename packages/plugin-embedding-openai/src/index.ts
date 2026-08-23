import type { EmbeddingService } from '@aalis/api-embedding';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-embedding-openai';
export const displayName = 'OpenAI Embedding';
export const subsystem = 'embedding';
export const provides = ['embedding'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, description: 'OpenAI API 密钥' },
  baseUrl: {
    type: 'string',
    label: 'API 地址',
    default: 'https://api.openai.com/v1',
    description: 'API 端点完整前缀（含版本段）；插件只在其后拼 /embeddings 与 /models',
  },
  model: {
    type: 'select',
    label: 'Embedding 模型',
    default: 'text-embedding-3-small',
    dynamicOptions: 'embedding',
    description: '用于生成文本向量的模型',
  },
};

// ===== 服务实现 =====

class OpenAIEmbeddingService implements EmbeddingService {
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(baseUrl: string, model: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
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
      const res = await fetch(`${this.baseUrl}/models`, {
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

  let baseUrl = (config.baseUrl as string) ?? 'https://api.openai.com/v1';
  // 一次性迁移（baseUrl 改「完整前缀」语义）：config-sync 会把旧默认值物化进配置文件，
  // 精确命中旧默认时就地升级；自定义端点见 CHANGELOG 迁移说明。
  if (baseUrl === 'https://api.openai.com') {
    ctx.logger.warn('baseUrl 语义已改为完整前缀（插件不再自动拼 /v1）：旧默认值已自动升级为 https://api.openai.com/v1');
    baseUrl = 'https://api.openai.com/v1';
  }
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
