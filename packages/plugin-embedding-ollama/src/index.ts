import { contributions } from '@aalis/api-contributions';
import { type CheckResult, doctor } from '@aalis/api-doctor';
import { type EmbeddingRequestOptions, type EmbeddingService, embedding } from '@aalis/api-embedding';
import type {} from '@aalis/api-webui'; // 贡献点 webui:options 的键类型经 declaration merging 并入，删掉会丢类型
import { type BoundOf, config, definePlugin, lifecycle, logger, optional, provide } from '@aalis/core';
import { configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { TextError, textLines, textOf, withText } from '@aalis/schema-i18n';
import { t } from './texts.js';

// ===== 插件元数据 =====

const name = '@aalis/plugin-embedding-ollama';

const configSchema = defineConfig({
  baseUrl: {
    type: 'string',
    label: t('baseUrlLabel'),
    default: 'http://localhost:11434',
    onInvalid: 'error',
    description: t('baseUrlDescription'),
  },
  model: {
    type: 'select',
    label: t('modelLabel'),
    default: 'nomic-embed-text',
    dynamicOptions: 'embedding-ollama',
    description: t('modelDescription'),
  },
  timeoutMs: { type: 'number', label: t('timeoutMsLabel'), default: 30000, description: t('timeoutMsDescription') },
  retries: { type: 'number', label: t('retriesLabel'), default: 1, description: t('retriesDescription') },
});

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
  const { status, statusText } = res;
  const text = detail
    ? t('statusFailedDetail', { endpoint, status, statusText, detail: detail.slice(0, 200) })
    : t('statusFailed', { endpoint, status, statusText });
  return withText(new HttpStatusError(status, text.source), text);
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
  readonly modelId: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private retries: number;
  /** 缓存新旧 API 检测结果：true=新版 /api/embed，false=旧版 /api/embeddings */
  private useNewApi: boolean | null = null;

  /**
   * activation 是本插件这次激活的中止信号：embed 把它与调用方的合起来；取模型列表的调用方（可选项来源、webui-server 合并各
   * 提供者的取值）都不带信号，只用它。停用、重启、停机时请求随之停下
   */
  constructor(
    baseUrl: string,
    model: string,
    timeoutMs: number,
    retries: number,
    private readonly activation: AbortSignal,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.modelId = `ollama:${model}`;
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
    signal: AbortSignal,
  ): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, signal]),
        });
        if (res.ok || res.status < 500 || attempt >= this.retries) {
          return { ok: res.ok, status: res.status, statusText: res.statusText, text: await res.text() };
        }
        // 要重试：主动取消被丢弃的响应体，否则 undici 侧套接字被钉住到 GC
        await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        signal.throwIfAborted();
        if (attempt >= this.retries) throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async embed(text: string, options?: EmbeddingRequestOptions): Promise<number[]> {
    // 调用方的中止信号与本插件这次激活的合起来：调用方没中止、本插件停用或重启时请求同样停下，不再重试
    const signal = options?.signal ? AbortSignal.any([options.signal, this.activation]) : this.activation;
    signal.throwIfAborted();
    // 如果还没检测过，先尝试新版 API。
    // 只有明确的 404/405（端点不存在）才值得试旧端点：网络不通/超时/5xx 是瞬态故障
    // （典型场景是 Ollama 晚于 Aalis 起来，启动探测正好撞上），原样抛出并保持 null，
    // 下次调用重探——否则一次瞬态失败会把整个生命周期钉在已弃用端点上。
    // 新端点 404 本身也不足以判定是旧版：模型没 pull 时新旧两个端点都答 404。
    // 所以结论只在旧端点真答上来之后才钉成「旧版」，否则连同错误一起抛出、保持 null。
    if (this.useNewApi === null) {
      try {
        const vec = await this.embedNew(text, signal);
        this.useNewApi = true;
        return vec;
      } catch (err) {
        signal.throwIfAborted();
        if (!isEndpointMissing(err)) throw err;
        const vec = await this.embedLegacy(text, signal);
        this.useNewApi = false;
        return vec;
      }
    }
    return this.useNewApi ? this.embedNew(text, signal) : this.embedLegacy(text, signal);
  }

  /** 新版 Ollama API: POST /api/embed */
  private async embedNew(text: string, signal: AbortSignal): Promise<number[]> {
    const res = await this.postJson('/api/embed', { model: this.model, input: text }, signal);
    if (!res.ok) {
      throw statusError(res, '/api/embed');
    }
    const data = JSON.parse(res.text) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  /** 旧版 Ollama API: POST /api/embeddings */
  private async embedLegacy(text: string, signal: AbortSignal): Promise<number[]> {
    const res = await this.postJson('/api/embeddings', { model: this.model, prompt: text }, signal);
    if (!res.ok) {
      throw statusError(res, '/api/embeddings');
    }
    const data = JSON.parse(res.text) as { embedding: number[] };
    return data.embedding;
  }

  /** 本机 Ollama 的全部模型：本插件的可选项来源 embedding-ollama 用它。取不到（含停用时中止）为空列表 */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.activation]),
      });
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

