// ============================================================
// @aalis/plugin-draw — 让纯文本模型画图
//
// LLM 写标记（SVG 或 HTML+内联 CSS），本插件经离线渲染（@aalis/util-chromium 的 OfflineRenderer：
// 禁脚本、零网络、每次渲染全新上下文，见该包头注释；带不带 Chromium 沙箱看配置 sandbox）渲染成 PNG，或把声明式动画
// （CSS/SMIL）逐帧截图合成 GIF（draw_animation），落盘到本插件在会话媒体目录里的子目录
// data:/images/<会话目录>/draw/（@aalis/api-media 的目录约定，/clear 与删会话时由本插件清理）后由 send_attachment 投递进聊天。
// 标记是不可信输入；渲染请求里只有外壳文档一个资源（见 plan.renderRequest）。
//
// 格式分工（工具描述同步教给模型）：
//   图形/图标/梗图/动画 → SVG（viewBox 定界精确、声明式动画现成）
//   图文卡片/表格/海报 → HTML+内联 CSS（排版引擎管折行布局，可内嵌 SVG）
// ============================================================

import { Buffer } from 'node:buffer';
import { contributions } from '@aalis/api-contributions';
import { hooks } from '@aalis/api-hooks';
import { clearSessionMedia, sessionMediaUri } from '@aalis/api-media';
import type {} from '@aalis/api-memory'; // declaration merging：memory:clear 钩子与 memory:clear-type 贡献点类型
import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, lifecycle, logger, optional } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { textOf } from '@aalis/schema-i18n';
import { ChromiumLaunchError, OfflineRenderer, RenderUnavailableError } from '@aalis/util-chromium';
import { framesToGif } from './gif.js';
import { type DrawCaps, renderRequest, resolveCanvas } from './plan.js';
import { t } from './texts.js';

const configSchema = defineConfig({
  defaultWidth: {
    type: 'number',
    label: t('defaultWidthLabel'),
    default: 800,
    description: t('defaultWidthDescription'),
  },
  maxWidth: {
    type: 'number',
    label: t('maxWidthLabel'),
    default: 1600,
    description: t('maxWidthDescription'),
  },
  maxPixels: {
    type: 'number',
    label: t('maxPixelsLabel'),
    default: 4000000,
    description: t('maxPixelsDescription'),
  },
  maxSourceKB: {
    type: 'number',
    label: t('maxSourceKBLabel'),
    default: 256,
    description: t('maxSourceKBDescription'),
  },
  scale: {
    type: 'number',
    label: t('scaleLabel'),
    default: 2,
    description: t('scaleDescription'),
  },
  headless: {
    type: 'boolean',
    label: t('headlessLabel'),
    default: true,
    onInvalid: 'error',
    description: t('headlessDescription'),
  },
  executablePath: {
    type: 'string',
    label: t('executablePathLabel'),
    default: '',
    format: 'absolute-path',
    onInvalid: 'error',
    description: t('executablePathDescription'),
  },
  sandbox: {
    type: 'boolean',
    label: t('sandboxLabel'),
    default: false,
    onInvalid: 'error',
    description: t('sandboxDescription'),
  },
  idleShutdownSec: {
    type: 'number',
    label: t('idleShutdownSecLabel'),
    default: 300,
    description: t('idleShutdownSecDescription'),
  },
  maxConcurrency: {
    type: 'number',
    label: t('maxConcurrencyLabel'),
    default: 2,
    description: t('maxConcurrencyDescription'),
  },
  animMaxDurationSec: {
    type: 'number',
    label: t('animMaxDurationSecLabel'),
    default: 8,
    description: t('animMaxDurationSecDescription'),
  },
  animDefaultFps: {
    type: 'number',
    label: t('animDefaultFpsLabel'),
    default: 15,
    description: t('animDefaultFpsDescription'),
  },
  animMaxFrames: {
    type: 'number',
    label: t('animMaxFramesLabel'),
    default: 160,
    description: t('animMaxFramesDescription'),
  },
  animMaxOutputMB: {
    type: 'number',
    label: t('animMaxOutputMBLabel'),
    default: 9,
    description: t('animMaxOutputMBDescription'),
  },
});

interface DrawConfig extends DrawCaps {
  headless: boolean;
  executablePath: string;
  sandbox: boolean;
  idleShutdownSec: number;
  maxConcurrency: number;
  animMaxDurationSec: number;
  animDefaultFps: number;
  animMaxFrames: number;
  animMaxOutputMB: number;
}

