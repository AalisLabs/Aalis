import type { Context, ConfigSchema, IncomingMessage, LLMService, Message } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-image-recognition';
export const provides = ['image-recognition'];
export const inject = {
  optional: ['llm'],
};

export const configSchema: ConfigSchema = {
  forceEnabled: {
    type: 'boolean',
    label: '强制图像识别',
    description: '启用后，即使主 LLM 支持多模态也强制由本插件处理图片。关闭时自动判断：主 LLM 声明 vision 能力则直接传递图片，否则由本插件转为文字描述。',
    default: false,
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
  forceEnabled: false,
  maxTokens: 300,
};

// ===== 配置接口 =====

interface ImageRecognitionConfig {
  forceEnabled: boolean;
  maxTokens: number;
  prompt: string;
}

const DEFAULT_PROMPT = '请简洁地描述这张图片的内容，包括画面中的主要元素、文字（如果有）、表情包含义等。用中文回答，控制在100字以内。';

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: ImageRecognitionConfig = {
    forceEnabled: (config.forceEnabled as boolean) ?? false,
    maxTokens: (config.maxTokens as number) ?? 300,
    prompt: (config.prompt as string) || '',
  };

  /** 通过 LLM 服务识别单张图片 */
  async function describeImage(visionLLM: LLMService, imageUrl: string): Promise<string> {
    const prompt = cfg.prompt || DEFAULT_PROMPT;

    const messages: Message[] = [
      {
        role: 'user',
        content: prompt,
        images: [imageUrl],
      },
    ];

    try {
      const response = await visionLLM.chat({
        messages,
        maxTokens: cfg.maxTokens,
      });
      return response.content?.trim() || '[图片: 无描述]';
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

    // 获取当前活跃的主 LLM
    const primaryLLM = ctx.getService<LLMService>('llm');
    // 判断主 LLM 是否声明了 vision 能力
    const primaryHasVision = primaryLLM
      ? ctx.getServiceEntries('llm')[0]?.capabilities.has('vision') ?? false
      : false;

    if (!cfg.forceEnabled && primaryHasVision) {
      // 主模型支持多模态且未强制启用 → 图片直接传递给 LLM
      ctx.logger.debug(`主 LLM 支持图像识别，${msg.images.length} 张图片将直接传递给模型`);
      await next();
      return;
    }

    // 寻找任意一个支持 vision 的 LLM 提供者
    const visionProviders = ctx.getAllServices<LLMService>('llm', ['vision']);
    if (visionProviders.length === 0) {
      ctx.logger.warn('没有可用的 vision LLM 提供者，图片将被忽略');
      await next();
      return;
    }

    const visionLLM = visionProviders[0].instance;
    ctx.logger.debug(
      `图像识别中间件：${cfg.forceEnabled ? '强制模式' : '主 LLM 不支持图像识别'}，使用 ${visionProviders[0].contextId} 识别 ${msg.images.length} 张图片`,
    );

    // 并行识别所有图片
    const descriptions = await Promise.all(
      msg.images.map(img => describeImage(visionLLM, img)),
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

  // 注册服务，供其他插件查询图像识别能力是否可用
  ctx.provide('image-recognition', {
    /** 本插件能否处理图片（始终 true，因为插件已加载） */
    available: true,
  });

  ctx.logger.info(`图像识别中间件已加载 (${cfg.forceEnabled ? '强制模式' : '自动路由'})`);
}