/**
 * doctor 是可选依赖：服务注册成功 != 模型可用，健康状况经 registerCheck 上报。contributions 交「Embedding 模型」下拉的
 * 可选项来源，缺席时下拉没有可选项
 */
const uses = { config, logger, lifecycle, provide, doctor: optional(doctor), contributions: optional(contributions) };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name,
  displayName: 'Ollama Embedding',
  subsystem: 'embedding',
  configSchema,
  reusable: true,
  provides: [embedding],
  uses,
  apply: startOllamaEmbedding,
});

async function startOllamaEmbedding({
  config,
  logger,
  lifecycle,
  provide,
  doctor,
  contributions,
}: Caps): Promise<void> {
  const cfg = parseConfig(configSchema, config.use, logger.use);
  if (!URL.canParse(cfg.baseUrl) || new URL(cfg.baseUrl).username || new URL(cfg.baseUrl).password) {
    throw configError(t('baseUrlInvalid'));
  }
  // 插件在 baseUrl 后面拼路径，带查询串或片段（含末尾单个 ?）时拼出来的地址是坏的，所以按原文判
  if (/[?#]/.test(cfg.baseUrl)) {
    throw configError(t('baseUrlQuery'));
  }
  const { baseUrl, model, timeoutMs } = cfg;
  const service = new OllamaEmbeddingService(baseUrl, model, timeoutMs, cfg.retries, lifecycle.use.signal);

  // 启动时检查连通性（失败不阻塞，只警告）；停用或停机时中止
  try {
    await service.embed('ping', { signal: lifecycle.use.signal });
    logger.use.info(`Ollama Embedding 已就绪: ${model} @ ${baseUrl}`);
  } catch (err) {
    lifecycle.use.signal.throwIfAborted();
    const msg = err instanceof Error ? err.message : String(err);
    logger.use.warn(`Ollama Embedding 连通性检查失败 (${baseUrl}, model=${model}): ${msg}，服务仍将注册`);
  }

  provide.use(embedding, service, { label: `Ollama / ${model}` });
  // 「Embedding 模型」下拉只列这个插件连着的 Ollama 的模型（按服务名合起各提供者会混进别家的）；来源名按插件定，开了几个实例时
  // WebUI 取最前那家
  contributions.use.contribute('webui:options', {
    id: 'embedding-ollama',
    list: async () => (await service.listModels()).map(name => ({ value: name, label: name })),
  });

  // 连通性失败只 warn、服务照常注册，是刻意的（Ollama 可能晚于 Aalis 起来）。
  // 代价是「服务在、但每次调用都失败」这一态对用户完全不可见：/status 只数插件状态，
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
  const checkId = lifecycle.use.id.startsWith(`${name}:`)
    ? `embedding.ollama.${lifecycle.use.id.slice(name.length + 1)}`
    : 'embedding.ollama';
  doctor.use.registerCheck({
    id: checkId,
    category: 'service',
    // 不写死 pluginName：绑定门面会填这次激活的 id，多实例才分得清是哪一个
    async run(): Promise<CheckResult> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          // 停用、停机时探测随之停下
          service.embed('ping', { signal: AbortSignal.any([controller.signal, lifecycle.use.signal]) }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new TextError(t('probeTimeout', { ms: probeTimeoutMs }));
              controller.abort(error);
              reject(error);
            }, probeTimeoutMs);
            timer.unref?.(); // 待定的探测计时器不该挡住进程优雅退出
          }),
        ]);
        return {
          id: checkId,
          category: 'service',
          level: 'ok',
          message: t('checkOk', { model, baseUrl }),
        };
      } catch (err) {
        // 中止不是不可用：抛中止原因
        lifecycle.use.signal.throwIfAborted();
        return {
          id: checkId,
          category: 'service',
          level: 'error',
          message: t('checkFailed', { model, baseUrl }),
          detail: textLines([textOf(err), t('checkFix', { model })]),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}
