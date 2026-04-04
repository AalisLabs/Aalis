import { readFile } from 'node:fs/promises';
import type { Context, ConfigSchema, IncomingMessage, Message, AgentService } from '@aalis/core';
import type { LLMService } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-image-recognition';
export const displayName = '图像识别';
export const provides = ['image-recognition'];
export const inject = {
  optional: ['llm', 'agent'],
};

export const configSchema: ConfigSchema = {
  preferredModel: {
    type: 'select',
    label: '图像识别模型',
    description: '选择用于图像识别的模型。留空则自动选择第一个有 vision 能力的提供者的默认模型。',
    default: '',
    options: [{ label: '自动选择', value: '' }],
    dynamicOptions: 'llm',
  },
  enabled: {
    type: 'boolean',
    label: '启用额外模型识别',
    description: '启用后，始终由本插件使用上方指定的模型将图片转为文字描述后交给 Agent。关闭时图片将直接传递给 Agent 的对话模型处理（需要对话模型支持多模态）。',
    default: true,
  },
  maxTokens: {
    type: 'number',
    label: '最大描述 Token',
    default: 300,
    description: '图像描述的最大 token 数。',
  },
  prompt: {
    type: 'textarea',
    label: '识别提示词',
    default: '',
    description: '自定义图像识别提示词。留空使用默认提示。',
  },
};

export const defaultConfig = {
  enabled: true,
  maxTokens: 300,
};

// ===== 配置接口 =====

interface ImageRecognitionConfig {
  preferredModel: string;
  enabled: boolean;
  maxTokens: number;
  prompt: string;
}

