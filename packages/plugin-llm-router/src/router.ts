import type { Context, Logger } from '@aalis/core';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMService, ModelInfo } from '@aalis/plugin-llm-api';

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
  constructor(
    private readonly ctx: Context,
    private readonly logger: Logger,
  ) {}

  /** 仅枚举真正的 LLM provider，排除 router 自身 */
  private getProviders(): LLMProviderEntry[] {
    return this.ctx.getAllServices<LLMProviderShape>('llm').filter(e => (e.instance as unknown) !== this);
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

  /**
   * 查询特定 (provider, model) 组合的上下文窗口大小。
   *
   * 优先级：
   * 1. 在目标 provider 的 listModels() 中找到匹配条目并读取 contextLength
   * 2. 退化为 provider.getContextLength()（provider 自报的"默认/通用"窗口）
   * 3. 最终兜底 8192
   *
   * 设计动机：摘要、向量召回等"次要 LLM 调用方"可能选用与主对话不同的 model，
   * 需要按真实模型窗口计算 token 预算，避免因 router 默认 provider 窗口偏差导致预算失真。
   *
   * @param model    可选 model id；未指定走默认逻辑
   * @param provider 可选 contextId；未指定时按 model 在所有 provider 中查找（不命中则用默认 provider）
   */
  async getContextLengthFor(model?: string, provider?: string): Promise<number> {
    const providers = this.getProviders();
    if (providers.length === 0) return 8192;

    let target: LLMProviderEntry | undefined;
    if (provider) {
      target = providers.find(p => p.contextId === provider);
    } else if (model) {
      const candidates = await this.findProvidersByModel(providers, model);
      target = candidates[0];
    }
    target = target ?? providers[0];

    if (model && typeof target.instance.listModels === 'function') {
      try {
        const models = await target.instance.listModels();
        const found = models.find(m => m.id === model);
        if (found?.contextLength && found.contextLength > 0) return found.contextLength;
      } catch (err) {
        this.logger.warn(`listModels 失败 [${target.contextId}]，回退到 getContextLength():`, err);
      }
    }

    return target.instance.getContextLength?.() ?? 8192;
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
          out.push({
            id: m.id,
            capabilities: m.capabilities,
            provider: label ?? contextId,
            contextId,
            ...(m.contextLength ? { contextLength: m.contextLength } : {}),
          });
        }
      } catch (err) {
        this.logger.warn(`获取模型列表失败 [${contextId}]:`, err);
      }
    }
    return out;
  }

  // ---- 内部 ----

  /**
   * 按 ChatRequest 三层判定解析归属 provider。
   *
   * 当请求字段与现实不符时**优雅降级**而非硬抛错（用户视角更友好，避免一次失效配置把整条会话锁死）：
   *
   *   - `provider` 指定但已下线：尝试用同名 model 在剩余 provider 中查找；找到则改路由 + warn。
   *   - `model` 在多个 provider 中均存在：自动选第一个（注册顺序）+ warn 一次，不再抛 "ambiguous" 错。
   *     可选 capabilities 优先用于挑选——若有的 provider 满足而其他不满足，优先满足者。
   *
   * 仍会抛错的情形：完全找不到任何能用的 provider/model 组合（避免静默走到完全错误的模型）。
   */
  private async resolveProvider(
    request: ChatRequest,
    extraRequiredCapabilities: string[] = [],
  ): Promise<LLMProviderEntry> {
    const providers = this.getProviders();
    if (providers.length === 0) throw new Error('没有可用的 LLM provider');

    const requiredCapabilities = this.getRequiredCapabilities(request, extraRequiredCapabilities);

    // 1. 指定了 provider → 精确路由；找不到则尝试按 model 在剩余 provider 中恢复
    if (request.provider) {
      const found = providers.find(p => p.contextId === request.provider);
      if (found) {
        await this.assertCapabilitiesForRequest(found, request.model, requiredCapabilities);
        return found;
      }

      // provider 不存在（已被禁用/卸载）：若同时给了 model，尝试在其他 provider 找
      if (request.model) {
        const candidates = await this.findProvidersByModel(providers, request.model);
        if (candidates.length > 0) {
          const picked = this.pickByCapabilities(candidates, requiredCapabilities);
          this.logger.warn(
            `LLM provider "${request.provider}" 不可用，已自动改用 "${picked.contextId}" 提供同名 model "${request.model}"。` +
              `若不期望此降级，请通过 /model.set 或 /model.reset 修正会话模型引用。`,
          );
          await this.assertCapabilitiesForRequest(picked, request.model, requiredCapabilities);
          return picked;
        }
      }

      throw new Error(
        `未知 LLM provider "${request.provider}"${request.model ? `（model "${request.model}"）` : ''}，` +
          `可用：[${providers.map(p => p.contextId).join(', ')}]。` +
          `若是因禁用插件造成的残留引用，可用 /model.reset 清除会话模型覆盖。`,
      );
    }

    // 2. 仅指定 model → listModels 中按 id 查找
    if (request.model) {
      const candidates = await this.findProvidersByModel(providers, request.model);
      if (candidates.length === 0) {
        throw new Error(
          `没有 LLM provider 列出 model "${request.model}"。可用 provider：[${providers.map(p => p.contextId).join(', ')}]。` +
            `请在 ChatRequest.provider 中指定、在对应 provider 的 customModels 配置里加入此 model，或用 /model.reset 清除残留模型引用。`,
        );
      }
      const picked = this.pickByCapabilities(candidates, requiredCapabilities);
      if (candidates.length > 1) {
        // 多 provider 同名 model：自动选第一个能力满足的，warn 一次告知用户可显式指定
        this.logger.warn(
          `model "${request.model}" 在多个 provider 中均存在 [${candidates.map(c => c.contextId).join(', ')}]，` +
            `已自动路由到 "${picked.contextId}"。如需固定路由，请显式设置 model 为 "${picked.contextId}::${request.model}" 形式。`,
        );
      }
      await this.assertCapabilitiesForRequest(picked, request.model, requiredCapabilities);
      return picked;
    }

    // 3. 都不指定 → 默认 provider
    const defaultProvider = providers[0];
    await this.assertCapabilitiesForRequest(defaultProvider, undefined, requiredCapabilities);
    return defaultProvider;
  }

  /**
   * 在多 provider 命中时挑选首个**能力满足**的；都不满足则退回到第一个，由后续
   * assertCapabilitiesForRequest 给出明确错误，而不是默默路由到一个能力不全的 provider。
   *
   * 此处仅用 provider.capabilities 做粗筛（避免在路由阶段为每个候选异步 listModels 拖慢 hot path）；
   * 选中后由 assertCapabilitiesForRequest 走 model-level 精确判定，错时仍能给清晰错误。
   */
  private pickByCapabilities(candidates: LLMProviderEntry[], requiredCapabilities: string[]): LLMProviderEntry {
    if (requiredCapabilities.length === 0) return candidates[0];
    for (const c of candidates) {
      if (requiredCapabilities.every(cap => c.capabilities.includes(cap))) return c;
    }
    return candidates[0];
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

  /**
   * 按「目标 model 的能力」检查，避免 provider.capabilities（默认模型能力集）与实际调用模型不一致时误报。
   * 优先级：
   *   1. provider.listModels() 中查找该 model，使用其 capabilities
   *   2. 未找到（custom model / listModels 失败）→ fallback 到 provider.capabilities
   *      （后者在新架构下是 providerCapabilities ∪ defaultModel 启发式，仍是合理兑底）
   */
  private async assertCapabilitiesForRequest(
    provider: LLMProviderEntry,
    requestedModel: string | undefined,
    requiredCapabilities: string[],
  ): Promise<void> {
    if (requiredCapabilities.length === 0) return;

    let effectiveCaps: string[] = provider.capabilities;
    if (requestedModel && typeof provider.instance.listModels === 'function') {
      try {
        const models = await provider.instance.listModels();
        const found = models.find(m => m.id === requestedModel);
        if (found?.capabilities && found.capabilities.length > 0) {
          effectiveCaps = found.capabilities;
        }
      } catch (err) {
        this.logger.warn(`listModels 失败 [${provider.contextId}]，能力检查回退到 provider 级别：`, err);
      }
    }

    const missing = requiredCapabilities.filter(c => !effectiveCaps.includes(c));
    if (missing.length > 0) {
      const scope = requestedModel
        ? `model "${requestedModel}" 于 provider ${provider.contextId}`
        : `provider ${provider.contextId}`;
      throw new Error(
        `${scope} 缺少所需能力：[${missing.join(', ')}]。请在适配器配置的 modelCapabilities/providerCapabilities 中补充。`,
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
