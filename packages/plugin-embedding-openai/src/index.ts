import { contributions } from '@aalis/api-contributions';
import { type EmbeddingRequestOptions, type EmbeddingService, embedding } from '@aalis/api-embedding';
import type {} from '@aalis/api-webui'; // 贡献点 webui:options 的键类型经 declaration merging 并入，删掉会丢类型
import { config, definePlugin, lifecycle, logger, optional, provide } from '@aalis/core';
import { configError, defineConfig, parseConfig } from '@aalis/schema-config';

// ===== 配置 =====

const configSchema = defineConfig({
  apiKey: {
    type: 'string',
    label: 'API Key',
    required: true,
    secret: true,
    onInvalid: 'error',
    description: 'OpenAI API 密钥',
  },
  baseUrl: {
    type: 'string',
    label: 'API 地址',
    default: 'https://api.openai.com/v1',
    onInvalid: 'error',
    description: 'API 端点完整前缀（含版本段）；插件只在其后拼 /embeddings 与 /models',
  },
  model: {
    type: 'select',
    label: 'Embedding 模型',
    default: 'text-embedding-3-small',
    dynamicOptions: 'embedding-openai',
    description: '用于生成文本向量的模型',
  },
  timeoutMs: {
    type: 'number',
    label: '请求超时 (ms)',
    default: 30000,
    description: '单次 embedding 请求超时时间。不设上限时启动探测会把插件激活链整条钉住。',
  },
});

// ===== 服务实现 =====

class OpenAIEmbeddingService implements EmbeddingService {
  readonly modelId: string;
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(baseUrl: string, model: string, apiKey: string, timeoutMs = 30000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.modelId = `openai:${model}`;
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
      // 没有 signal 的话这次请求永不自行了结：apply 的启动探测 await 它，卡住的 apply 要等到慢激活阈值
      // 才转入后台、其间排在它后面的插件都在等，此后也一直停在激活中；索引路径上则是 memory-vector 的
      // 一个并发槽被无限期占用。
      signal: options?.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
    });
    if (!res.ok) {
      throw new Error(`OpenAI embedding 请求失败: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  }

  /** 这个端点的全部模型：本插件的可选项来源 embedding-openai 用它 */
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
  /** contributions 交「Embedding 模型」下拉的可选项来源，缺席时下拉没有可选项 */
  uses: { config, logger, lifecycle, provide, contributions: optional(contributions) },
  async apply({ config, logger, lifecycle, provide, contributions }) {
    const cfg = parseConfig(configSchema, config.use, logger.use);
    if (!URL.canParse(cfg.baseUrl) || new URL(cfg.baseUrl).username || new URL(cfg.baseUrl).password) {
      throw configError('baseUrl 需为不带用户名或密码的完整 URL');
    }
    // 插件在 baseUrl 后面拼路径，带查询串或片段（含末尾单个 ?）时拼出来的地址是坏的，所以按原文判
    if (/[?#]/.test(cfg.baseUrl)) {
      throw configError('baseUrl 不能带查询串或片段（? 或 # 之后的部分）：插件在它后面拼接路径');
    }
    const service = new OpenAIEmbeddingService(cfg.baseUrl, cfg.model, cfg.apiKey, cfg.timeoutMs);

    // 启动时检查连通性（失败不阻塞，只警告）；停用或停机时中止
    try {
      await service.embed('ping', { signal: lifecycle.use.signal });
      logger.use.info(`OpenAI Embedding 已就绪: ${cfg.model} @ ${cfg.baseUrl}`);
    } catch (err) {
      lifecycle.use.signal.throwIfAborted();
      const msg = err instanceof Error ? err.message : String(err);
      logger.use.warn(`OpenAI Embedding 连通性检查失败 (${cfg.baseUrl}, model=${cfg.model}): ${msg}，服务仍将注册`);
    }

    provide.use(embedding, service, { label: `OpenAI / ${cfg.model}` });
    // 「Embedding 模型」下拉只列这个插件连着的端点的模型（按服务名合起各提供者会混进别家的）；来源名按插件定，开了几个实例时
    // WebUI 取最前那家
    contributions.use.contribute('webui:options', {
      id: 'embedding-openai',
      list: async () => (await service.listModels()).map(id => ({ value: id, label: id })),
    });
  },
});
