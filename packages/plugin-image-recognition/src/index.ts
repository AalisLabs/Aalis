import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { promisify } from 'node:util';
import type { Context, ConfigSchema, IncomingMessage, Message, AgentService } from '@aalis/core';
import type { LLMService, MemoryService } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-image-recognition';
export const displayName = '图像识别';
export const provides = ['image-recognition'];
export const inject = {
  optional: ['llm', 'agent', 'memory'],
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
  gifMaxFrames: {
    type: 'number',
    label: 'GIF/视频最大提取帧数',
    default: 5,
    description: '对 GIF 或视频文件最多提取多少帧进行识别（首尾+均匀分布）。',
  },
  gifDescriptionMode: {
    type: 'select',
    label: 'GIF/视频描述模式',
    options: [
      { label: '所有帧一次性发给模型（推荐）', value: 'combined' },
      { label: '逐帧描述后拼接', value: 'separate' },
    ],
    default: 'combined',
    description: 'combined: 将所有帧作为多张图片一次发给 LLM，由模型写综合描述；separate: 每帧单独描述后拼接。',
  },
};

export const defaultConfig = {
  enabled: true,
  maxTokens: 300,
  gifMaxFrames: 5,
  gifDescriptionMode: 'combined',
};

// ===== 配置接口 =====

interface ImageRecognitionConfig {
  preferredModel: string;
  enabled: boolean;
  maxTokens: number;
  prompt: string;
  gifMaxFrames: number;
  gifDescriptionMode: 'combined' | 'separate';
}

interface ImageProcessResult {
  content: string;
  imageDescriptions?: string[];
  info: {
    imageCount: number;
    successCount: number;
    descriptions: string[];
    transformedContent: string;
  };
}

const DEFAULT_PROMPT = '请简洁地描述这张图片的内容，包括画面中的主要元素、文字（如果有）、表情包含义等。用中文回答，控制在100字以内。';

const DEFAULT_ANIMATED_PROMPT = '以下是一个动图/视频的多帧截图（按时间顺序排列）。请综合所有帧描述这个动图/视频的内容，包括动态变化、主要元素和表情包含义等。用中文回答，控制在150字以内。';

const execFileAsync = promisify(execFile);

/** 动图/视频格式 */
const ANIMATED_EXTS = new Set(['.gif', '.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.m4v']);

/** 判断是否为动图/视频格式（基于扩展名） */
function isAnimatedFormat(pathOrUrl: string): boolean {
  // 从 URL 或路径中提取扩展名（去掉查询参数）
  const clean = pathOrUrl.split('?')[0].split('#')[0];
  const ext = extname(clean).toLowerCase();
  return ANIMATED_EXTS.has(ext);
}

