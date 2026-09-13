import { type CheckResult, useDoctorService } from '@aalis/api-doctor';
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
/** doctor 为可选依赖：服务注册成功 != 模型可用，健康状况经 registerCheck 上报 */
export const inject = {
  optional: ['doctor'],
};

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

/**
 * 把响应体里的 error 一并带进错误消息。
 *
 * Ollama 对「模型没 pull」与「端点不存在」都答 404，只有响应体能区分
 * （前者是 `model "xxx" not found, try pulling it first`）。只报状态码的话，
 * 日志里就只剩一句没有信息量的「404 Not Found」，把人引向端点/网络方向排查。
 */
function statusError(res: { status: number; statusText: string; text: string }, endpoint: string): HttpStatusError {
  let detail = '';
  if (res.text) {
    try {
      const parsed = JSON.parse(res.text) as { error?: unknown };
      detail = typeof parsed.error === 'string' ? parsed.error : res.text;
    } catch {
      detail = res.text;
    }
  }
  const tail = detail ? ` —— ${detail.slice(0, 200)}` : '';
  return new HttpStatusError(
    res.status,
    `Ollama embedding 请求失败 (${endpoint}): ${res.status} ${res.statusText}${tail}`,
  );
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

  /**
   * 发请求**并把响应体读完**，整体落在同一个超时窗口内。
   *
   * 不能把 Response 原样交还调用方：`return res` 时 finally 已 clearTimeout，之后的
   * res.json()/res.text() 不再受 AbortController 保护，遇上「发完响应头却迟迟不发体」的
   * 对端（模型正加载进显存、反代半死）会一直等到 undici 默认 bodyTimeout（300s），
   * 配置的「请求超时」形同虚设，索引路径上的一个并发槽也跟着被占住。
   */
  private async postJson(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
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
        if (res.ok || res.status < 500 || attempt >= this.retries) {
          return { ok: res.ok, status: res.status, statusText: res.statusText, text: await res.text() };
        }
        // 要重试：主动取消被丢弃的响应体，否则 undici 侧套接字被钉住到 GC
        await res.body?.cancel().catch(() => undefined);
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
      throw statusError(res, '/api/embed');
    }
    const data = JSON.parse(res.text) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  /** 旧版 Ollama API: POST /api/embeddings */
  private async embedLegacy(text: string): Promise<number[]> {
    const res = await this.postJson('/api/embeddings', { model: this.model, prompt: text });
    if (!res.ok) {
      throw statusError(res, '/api/embeddings');
    }
    const data = JSON.parse(res.text) as { embedding: number[] };
    return data.embedding;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models: { name: string }[] };
      // 原样返回本机全部模型，不按名字筛。曾改成「筛出名称含 embed 的、筛空回退全量」，
      // 判否：混合场景（同时有 nomic-embed-text 与 bge-m3）会把后者从下拉里剔掉，而本字段
      // 是 select、没有自由输入（allowCustom 只在 multiselect 分支实现），用户除了手改
      // 配置文件没有别的出路。选错模型的代价小于选不到模型，且模型不可用现在由
      // doctor 检查项直接报出来，不再依赖候选列表去做引导。
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

  // 连通性失败只 warn、服务照常注册，是刻意的（Ollama 可能晚于 Aalis 起来）。
  // 代价是「服务在、但每次调用都失败」这一态对用户完全不可见：/status 只判存在性，
  // 插件状态是 active，向量记忆则每条消息静默失败。把真实健康状况交给 doctor 上报。
  // doctor 的 runChecks 顺序 await 且不设超时（plugin-doctor/src/index.ts:runChecks），
  // 而 embed 最长要等 (retries + 1) × timeoutMs（默认 60s）。/doctor 正是出问题时才跑的
  // 命令，不能被一条网络探测拖住：探测自带上限，取 5s 与配置超时中的小者。
  // 与服务构造函数的 clamp 对齐（this.timeoutMs = Math.max(1000, timeoutMs)）：
  // 直接取原始配置值的话，timeoutMs 填 0 会让探测立刻 reject，/doctor 恒报假阳性。
  const probeTimeoutMs = Math.min(5_000, Math.max(1_000, timeoutMs));
  // 本插件 reusable=true，可按 `name:suffix` 起多实例；doctor 以 spec.id 为键，
  // 同 id 重复注册后者覆盖前者——两个实例共用一个 id 就只有一个的健康度可见，
  // 恰是这条检查要堵的洞。默认实例保持 `embedding.ollama`，多实例带上后缀。
  const checkId = ctx.id?.startsWith(`${name}:`)
    ? `embedding.ollama.${ctx.id.slice(name.length + 1)}`
    : 'embedding.ollama';
  useDoctorService(ctx).registerCheck({
    id: checkId,
    category: 'service',
    // 不写死 pluginName：useDoctorService 会填 ctx.id，多实例才分得清是哪一个
    async run(): Promise<CheckResult> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          service.embed('ping'),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`探测超时（${probeTimeoutMs}ms）`)), probeTimeoutMs);
            timer.unref?.(); // 待定的探测计时器不该挡住进程优雅退出
          }),
        ]);
        return {
          id: checkId,
          category: 'service',
          level: 'ok',
          message: `Ollama Embedding 可用 (${model} @ ${baseUrl})`,
        };
      } catch (err) {
        return {
          id: checkId,
          category: 'service',
          level: 'error',
          message: `Ollama Embedding 不可用 (${model} @ ${baseUrl})——向量记忆不工作`,
          detail: formatError(err),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}