function resolveConfig(raw: ConfigOf<typeof configSchema>): DrawConfig {
  const num = (value: number, fallback: number, lo: number, hi: number): number =>
    value >= lo ? Math.min(hi, Math.floor(value)) : fallback;
  return {
    defaultWidth: num(raw.defaultWidth, configSchema.defaultWidth.default, 16, 4096),
    maxWidth: num(raw.maxWidth, configSchema.maxWidth.default, 16, 4096),
    maxPixels: num(raw.maxPixels, configSchema.maxPixels.default, 65536, 16_000_000),
    maxSourceBytes: num(raw.maxSourceKB, configSchema.maxSourceKB.default, 1, 4096) * 1024,
    scale: num(raw.scale, configSchema.scale.default, 1, 3),
    headless: raw.headless,
    executablePath: raw.executablePath,
    sandbox: raw.sandbox,
    idleShutdownSec: num(raw.idleShutdownSec, configSchema.idleShutdownSec.default, 0, 86400),
    maxConcurrency: num(raw.maxConcurrency, configSchema.maxConcurrency.default, 1, 8),
    animMaxDurationSec: num(raw.animMaxDurationSec, configSchema.animMaxDurationSec.default, 1, 30),
    animDefaultFps: num(raw.animDefaultFps, configSchema.animDefaultFps.default, 1, 25),
    animMaxFrames: num(raw.animMaxFrames, configSchema.animMaxFrames.default, 2, 600),
    animMaxOutputMB: num(raw.animMaxOutputMB, configSchema.animMaxOutputMB.default, 1, 9),
  };
}

/** PNG 的 IHDR 在第 16–24 字节（宽、高，大端）；按缩放倍率折回 CSS 像素。 */
function cssSize(png: Uint8Array, scale: number): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: Math.round(view.getUint32(16) / scale), height: Math.round(view.getUint32(20) / scale) };
}

/** 本插件在会话媒体目录里的子目录名（写入方） */
const MEDIA_WRITER = 'draw';

// 四项服务都是 optional：缺 tools、hooks 时登记排队，缺 storage/process 时落盘与编码在调用点报错、清理不出回执，
// 插件本身照常激活（离线渲染不依赖它们启动）。
const uses = {
  tools: optional(tools),
  storage: optional(storage),
  processService: optional(processService),
  hooks: optional(hooks),
  /** 登记 /clear 的 image 类型 */
  contributions: optional(contributions),
  logger,
  lifecycle,
  config,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-draw',
  displayName: t('displayName'),
  subsystem: 'tools',
  configSchema,
  uses,
  apply: registerDraw,
});