const DEFAULT_PROMPT = '请简洁地描述这张图片的内容，包括画面中的主要元素、文字（如果有）、表情包含义等。用中文回答，控制在100字以内。';

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: ImageRecognitionConfig = {
    preferredModel: (config.preferredModel as string) || '',
    enabled: (config.enabled as boolean) ?? true,
    maxTokens: (config.maxTokens as number) ?? 300,
    prompt: (config.prompt as string) || '',
  };

  // 模型→提供者映射缓存（启动时异步构建）
  let modelProviderMap: Map<string, string> | null = null;
  (async () => {
    const map = new Map<string, string>();
    const allProviders = ctx.getAllServices<LLMService>('llm');
    for (const p of allProviders) {
      if (typeof p.instance.listModels === 'function') {
        try {
          const models = await p.instance.listModels();
          for (const m of models) map.set(m.id, p.contextId);
        } catch { /* ignore */ }
      }
    }
    modelProviderMap = map;
    ctx.logger.debug(`图像识别模型映射已构建: ${map.size} 个模型`);
  })();

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
        model: cfg.preferredModel || undefined,
      });
      return response.content?.trim() || '[图片: 无描述]';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`图像识别失败: ${msg}`);
      return '[图片: 识别失败]';
    }
  }

  // 图片预处理函数
  async function preprocessImages(msg: IncomingMessage, next: () => Promise<void>): Promise<void> {
    if (!msg.images || msg.images.length === 0) {
      await next();
      return;
    }

    // 未启用额外模型识别 → 图片直接传递给 Agent 的对话模型
    if (!cfg.enabled) {
      ctx.logger.debug(`图像识别未启用，${msg.images.length} 张图片将直接传递给对话模型`);
      await next();
      return;
    }

    // 寻找图像识别用的 LLM 提供者
    const allProviders = ctx.getAllServices<LLMService>('llm');
    let chosen = allProviders.find(p => p.capabilities.includes('vision')) ?? allProviders[0];
    if (!chosen) {
      ctx.logger.warn('没有可用的 LLM 提供者，图片将被忽略');
      await next();
      return;
    }

    // 如果用户指定了模型，尝试找到拥有该模型的提供者
    if (cfg.preferredModel && modelProviderMap) {
      const mappedProvider = modelProviderMap.get(cfg.preferredModel);
      if (mappedProvider) {
        const found = allProviders.find(p => p.contextId === mappedProvider);
        if (found) chosen = found;
      }
    }

    const visionLLM = chosen.instance;
    ctx.logger.debug(
      `图像识别中间件：使用 ${chosen.contextId} 识别 ${msg.images.length} 张图片`,
    );

    // 并行识别所有图片
    const descriptions = await Promise.all(
      msg.images.map(img => describeImage(visionLLM, img)),
    );

    const descTexts = descriptions
      .map((desc, i) => `[图片${msg.images!.length > 1 ? (i + 1) : ''}: ${desc}]`);

    // 如果有 attachmentOrder，将图片描述存入 _imageDescriptions，交由后续统一组装
    if (msg.attachmentOrder) {
      msg._imageDescriptions = descTexts;
    } else {
      const descText = descTexts.join('\n');
      msg.content = msg.content
        ? `${msg.content}\n${descText}`
        : descText;
    }

    // 清除 images，表示已由中间件消费（不再传递给多模态 LLM）
    msg.images = undefined;

    ctx.logger.debug(`图像识别完成：${descriptions.length} 张图片已转为文字描述`);

    await next();
  }

  // 优先使用 agent.registerPreprocessor，回退到 ctx.middleware
  const agent = ctx.getService<AgentService>('agent');
  if (agent?.registerPreprocessor) {
    agent.registerPreprocessor('image-recognition', preprocessImages, 900);
  } else {
    ctx.middleware('message:before', async (data, next) => {
      await preprocessImages(data.message, next);
    }, 900);
  }

  // 注册服务，供其他插件查询图像识别能力是否可用
  ctx.provide('image-recognition', {
    /** 本插件能否处理图片（始终 true，因为插件已加载） */
    available: true,
  });

  // ── 注册图片分析工具，供 agent 主动调用 ──

  /** 将本地文件路径转为 data URI */
  async function fileToDataUri(filePath: string): Promise<string> {
    const buf = await readFile(filePath);
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  /** 获取 vision LLM 提供者 */
  function getVisionLLM(): LLMService | null {
    const allProviders = ctx.getAllServices<LLMService>('llm');
    let chosen = allProviders.find(p => p.capabilities.includes('vision')) ?? allProviders[0];
    if (!chosen) return null;
    if (cfg.preferredModel && modelProviderMap) {
      const mappedProvider = modelProviderMap.get(cfg.preferredModel);
      if (mappedProvider) {
        const found = allProviders.find(p => p.contextId === mappedProvider);
        if (found) chosen = found;
      }
    }
    return chosen.instance;
  }

  ctx.registerTool({
    safety: 'safe',
    definition: {
      type: 'function',
      function: {
        name: 'analyze_image',
        description:
          '分析一张图片的内容，返回文字描述。\n' +
          '可以分析截图文件（如 screen_capture 返回的路径）、本地图片文件或网络图片 URL。\n' +
          '支持自定义提示词，例如：「提取图中所有文字」「描述 UI 布局」「找到按钮位置」等。',
        parameters: {
          type: 'object',
          properties: {
            image: {
              type: 'string',
              description: '图片来源：本地文件路径（如 workspace/.tmp/screenshots/xxx.png）或网络 URL',
            },
            prompt: {
              type: 'string',
              description: '分析提示词（可选）。不指定则使用默认描述提示。例如：「提取所有可见文字」「描述界面布局和按钮位置」',
            },
          },
          required: ['image'],
        },
      },
    },
    handler: async (args) => {
      try {
        const imageInput = args.image as string;
        const customPrompt = args.prompt as string | undefined;

        const visionLLM = getVisionLLM();
        if (!visionLLM) {
          return JSON.stringify({ error: '没有可用的视觉模型' });
        }

        // 判断输入类型：URL / data URI / 文件路径
        let imageUrl: string;
        if (imageInput.startsWith('http://') || imageInput.startsWith('https://') || imageInput.startsWith('data:')) {
          imageUrl = imageInput;
        } else {
          // 本地文件路径 → 转为 data URI
          const { resolve } = await import('node:path');
          const absPath = resolve(process.cwd(), imageInput);
          imageUrl = await fileToDataUri(absPath);
        }

        const prompt = customPrompt || cfg.prompt || DEFAULT_PROMPT;
        const messages: Message[] = [{ role: 'user', content: prompt, images: [imageUrl] }];

        const response = await visionLLM.chat({
          messages,
          maxTokens: cfg.maxTokens,
          model: cfg.preferredModel || undefined,
        });

        const description = response.content?.trim() || '无法识别图片内容';
        return JSON.stringify({ description });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  ctx.logger.info(`图像识别中间件已加载 (${cfg.enabled ? '启用' : '直通模式'})，analyze_image 工具已注册`);
}
