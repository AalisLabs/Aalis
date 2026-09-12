import type { EmbeddingService } from '@aalis/api-embedding';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-embedding-ollama';
export const displayName = 'Ollama Embedding';
export const subsystem = 'embedding';
export const provides = ['embedding'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  baseUrl: {
    type: 'string',
    label: 'Ollama 地址',
    default: 'http://localhost:11434',
    description: '本地 Ollama 服务的 HTTP 地址',
  },
  model: {
    type: 'select',
    label: 'Embedding 模型',
    default: 'nomic-embed-text',
    dynamicOptions: 'embedding',
    description: '用于生成文本向量的模型',
  },
  timeoutMs: { type: 'number', label: '请求超时 (ms)', default: 30000, description: '单次 embedding 请求超时时间' },
  retries: { type: 'number', label: '失败重试次数', default: 1, description: 'fetch 失败或 5xx 时的重试次数' },
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 带 HTTP 状态码的响应错误：新旧 API 探测据此区分「端点不存在」与瞬态故障 */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 只有「这个端点不存在」才足以判定该 Ollama 是旧版 */
function isEndpointMissing(err: unknown): boolean {
  return err instanceof HttpStatusError && (err.status === 404 || err.status === 405);
}

// ===== 服务实现 =====

class OllamaEmbeddingService implements EmbeddingService {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private retries: number;
  /** 缓存新旧 API 检测结果：true=新版 /api/embed，false=旧版 /api/embeddings */
  private useNewApi: boolean | null = null;

  constructor(baseUrl: string, model: string, timeoutMs: number, retries: number) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = Math.max(1000, timeoutMs);
    this.retries = Math.max(0, Math.floor(retries));
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok || res.status < 500 || attempt >= this.retries) return res;
        lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      } catch (err) {
        lastErr = err;
        if (attempt >= this.retries) throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Ollama embedding 请求失败: ${formatError(lastErr)}`);
  }

  async embed(text: string): Promise<number[]> {
    // 如果还没检测过，先尝试新版 API。
    // 只有明确的 404/405（端点不存在）才值得试旧端点：网络不通/超时/5xx 是瞬态故障
    // （典型场景是 Ollama 晚于 Aalis 起来，启动探测正好撞上），原样抛出并保持 null，
    // 下次调用重探——否则一次瞬态失败会把整个生命周期钉在已弃用端点上。
    // 新端点 404 本身也不足以判定是旧版：模型没 pull 时新旧两个端点都答 404。
    // 所以结论只在旧端点真答上来之后才钉成「旧版」，否则连同错误一起抛出、保持 null。
    if (this.useNewApi === null) {
      try {
        const vec = await this.embedNew(text);
        this.useNewApi = true;
        return vec;
      } catch (err) {
        if (!isEndpointMissing(err)) throw err;
        const vec = await this.embedLegacy(text);
        this.useNewApi = false;
        return vec;
      }
    }
    return this.useNewApi ? this.embedNew(text) : this.embedLegacy(text);
  }

  /** 新版 Ollama API: POST /api/embed */
  private async embedNew(text: string): Promise<number[]> {
    const res = await this.postJson('/api/embed', { model: this.model, input: text });
    if (!res.ok) {
      throw new HttpStatusError(res.status, `Ollama embedding 请求失败: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  /** 旧版 Ollama API: POST /api/embeddings */
  private async embedLegacy(text: string): Promise<number[]> {
    const res = await this.postJson('/api/embeddings', { model: this.model, prompt: text });
    if (!res.ok) {
      throw new HttpStatusError(res.status, `Ollama embedding 请求失败: ${res.status} ${res.statusText}`);
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
  const timeoutMs = (config.timeoutMs as number) ?? 30000;
  const retries = (config.retries as number) ?? 1;

  const service = new OllamaEmbeddingService(baseUrl, model, timeoutMs, retries);

  // 启动时检查连通性（失败不阻塞，只警告）
  try {
    await service.embed('ping');
    ctx.logger.info(`Ollama Embedding 已就绪: ${model} @ ${baseUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Ollama Embedding 连通性检查失败 (${baseUrl}, model=${model}): ${msg}，服务仍将注册`);
  }

  ctx.provide('embedding', service, { label: `Ollama / ${model}` });
}
