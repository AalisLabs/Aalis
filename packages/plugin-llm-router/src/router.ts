import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  Context,
  LLMCapability,
  LLMService,
  Logger,
  ModelInfo,
} from '@aalis/core';

/** Provider 端额外可选方法（不强制写入 LLMService 主接口） */
interface LLMProviderShape extends Partial<LLMService> {
  listModels?(): Promise<ModelInfo[]>;
  getDefaultModelId?(): string | undefined;
}

/** 经 ctx.getAllServices 枚举出的 provider 条目 */
interface LLMProviderEntry {
  instance: LLMProviderShape;
  contextId: string;
  capabilities: string[];
  label?: string;
}

/**
 * LLM 路由器
 *
 * 同名 facade 模式（与 plugin-storage-router / plugin-platform 对齐）：通过
 * `ctx.provide('llm', router, { capabilities: ['router'] })` 注册成 'llm' 服务的
 * "高优先级聚合层"。底层 provider 仍以 `provide('llm', impl)` 单独存在，router
 * 通过 `ctx.getAllServices('llm')` 枚举它们并按 (provider, model) 二元组分发。
 *
 * 对外 API（消费者视角）：
 * - `getService<LLMService>('llm')?.chat({ provider, model, ... })` —— router 内部按 provider/model 路由
 * - `getService<LLMService>('llm', ['router'])?.listModels()` —— 聚合所有 provider 的模型，
 *   返回 ModelInfo[]（带 provider/contextId），供 introspection 使用
 *
 * 自我排除：枚举 'llm' 服务时过滤掉 instance === this，避免无限递归。
 *
 * 路由策略（三层判定，与 ChatRequest 字段语义严格对应）：
 *
 *   1. 指定了 provider          → 精确按 contextId 命中；不命中抛错。**不**校验 model 是否在
 *      该 provider 的 listModels 中——把决断权留给 provider（远端会返回 model_not_found），
 *      同时保留"OpenAI 兼容 endpoint 通配直通"的能力。
 *   2. 仅指定 model，未指定 provider → 在所有 provider 的 listModels 中查找 model id：
 *      - 命中 0 个：抛错（提示"请指定 provider 或加入 customModels"）
 *      - 命中 1 个：路由到该 provider
 *      - 命中 ≥ 2 个：抛错（提示"model 在多 provider 中均存在，请指定 provider"），
 *        这是用户感知到歧义的唯一时机，与启动期猜测/警告相比更显式
 *   3. 都不指定                → 用首个 provider 的默认 model
 *
 * 与历史版本的差异：删除了 `supportsModel` 启发式路由——单一信息源（listModels）+ 显式
 * provider 字段足够覆盖所有路由场景，避免"先到先得"的隐式竞态。
 */
export class LLMRouter implements LLMService {
  constructor(private readonly ctx: Context, private readonly logger: Logger) {}

  /** 仅枚举真正的 LLM provider，排除 router 自身 */
  private getProviders(): LLMProviderEntry[] {
    return this.ctx.getAllServices<LLMProviderShape>('llm')
      .filter(e => (e.instance as unknown) !== this);
  }

