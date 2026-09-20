import { type EmbeddingRequestOptions, type EmbeddingService, embedding } from '@aalis/api-embedding';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import { config, definePlugin, logger, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';

// ===== 配置 =====

const configSchema: ConfigSchema = {
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
  timeoutMs: {
    type: 'number',
    label: '请求超时 (ms)',
    default: 30000,
    description: '单次 embedding 请求超时时间。不设上限时启动探测会把插件激活链整条钉住。',
  },
};

// ===== 服务实现 =====

class OpenAIEmbeddingService implements EmbeddingService {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(baseUrl: string, model: string, apiKey: string, timeoutMs = 30000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = Math.max(1000, timeoutMs);
  }

  async embed(text: string, options?: EmbeddingRequestOptions): Promise<number[]> {
    options?.signal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
      // 没有 signal 的话这次请求永不自行了结：apply 的启动探测 await 它，而插件激活是串行的
      // （PluginManager.recompute 逐个 await activatePlugin），一个卡住的 apply 会钉住整条引导链；
      // 索引路径上则是 memory-vector 的一个并发槽被无限期占用。
      signal: options?.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
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
        signal: AbortSignal.timeout(this.timeoutMs),
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

export default definePlugin({
  name: '@aalis/plugin-embedding-openai',
  displayName: 'OpenAI Embedding',
  subsystem: 'embedding',
  configSchema,
  reusable: true,
  provides: [embedding],
  uses: { config, logger, provide },
  async apply({ config, logger, provide }) {
    const apiKey = config.apiKey as string;
    if (!apiKey) {
      throw new Error('OpenAI Embedding 插件需要配置 apiKey');
    }

    let baseUrl = (config.baseUrl as string) ?? 'https://api.openai.com/v1';
    // 一次性迁移（baseUrl 改「完整前缀」语义）：config-sync 会把旧默认值物化进配置文件，
    // 精确命中旧默认时就地升级；自定义端点见 CHANGELOG 迁移说明。
    if (baseUrl === 'https://api.openai.com') {
      logger.warn('baseUrl 语义已改为完整前缀（插件不再自动拼 /v1）：旧默认值已自动升级为 https://api.openai.com/v1');
      baseUrl = 'https://api.openai.com/v1';
    }
    const model = (config.model as string) ?? 'text-embedding-3-small';

    const timeoutMs = (config.timeoutMs as number) ?? 30000;

    const service = new OpenAIEmbeddingService(baseUrl, model, apiKey, timeoutMs);

    // 启动时检查连通性（失败不阻塞，只警告）
    try {
      await service.embed('ping');
      logger.info(`OpenAI Embedding 已就绪: ${model} @ ${baseUrl}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`OpenAI Embedding 连通性检查失败 (${baseUrl}, model=${model}): ${msg}，服务仍将注册`);
    }

    provide(embedding, service, { label: `OpenAI / ${model}` });
  },
});