function registerDraw(caps: Caps): void {
  const cfg = resolveConfig(parseConfig(configSchema, caps.config.use, caps.logger.use));
  const logger = caps.logger.use.child('draw');
  const storage = caps.storage.use;
  const proc = caps.processService.use;
  const { tools } = caps;

  const renderer = new OfflineRenderer({
    sandbox: cfg.sandbox,
    headless: cfg.headless,
    executablePath: cfg.executablePath || undefined,
    maxConcurrency: cfg.maxConcurrency,
    idleShutdownSec: cfg.idleShutdownSec,
    stepTimeoutMs: 15_000,
    logger,
  });
  caps.lifecycle.use.onDispose(() => renderer.dispose());

  /** 工具报错的说明；带沙箱时 Chromium 本身启动失败，接上修法 */
  const failureText = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    return cfg.sandbox && err instanceof RenderUnavailableError && err.cause instanceof ChromiumLaunchError
      ? `${message}。若是沙箱不可用（如 Linux 上以 root 运行、容器里），可在绘图的配置里关掉「Chromium 沙箱」（sandbox）`
      : message;
  };

  // 参与 memory:clear（/clear 与删除会话）：所选类型含 image 时清本插件在会话媒体目录里的子目录，会话级清这个会话的、
  // 全局清各会话的；存储不在时不清、不出回执。登记 image 类型，/clear -t 才选得中（别的写入方也登记它，帮助里只列一次）
  caps.contributions.use.contribute('memory:clear-type', { id: 'image', label: t('clearType') });
  caps.hooks.use.middleware('memory:clear', async (data, next) => {
    const sessionId = data.scope === 'all' ? undefined : data.sessionId;
    if (caps.storage.present && (data.scope === 'all' || sessionId) && (!data.types || data.types.includes('image'))) {
      const line = { source: 'draw', type: 'image' };
      try {
        const count = await clearSessionMedia(caps.storage.use, 'image', MEDIA_WRITER, sessionId);
        data.results.push({ ...line, success: true, message: t('cleared', { count }) });
      } catch (err) {
        data.results.push({ ...line, success: false, message: t('clearFailed', { error: textOf(err) }) });
      }
    }
    await next();
  });

  tools.use.registerGroup({
    name: 'draw',
    label: t('displayName'),
    summary: t('groupSummary'),
    description: '把模型编写的 SVG/HTML 标记渲染为图片，配合 send_attachment 发进聊天',
  });

  tools.use.register({
    // 刻意 public：绘图是人人可要求的能力（用户产品决定）——群里谁都能让 bot 画图。
    // 抗滥用不靠权限档而靠资源治理：单次成本被 maxPixels/maxFrames/体积封顶，
    // 跨会话并发由引擎信号量排队（不拒绝、只削峰），机器不会被刷图打垮。
    groups: ['draw'],
    // 排队与渲染可能很久：等多久由执行器的让出时限管，停只认执行器给这次调用的中止信号
    background: {},
    definition: {
      type: 'function',
      function: {
        name: 'draw_image',
        description:
          '把你编写的 SVG 或 HTML 标记渲染成 PNG 图片，落盘后返回 storage_uri（用 send_attachment 的 storage_uri 参数发送到聊天）。\n' +
          '**选型**：图形/图标/梗图/示意图 → 写完整 SVG 文档（**必须带 viewBox**，建议同时带 width/height）；' +
          '图文卡片/表格/排版类 → 写 HTML 片段+内联 CSS（可内嵌 SVG 图形；不要写 <html>/<body> 外壳）。\n' +
          '**硬约束**：渲染页禁用脚本且拦截全部网络请求——<script> 不会执行，外链图片/字体/CSS 一律加载失败，' +
          '资源只能内联（data: URI）；中文与 emoji 直接可用（系统字体栈兜底）。' +
          '画布定界：SVG 按 viewBox/width 精确定界；HTML 按 width 参数定宽、内容自动量高。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'SVG 文档或 HTML 片段' },
            width: { type: 'number', description: '画布宽 px（可选；SVG 自带尺寸时按比例覆盖，HTML 默认 800）' },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      try {
        const dir = sessionMediaUri('image', callCtx.sessionId, MEDIA_WRITER);
        const source = String(args.source ?? '');
        if (!source.trim()) return JSON.stringify({ error: 'source 为空' });
        if (Buffer.byteLength(source) > cfg.maxSourceBytes) {
          return JSON.stringify({ error: `source 超过大小上限 ${Math.floor(cfg.maxSourceBytes / 1024)}KB` });
        }
        // 按 scale² 折算：resolveCanvas 收的是 CSS 像素，但真实光栅 = CSS 像素 × scale²，
        // 用折算后的 CSS 像素预算让设备像素峰值不超过 maxPixels 的既定内存含义
        const cssPixelBudget = Math.floor(cfg.maxPixels / (cfg.scale * cfg.scale));
        const plan = resolveCanvas(source, args.width as number | undefined, { ...cfg, maxPixels: cssPixelBudget });
        const png = Buffer.from(
          await renderer.renderPng(renderRequest(plan, cfg.scale, cssPixelBudget, callCtx.signal)),
        );
        const { width, height } = cssSize(png, cfg.scale);

        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(png));
        const hash = Buffer.from(digest).toString('hex').slice(0, 16);
        const uri = `${dir}/draw-${hash}.png`;
        await storage.writeFile(uri, png);
        logger.info(`draw_image 渲染完成 mode=${plan.mode} ${width}x${height}@${cfg.scale}x → ${uri}`);
        return JSON.stringify({
          uri,
          width,
          height,
          mode: plan.mode,
          message: '已渲染并落盘。用 send_attachment({ kind: "image", storage_uri: uri }) 发送到聊天。',
        });
      } catch (err) {
        const message = failureText(err);
        logger.warn(`draw_image 失败: ${message}`);
        return JSON.stringify({ error: message });
      }
    },
  });

  tools.use.register({
    // public 同 draw_image：人人可画，抗滥用靠资源治理不靠权限档。
    groups: ['draw'],
    background: {},
    definition: {
      type: 'function',
      function: {
        name: 'draw_animation',
        description:
          '把你编写的带动画的 SVG/HTML 标记渲染成 GIF 动图，落盘后返回 storage_uri（用 send_attachment 发送）。\n' +
          '**动画只能用声明式**：SVG 用 SMIL（<animate>/<animateTransform>/<animateMotion>）或 CSS ' +
          '@keyframes；脚本驱动的动画不会生效（渲染页禁用 JS）。建议动画时长 2-5 秒，GIF 默认无限循环播放。\n' +
          '渲染成功即可**直接 send_attachment 发送**，不需要额外核对。结果里的 check_frames（首帧/中帧）' +
          '仅在你对形态没把握、且有看图工具可用时可选地看一眼——但视觉识别较慢，通常无必要，别默认核对；' +
          '即便核对，核对失败或超时也**不影响发送，直接发 GIF**，不要因核对不成而放弃发送。\n' +
          '选型与硬约束同 draw_image：图形动画写 SVG（必须带 viewBox）；外链资源一律被拦，只能内联。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '带 SMIL/CSS 动画的 SVG 文档或 HTML 片段' },
            width: { type: 'number', description: '画布宽 px（可选，动图建议 ≤600 控制体积）' },
            duration_seconds: { type: 'number', description: '动画时长秒（可选；缺省自动探测声明时长）' },
            fps: { type: 'number', description: '帧率（可选，默认 15，上限 25）' },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      try {
        const dir = sessionMediaUri('image', callCtx.sessionId, MEDIA_WRITER);
        const source = String(args.source ?? '');
        if (!source.trim()) return JSON.stringify({ error: 'source 为空' });
        if (Buffer.byteLength(source) > cfg.maxSourceBytes) {
          return JSON.stringify({ error: `source 超过大小上限 ${Math.floor(cfg.maxSourceBytes / 1024)}KB` });
        }
        const plan = resolveCanvas(source, args.width as number | undefined, cfg);
        const reqDur = Number(args.duration_seconds);
        const reqFps = Number(args.fps);
        const fps = Number.isFinite(reqFps) && reqFps > 0 ? Math.min(Math.floor(reqFps), 25) : cfg.animDefaultFps;

        // 动图按 1x：帧数×像素才是体积主宰，清晰度靠画布宽
        const r = await renderer.renderFrames(renderRequest(plan, 1, cfg.maxPixels, callCtx.signal), {
          fps,
          durationMs: Number.isFinite(reqDur) && reqDur > 0 ? Math.round(reqDur * 1000) : undefined,
          defaultDurationMs: 3000,
          maxDurationMs: cfg.animMaxDurationSec * 1000,
          maxFrames: cfg.animMaxFrames,
        });
        const frames = r.frames.map(f => Buffer.from(f));
        const { width, height } = cssSize(frames[0], 1);

        const gif = await framesToGif(proc, storage, frames, fps, callCtx.signal);
        if (gif.byteLength > cfg.animMaxOutputMB * 1024 * 1024) {
          return JSON.stringify({
            error:
              `GIF ${(gif.byteLength / 1048576).toFixed(1)}MB 超过上限 ${cfg.animMaxOutputMB}MB——` +
              '请缩小画布宽、降低 fps 或缩短时长后重试',
          });
        }

        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(gif));
        const hash = Buffer.from(digest).toString('hex').slice(0, 16);
        const uri = `${dir}/draw-${hash}.gif`;
        await storage.writeFile(uri, gif);
        // 检查帧：首帧+中帧落盘，供 agent 在没把握时**可选**用 analyze_image 核对——
        // 不是默认路径。本地视觉推理慢（33b 单张可达数分钟），默认自检会把 2 秒的动图
        // 拖成几分钟、还挤占入站识别的产能（实测已踩），故降级为提示、由模型按需取用。
        const midIdx = Math.floor(frames.length / 2);
        const checkFrames: string[] = [];
        for (const [tag, idx] of [
          ['f0', 0],
          ['fmid', midIdx],
        ] as const) {
          const fUri = `${dir}/draw-${hash}-${tag}.png`;
          await storage.writeFile(fUri, frames[idx]);
          checkFrames.push(fUri);
        }
        logger.info(
          `draw_animation 渲染完成 mode=${plan.mode} ${width}x${height} ${frames.length}帧@${fps}fps ` +
            `${(gif.byteLength / 1024).toFixed(0)}KB anims=${r.animationCount} → ${uri}`,
        );
        const warnings =
          r.animationCount === 0
            ? ['未检测到任何声明式动画——产物是静态画面的重复帧。动画请用 SMIL 或 CSS @keyframes。']
            : [];
        return JSON.stringify({
          uri,
          width,
          height,
          frames: frames.length,
          fps,
          duration_seconds: r.durationMs / 1000,
          size_kb: Math.round(gif.byteLength / 1024),
          check_frames: checkFrames,
          ...(warnings.length > 0 ? { warnings } : {}),
          message:
            '已渲染并落盘，可直接用 send_attachment({ kind: "image", storage_uri: uri }) 发送到聊天。' +
            'check_frames 仅供没把握时可选核对（视觉识别较慢，通常无需核对）。',
        });
      } catch (err) {
        const message = failureText(err);
        logger.warn(`draw_animation 失败: ${message}`);
        return JSON.stringify({ error: message });
      }
    },
  });
}
