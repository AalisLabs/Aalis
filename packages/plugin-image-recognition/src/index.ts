import type { Context, ConfigSchema, IncomingMessage } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-image-recognition';
export const inject = {
  optional: ['llm'],
};

export const configSchema: ConfigSchema = {
  enabled: {
    type: 'boolean',
    label: '强制图像识别',
    description: '启用后，即使主 LLM 支持多模态也强制由本插件处理图片。关闭时自动判断：主 LLM 声明 vision 能力则直接传递图片，否则由本插件转为文字描述。',
    default: false,
  },
  apiKey: {
    type: 'string',
    label: 'Vision API Key',
    secret: true,
    description: '用于图像识别的 API 密钥。留空则复用主 LLM 的 API Key（从配置中读取）。',
  },
  baseUrl: {
    type: 'string',
    label: 'Vision API 地址',
    default: '',
    description: 'Vision API 端点（OpenAI 兼容）。留空则复用主 LLM 的 API 地址。',
  },
  model: {
    type: 'string',
    label: 'Vision 模型',
    default: 'gpt-4o-mini',
    description: '用于图像识别的模型名称（需支持 vision）。推荐使用低成本的多模态模型。',
  },
  maxTokens: {
    type: 'number',
    label: '最大描述 Token',
    default: 300,
    description: '图像描述的最大 token 数。',
  },
  prompt: {
    type: 'string',
    label: '识别提示词',
    default: '',
    description: '自定义图像识别提示词。留空使用默认提示。',
  },
};

export const defaultConfig = {
  enabled: false,
  model: 'gpt-4o-mini',
  maxTokens: 300,
};

// ===== 配置接口 =====

interface ImageRecognitionConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  prompt: string;
}

const DEFAULT_PROMPT = '请简洁地描述这张图片的内容，包括画面中的主要元素、文字（如果有）、表情包含义等。用中文回答，控制在100字以内。';

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: ImageRecognitionConfig = {
    enabled: (config.enabled as boolean) ?? false,
    apiKey: (config.apiKey as string) || '',
    baseUrl: (config.baseUrl as string) || '',
    model: (config.model as string) || 'gpt-4o-mini',
    maxTokens: (config.maxTokens as number) ?? 300,
    prompt: (config.prompt as string) || '',
  };

  // 尝试从主 LLM 配置中获取 API Key 和 baseUrl 作为回退
  function resolveApiConfig(): { apiKey: string; baseUrl: string } {
    let apiKey = cfg.apiKey;
    let baseUrl = cfg.baseUrl;

    if (!apiKey || !baseUrl) {
      // 尝试从 LLM 插件配置中读取
      const llmPlugins = ['@aalis/plugin-openai', '@aalis/plugin-deepseek'];
      for (const pluginName of llmPlugins) {
        const pluginConfig = ctx.config.getPluginConfig(pluginName);
        if (pluginConfig) {
          if (!apiKey && pluginConfig.apiKey) apiKey = pluginConfig.apiKey as string;
          if (!baseUrl && pluginConfig.baseUrl) baseUrl = pluginConfig.baseUrl as string;
          if (apiKey && baseUrl) break;
        }
      }
    }

    if (!baseUrl) baseUrl = 'https://api.openai.com';
    return { apiKey, baseUrl: baseUrl.replace(/\/$/, '') };
  }

  /** 调用 Vision API 识别单张图片 */
  async function describeImage(imageUrl: string, signal?: AbortSignal): Promise<string> {
    const { apiKey, baseUrl } = resolveApiConfig();
    if (!apiKey) {
      ctx.logger.warn('图像识别：API Key 未配置');
      return '[图片: 无法识别，API Key 未配置]';
    }

    const prompt = cfg.prompt || DEFAULT_PROMPT;

    const body = {
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      max_tokens: cfg.maxTokens,
    };

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const errText = await res.text();
        ctx.logger.warn(`图像识别 API 错误 (${res.status}): ${errText}`);
        return '[图片: 识别失败]';
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() || '[图片: 无描述]';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`图像识别失败: ${msg}`);
      return '[图片: 识别失败]';
    }
  }

  // 注册 message:before 中间件，根据主 LLM 能力智能路由图片处理
  ctx.middleware('message:before', async (data, next) => {
    const msg = data.message as IncomingMessage;
    if (!msg.images || msg.images.length === 0) {
      await next();
      return;
    }

    // 判断主 LLM 是否声明了 vision 能力
    const llmHasVision = ctx.getServiceCapabilities('llm').includes('vision');

    if (!cfg.enabled && llmHasVision) {
      // 主模型支持多模态且未强制启用 → 图片直接传递给 LLM
      ctx.logger.debug(`主 LLM 支持图像识别，${msg.images.length} 张图片将直接传递给模型`);
      await next();
      return;
    }

    // 需要本插件处理：强制模式 或 主 LLM 不支持 vision
    ctx.logger.debug(
      `图像识别中间件：${cfg.enabled ? '强制模式' : '主 LLM 不支持图像识别'}，开始识别 ${msg.images.length} 张图片`,
    );

    // 并行识别所有图片
    const descriptions = await Promise.all(
      msg.images.map(img => describeImage(img)),
    );

    // 将描述附加到消息内容中
    const descText = descriptions
      .map((desc, i) => `[图片${msg.images!.length > 1 ? (i + 1) : ''}: ${desc}]`)
      .join('\n');

    msg.content = msg.content
      ? `${msg.content}\n${descText}`
      : descText;

    // 清除 images，表示已由中间件消费（不再传递给多模态 LLM）
    msg.images = undefined;

    ctx.logger.debug(`图像识别完成：${descriptions.length} 张图片已转为文字描述`);

    await next();
  }, 900); // 高优先级，在 persona 注入之后、其他中间件之前

  ctx.logger.info(`图像识别中间件已加载 (模型: ${cfg.model}, ${cfg.enabled ? '强制模式' : '自动路由'})`);
}