/** 检测 ffmpeg 是否可用 */
let ffmpegAvailable: boolean | null = null;
async function checkFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/** 按需加载 sharp，避免将其作为硬依赖。未安装时返回 null。 */
async function loadSharp(): Promise<any | null> {
  try {
    const importer = new Function('specifier', 'return import(specifier);') as (
      specifier: string,
    ) => Promise<{ default?: any }>;
    const mod = await importer('sharp');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/**
 * 选择要提取的帧索引（0-based）。
 * 策略：首帧 + 尾帧 + 中间均匀分布。
 * - totalFrames=1 → [0]
 * - totalFrames <= maxFrames → [0, 1, ..., totalFrames-1]
 * - totalFrames > maxFrames → 首尾 + 均匀分布
 */
function selectFrameIndices(totalFrames: number, maxFrames: number): number[] {
  if (totalFrames <= 0) return [];
  if (totalFrames === 1) return [0];
  if (totalFrames <= maxFrames) return Array.from({ length: totalFrames }, (_, i) => i);

  const indices: number[] = [0]; // 首帧
  const innerCount = maxFrames - 2; // 去掉首尾
  for (let i = 1; i <= innerCount; i++) {
    indices.push(Math.round((i * (totalFrames - 1)) / (maxFrames - 1)));
  }
  indices.push(totalFrames - 1); // 尾帧
  return [...new Set(indices)].sort((a, b) => a - b);
}

/**
 * 使用 ffmpeg 获取视频/GIF 总帧数
 */
async function getFrameCount(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'csv=p=0',
      filePath,
    ], { timeout: 30000 });
    const n = parseInt(stdout.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/**
 * 使用 ffmpeg 提取指定帧为 PNG。返回 data URI 数组。
 * 框架：先导出所有帧到临时目录，再挑选目标帧。
 * 优化：对于少量帧使用 select filter 精确提取。
 */
async function extractFramesWithFfmpeg(
  filePath: string,
  frameIndices: number[],
): Promise<string[]> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'aalis-frames-'));
  try {
    // 构建 select filter：只提取需要的帧
    const selectExpr = frameIndices.map(i => `eq(n\\,${i})`).join('+');
    await execFileAsync('ffmpeg', [
      '-i', filePath,
      '-vf', `select='${selectExpr}'`,
      '-vsync', 'vfr',
      '-f', 'image2',
      '-y',
      join(tmpDir, 'frame_%04d.png'),
    ], { timeout: 60000 });

    // 按顺序读取提取出的帧
    const results: string[] = [];
    for (let i = 1; i <= frameIndices.length; i++) {
      const framePath = join(tmpDir, `frame_${String(i).padStart(4, '0')}.png`);
      try {
        const buf = await readFile(framePath);
        results.push(`data:image/png;base64,${buf.toString('base64')}`);
      } catch {
        // 该帧可能不存在（如总帧数不够）
      }
    }
    return results;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 使用 sharp 提取 GIF 帧（ffmpeg 不可用时的 fallback）。
 * 返回 data URI 数组。如果 sharp 不可用则返回 null。
 */
async function extractFramesWithSharp(
  filePath: string,
  frameIndices: number[],
): Promise<string[] | null> {
  try {
    const sharp = await loadSharp();
    if (!sharp) return null;
    const buf = await readFile(filePath);
    const metadata = await sharp(buf, { animated: true }).metadata();
    const pageCount = metadata.pages ?? 1;
    if (pageCount <= 1) return null; // 非动图

    const results: string[] = [];
    for (const idx of frameIndices) {
      if (idx >= pageCount) continue;
      const frameBuf = await sharp(buf, { page: idx }).png().toBuffer();
      results.push(`data:image/png;base64,${frameBuf.toString('base64')}`);
    }
    return results;
  } catch {
    return null;
  }
}

/**
 * 从本地文件提取帧。优先 ffmpeg，GIF 可 fallback 到 sharp。
 * 返回 data URI 数组。空数组表示无法提取或非动图。
 */
async function extractFrames(
  filePath: string,
  maxFrames: number,
  logger: Context['logger'],
): Promise<string[]> {
  const hasFfmpeg = await checkFfmpeg();
  const ext = extname(filePath).toLowerCase();

  if (hasFfmpeg) {
    try {
      const totalFrames = await getFrameCount(filePath);
      if (totalFrames <= 1) return []; // 只有一帧，按普通图片处理

      const indices = selectFrameIndices(totalFrames, maxFrames);
      logger.debug(`帧提取 (ffmpeg): ${filePath}, 总帧数=${totalFrames}, 提取=${indices.length}`);
      const frames = await extractFramesWithFfmpeg(filePath, indices);
      if (frames.length > 0) return frames;
    } catch (err) {
      logger.debug(`ffmpeg 帧提取失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Fallback: sharp（仅 GIF）
  if (ext === '.gif') {
    try {
      // 先尝试用 sharp 获取帧数
      const sharp = await loadSharp();
      if (!sharp) return [];
      const buf = await readFile(filePath);
      const metadata = await sharp(buf, { animated: true }).metadata();
      const pageCount = metadata.pages ?? 1;
      if (pageCount <= 1) return [];

      const indices = selectFrameIndices(pageCount, maxFrames);
      logger.debug(`帧提取 (sharp): ${filePath}, 总帧数=${pageCount}, 提取=${indices.length}`);
      const frames = await extractFramesWithSharp(filePath, indices);
      return frames ?? [];
    } catch (err) {
      logger.debug(`sharp 帧提取失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!hasFfmpeg) {
    logger.warn(`无法提取帧: ffmpeg 未安装${ext !== '.gif' ? '（非 GIF 格式需要 ffmpeg）' : '，sharp 也不可用'}`);
  }
  return [];
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: ImageRecognitionConfig = {
    preferredModel: (config.preferredModel as string) || '',
    enabled: (config.enabled as boolean) ?? true,
    maxTokens: (config.maxTokens as number) ?? 300,
    prompt: (config.prompt as string) || '',
    gifMaxFrames: Math.max(1, (config.gifMaxFrames as number) ?? 5),
    gifDescriptionMode: (config.gifDescriptionMode as 'combined' | 'separate') || 'combined',
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

  /** 通过 LLM 服务识别单张静态图片 */
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
        think: false,
      });
      return response.content?.trim() || '[图片: 无描述]';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`图像识别失败: ${msg}`);
      return '[图片: 识别失败]';
    }
  }

  /**
   * 识别动图/视频：从本地文件提取帧后发给 LLM。
   * 如果帧提取失败，回退到取第一帧识别。
   */
  async function describeAnimated(
    visionLLM: LLMService,
    localPath: string,
  ): Promise<string> {
    const absPath = resolve(process.cwd(), localPath);
    const frames = await extractFrames(absPath, cfg.gifMaxFrames, ctx.logger);

    if (frames.length === 0) {
      // 提取失败或仅 1 帧 → 尝试用 ffmpeg 转单帧 PNG
      ctx.logger.debug(`动图帧提取为空，尝试提取首帧: ${localPath}`);
      const firstFrame = await extractSingleFrame(absPath);
      if (firstFrame) {
        return describeImage(visionLLM, firstFrame);
      }
      return '[图片: 动图识别失败（无法提取帧）]';
    }

    ctx.logger.debug(`动图帧提取成功: ${frames.length}/${cfg.gifMaxFrames} 帧, 模式=${cfg.gifDescriptionMode}`);

    if (cfg.gifDescriptionMode === 'separate') {
      // 逐帧描述
      const descs = await Promise.all(
        frames.map(async (frame, i) => {
          const desc = await describeImage(visionLLM, frame);
          return `第${i + 1}帧: ${desc}`;
        }),
      );
      return descs.join('\n');
    }

    // combined 模式：所有帧一次性发给 LLM
    const prompt = cfg.prompt || DEFAULT_ANIMATED_PROMPT;
    const messages: Message[] = [
      {
        role: 'user',
        content: prompt,
        images: frames,
      },
    ];

    try {
      const response = await visionLLM.chat({
        messages,
        maxTokens: cfg.maxTokens,
        model: cfg.preferredModel || undefined,
        think: false,
      });
      return response.content?.trim() || '[动图: 无描述]';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`动图识别失败 (combined): ${msg}`);
      return '[动图: 识别失败]';
    }
  }

  /** 使用 ffmpeg 提取视频/GIF 首帧为 data URI。失败返回 null */
  async function extractSingleFrame(filePath: string): Promise<string | null> {
    const hasFfmpeg = await checkFfmpeg();
    if (!hasFfmpeg) return null;
    const tmpDir = await mkdtemp(join(tmpdir(), 'aalis-frame-'));
    try {
      const outPath = join(tmpDir, 'frame.png');
      await execFileAsync('ffmpeg', [
        '-i', filePath, '-vframes', '1', '-f', 'image2', '-y', outPath,
      ], { timeout: 30000 });
      const buf = await readFile(outPath);
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      return null;
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 统一入口：根据输入自动判断是静态图还是动图/视频。
   * - localRefPath 是本地缓存路径（data/images/...），有的话用于帧提取
   * - imageUrl 是原始 URL 或 data URI
   */
  async function describeAny(
    visionLLM: LLMService,
    imageUrl: string,
    localRefPath?: string,
  ): Promise<string> {
    // 判断是否动图/视频
    const checkPath = localRefPath || imageUrl;
    if (isAnimatedFormat(checkPath) && localRefPath) {
      return describeAnimated(visionLLM, localRefPath);
    }
    // 有本地文件但没有 ref 的动图场景（如 URL 是 .gif）
    if (isAnimatedFormat(imageUrl) && !localRefPath) {
      // 临时下载到本地再提取帧
      const tmpFile = await downloadToTemp(imageUrl);
      if (tmpFile) {
        try {
          return await describeAnimated(visionLLM, tmpFile);
        } finally {
          await rm(tmpFile, { force: true }).catch(() => {});
        }
      }
    }
    return describeImage(visionLLM, imageUrl);
  }

  function toEffectiveDescription(raw: string): string {
    if (!raw) return '';
    if (raw.startsWith('[图片:') || raw.startsWith('[动图:')) return '';
    return raw;
  }

  function extractRefPaths(content: string): string[] {
    const refPaths: string[] = [];
    const refRegex = /\[图片 \| ref:([^\]]+)\]/g;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refRegex.exec(content)) !== null) {
      refPaths.push(refMatch[1]);
    }
    return refPaths;
  }

  async function processImageMessage(
    visionLLM: LLMService,
    input: { content: string; images: string[]; attachmentOrder?: Array<'image' | 'file'> },
  ): Promise<ImageProcessResult> {
    const refPaths = extractRefPaths(input.content);
    const rawDescriptions = await Promise.all(
      input.images.map((img, i) => describeAny(visionLLM, img, refPaths[i])),
    );
    const descriptions = rawDescriptions.map(toEffectiveDescription);

    let content = input.content;
    let imageDescriptions: string[] | undefined;

    if (/\[图片 \| ref:[^\]]+\]/.test(content)) {
      let idx = 0;
      content = content.replace(/\[图片 \| ref:([^\]]+)\]/g, (_match, refPath: string) => {
        const desc = descriptions[idx++];
        return desc ? `[图片: ${desc} | ref:${refPath}]` : `[图片 | ref:${refPath}]`;
      });
    } else {
      const descTexts = descriptions.map((desc, i) => `[图片${input.images.length > 1 ? (i + 1) : ''}: ${desc || '无描述'}]`);
      imageDescriptions = descTexts;

      if (!input.attachmentOrder) {
        const descText = descTexts.join('\n');
        content = content ? `${content}\n${descText}` : descText;
      }
    }

    return {
      content,
      imageDescriptions,
      info: {
        imageCount: input.images.length,
        successCount: descriptions.filter(Boolean).length,
        descriptions,
        transformedContent: content,
      },
    };
  }

  /** 下载 URL 到临时文件，返回路径。失败返回 null */
  async function downloadToTemp(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const ext = extname(url.split('?')[0]).toLowerCase() || '.gif';
      const tmpDir = await mkdtemp(join(tmpdir(), 'aalis-dl-'));
      const outPath = join(tmpDir, `file${ext}`);
      await writeFile(outPath, buf);
      return outPath;
    } catch {
      return null;
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

    const result = await processImageMessage(visionLLM, {
      content: msg.content,
      images: msg.images,
      attachmentOrder: msg.attachmentOrder,
    });

    msg.content = result.content;
    msg._imageDescriptions = result.imageDescriptions;
    msg._imageRecognitionInfo = result.info;

    // 清除 images，表示已由中间件消费（不再传递给多模态 LLM）
    msg.images = undefined;

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

  // 注册服务，供其他插件查询图像识别能力和调用描述功能
  ctx.provide('image-recognition', {
    /** 本插件能否处理图片（始终 true，因为插件已加载） */
    available: true,
    /**
     * 描述图片（静态或动图/视频），返回文字描述。失败返回空串。
     * @param imageUrl 原始图片 URL 或 data URI
     * @param localRefPath 可选，本地缓存文件路径（用于动图帧提取）
     */
    async describe(imageUrl: string, localRefPath?: string): Promise<string> {
      const visionLLM = getVisionLLM();
      if (!visionLLM) return '';
      const result = await describeAny(visionLLM, imageUrl, localRefPath);
      // 过滤掉失败/无描述的占位符，只返回真正有效的描述
      if (result.startsWith('[图片:') || result.startsWith('[动图:') || result === '') return '';
      return result;
    },
    async processMessage(input: { content: string; images: string[]; attachmentOrder?: Array<'image' | 'file'> }): Promise<ImageProcessResult | null> {
      const visionLLM = getVisionLLM();
      if (!visionLLM || !cfg.enabled || input.images.length === 0) return null;
      return processImageMessage(visionLLM, input);
    },
    /** 当前中间件是否启用（启用=由本插件识别，关闭=传给主模型） */
    enabled: cfg.enabled,
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
        let localPath: string | undefined;
        if (imageInput.startsWith('http://') || imageInput.startsWith('https://') || imageInput.startsWith('data:')) {
          imageUrl = imageInput;
        } else {
          // 本地文件路径
          localPath = resolve(process.cwd(), imageInput);
          imageUrl = await fileToDataUri(localPath);
        }

        // 动图/视频：使用帧提取流程
        if (isAnimatedFormat(localPath || imageUrl)) {
          const desc = await describeAny(visionLLM, imageUrl, localPath ?? imageInput);
          return JSON.stringify({ description: desc || '无法识别图片内容' });
        }

        const prompt = customPrompt || cfg.prompt || DEFAULT_PROMPT;
        const messages: Message[] = [{ role: 'user', content: prompt, images: [imageUrl] }];

        const response = await visionLLM.chat({
          messages,
          maxTokens: cfg.maxTokens,
          model: cfg.preferredModel || undefined,
          think: false,
        });

        const description = response.content?.trim() || '无法识别图片内容';
        return JSON.stringify({ description });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── 注册图片描述回写工具 ──

  ctx.registerTool({
    safety: 'safe',
    definition: {
      type: 'function',
      function: {
        name: 'update_image_description',
        description:
          '更新历史消息中图片的描述。当你通过 analyze_image 识别了一张历史图片后，' +
          '调用此工具将描述写回数据库，以便未来检索。',
        parameters: {
          type: 'object',
          properties: {
            image_ref: {
              type: 'string',
              description: '图片引用路径（ref: 后面的部分），如 data/images/onebot_xxx/abc123.jpg',
            },
            description: {
              type: 'string',
              description: '图片描述文字',
            },
            session_id: {
              type: 'string',
              description: '图片所在的会话 ID',
            },
          },
          required: ['image_ref', 'description', 'session_id'],
        },
      },
    },
    handler: async (args) => {
      const imageRef = String(args.image_ref);
      const desc = String(args.description);
      const sessionId = String(args.session_id);

      const memory = ctx.getService<MemoryService>('memory');
      if (!memory?.updateMessageContent) {
        return JSON.stringify({ error: '记忆服务不可用或不支持内容更新' });
      }

      const oldText = `[图片 | ref:${imageRef}]`;
      const newText = `[图片: ${desc} | ref:${imageRef}]`;
      const updated = await memory.updateMessageContent(sessionId, oldText, newText);
      return updated > 0
        ? `已更新 ${updated} 条消息中的图片描述`
        : '未找到匹配的图片引用（可能已有描述或引用路径不匹配）';
    },
  });

  ctx.logger.info(`图像识别中间件已加载 (${cfg.enabled ? '启用' : '直通模式'})，analyze_image / update_image_description 工具已注册`);
}
