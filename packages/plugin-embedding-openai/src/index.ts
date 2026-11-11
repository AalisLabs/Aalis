import { contributions } from '@aalis/api-contributions';
import { type EmbeddingRequestOptions, type EmbeddingService, embedding } from '@aalis/api-embedding';
import type {} from '@aalis/api-webui'; // 贡献点 webui:options 的键类型经 declaration merging 并入，删掉会丢类型
import { config, definePlugin, lifecycle, logger, optional, provide } from '@aalis/core';
import { configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { t } from './texts.js';

// ===== 配置 =====

const configSchema = defineConfig({
  apiKey: {
    type: 'string',
    label: 'API Key',
    required: true,
    secret: true,
    onInvalid: 'error',
    description: t('apiKeyDescription'),
  },
  baseUrl: {
    type: 'string',
    label: t('baseUrlLabel'),
    default: 'https://api.openai.com/v1',
    onInvalid: 'error',
    description: t('baseUrlDescription'),
  },
  model: {
    type: 'select',
    label: t('modelLabel'),
    default: 'text-embedding-3-small',
    dynamicOptions: 'embedding-openai',
    description: t('modelDescription'),
  },
  timeoutMs: {
    type: 'number',
    label: t('timeoutMsLabel'),
    default: 30000,
    description: t('timeoutMsDescription'),
  },
});

// ===== 服务实现 =====

class OpenAIEmbeddingService implements EmbeddingService {
  readonly modelId: string;
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private timeoutMs: number;

  /**
   * activation 是本插件这次激活的中止信号：embed 把它与调用方的合起来；取模型列表的调用方（可选项来源、webui-server 合并各
   * 提供者的取值）都不带信号，只用它。停用、重启、停机时请求随之停下
   */
  constructor(
    baseUrl: string,
    model: string,
    apiKey: string,
    timeoutMs: number,
    private readonly activation: AbortSignal,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.modelId = `openai:${model}`;
    this.apiKey = apiKey;
    this.timeoutMs = Math.max(1000, timeoutMs);
  }

  async embed(text: string, options?: EmbeddingRequestOptions): Promise<number[]> {
    // 调用方的中止信号与本插件这次激活的合起来：调用方没中止、本插件停用或重启时请求同样停下
    const signal = options?.signal ? AbortSignal.any([options.signal, this.activation]) : this.activation;
    signal.throwIfAborted();
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
      // 没有超时的话这次请求永不自行了结：apply 的启动探测 await 它，卡住的 apply 要等到慢激活阈值
      // 才转入后台、其间排在它后面的插件都在等，此后也一直停在激活中；索引路径上则是 memory-vector 的
      // 一个并发槽被无限期占用。
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal]),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embedding 请求失败: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  }

  /** 这个端点的全部模型：本插件的可选项来源 embedding-openai 用它。取不到（含停用时中止）为空列表 */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.activation]),
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
      throw configError(t('baseUrlInvalid'));
    }
    // 插件在 baseUrl 后面拼路径，带查询串或片段（含末尾单个 ?）时拼出来的地址是坏的，所以按原文判
    if (/[?#]/.test(cfg.baseUrl)) {
      throw configError(t('baseUrlQuery'));
    }
    const service = new OpenAIEmbeddingService(cfg.baseUrl, cfg.model, cfg.apiKey, cfg.timeoutMs, lifecycle.use.signal);

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
    // 「Embedding 模型」下拉只列这个插件连着的端点的模型（按服务名合并各提供者会混进别家的）；来源名按插件定，开了几个实例时
    // WebUI 取最前那家
    contributions.use.contribute('webui:options', {
      id: 'embedding-openai',
      list: async () => (await service.listModels()).map(id => ({ value: id, label: id })),
    });
  },
});