  // ---- LLMService 实现 ----

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { instance, contextId } = await this.resolveProvider(request);
    if (typeof instance.chat !== 'function') {
      throw new Error(`LLM provider ${contextId} 不支持 chat()`);
    }
    return instance.chat(request);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const { instance, contextId } = await this.resolveProvider(request, ['streaming']);
    if (typeof instance.chatStream !== 'function') {
      throw new Error(`LLM provider ${contextId} 不支持 chatStream()`);
    }
    yield* instance.chatStream(request);
  }

  getTemperature(): number {
    return this.getDefaultProviderOrThrow().instance.getTemperature?.() ?? 0.7;
  }

  getMaxTokens(): number {
    return this.getDefaultProviderOrThrow().instance.getMaxTokens?.() ?? 4096;
  }

  getContextLength(): number {
    return this.getDefaultProviderOrThrow().instance.getContextLength?.() ?? 8192;
  }

  getDefaultModelId(): string | undefined {
    return this.getDefaultProvider()?.instance.getDefaultModelId?.();
  }

  /** 聚合所有 provider 的模型；同 ID 出现在多个 provider 时**不**合并——保留各自归属，
   * 由调用方在 ChatRequest.provider 中显式选择。 */
  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    for (const { instance, contextId, label } of this.getProviders()) {
      if (typeof instance.listModels !== 'function') continue;
      try {
        const models = await instance.listModels();
        for (const m of models) {
          out.push({ id: m.id, capabilities: m.capabilities, provider: label ?? contextId, contextId });
        }
      } catch (err) {
        this.logger.warn(`获取模型列表失败 [${contextId}]:`, err);
      }
    }
    return out;
  }

  // ---- 内部 ----

  /** 按 ChatRequest 三层判定解析归属 provider */
  private async resolveProvider(
    request: ChatRequest,
    extraRequiredCapabilities: string[] = [],
  ): Promise<LLMProviderEntry> {
    const providers = this.getProviders();
    if (providers.length === 0) throw new Error('没有可用的 LLM provider');

    const requiredCapabilities = this.getRequiredCapabilities(request, extraRequiredCapabilities);

    // 1. 指定了 provider → 精确路由，不校验 model
    if (request.provider) {
      const found = providers.find(p => p.contextId === request.provider);
      if (!found) {
        throw new Error(
          `未知 LLM provider "${request.provider}"，可用：[${providers.map(p => p.contextId).join(', ')}]`,
        );
      }
      this.assertCapabilities(found, requiredCapabilities);
      return found;
    }

    // 2. 仅指定 model → listModels 中按 id 查找
    if (request.model) {
      const candidates = await this.findProvidersByModel(providers, request.model);
      if (candidates.length === 0) {
        throw new Error(
          `没有 LLM provider 列出 model "${request.model}"。请在 ChatRequest.provider 中指定，或在对应 provider 的 customModels 配置里加入此 model。`,
        );
      }
      if (candidates.length > 1) {
        throw new Error(
          `model "${request.model}" 在多个 provider 中均存在 [${candidates.map(c => c.contextId).join(', ')}]，` +
            `请通过 ChatRequest.provider 显式指定。`,
        );
      }
      this.assertCapabilities(candidates[0], requiredCapabilities);
      return candidates[0];
    }

    // 3. 都不指定 → 默认 provider
    const defaultProvider = providers[0];
    this.assertCapabilities(defaultProvider, requiredCapabilities);
    return defaultProvider;
  }

  private async findProvidersByModel(providers: LLMProviderEntry[], modelId: string): Promise<LLMProviderEntry[]> {
    const matches: LLMProviderEntry[] = [];
    for (const p of providers) {
      if (typeof p.instance.listModels !== 'function') continue;
      try {
        const models = await p.instance.listModels();
        if (models.some(m => m.id === modelId)) matches.push(p);
      } catch (err) {
        this.logger.warn(`listModels 失败 [${p.contextId}]，跳过该 provider 的 model 匹配:`, err);
      }
    }
    return matches;
  }

  private getRequiredCapabilities(request: ChatRequest, extra: string[]): string[] {
    const required = new Set(extra);
    if (request.tools && request.tools.length > 0) required.add('tool_calling');
    if (request.messages.some(m => m.images && m.images.length > 0)) required.add('vision');
    if (request.think === true) required.add('thinking');
    return [...required];
  }

  private assertCapabilities(provider: LLMProviderEntry, requiredCapabilities: string[]): void {
    if (requiredCapabilities.length === 0) return;
    const missing = requiredCapabilities.filter(c => !provider.capabilities.includes(c as LLMCapability));
    if (missing.length > 0) {
      throw new Error(
        `LLM provider ${provider.contextId} 缺少所需能力：[${missing.join(', ')}]`,
      );
    }
  }

  private getDefaultProvider(): LLMProviderEntry | undefined {
    return this.getProviders()[0];
  }

  private getDefaultProviderOrThrow(): LLMProviderEntry {
    const provider = this.getDefaultProvider();
    if (!provider) throw new Error('没有可用的 LLM provider');
    return provider;
  }
}
