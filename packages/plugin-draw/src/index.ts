// ============================================================
// @aalis/plugin-draw — 让纯文本模型画图
//
// LLM 写标记（SVG 或 HTML+内联 CSS），本插件用硬化的无头浏览器渲染成
// PNG（后续：CSS/SMIL 动画 → 逐帧 → GIF），落盘 data:/images/ 后由
// send_attachment 投递进聊天。引擎与安全设计见 engine.ts 头注。
//
// 格式分工（工具描述同步教给模型）：
//   图形/图标/梗图/动画 → SVG（viewBox 定界精确、声明式动画现成）
//   图文卡片/表格/海报 → HTML+内联 CSS（排版引擎管折行布局，可内嵌 SVG）
// ============================================================

import { Buffer } from 'node:buffer';
import { createProcessGateway } from '@aalis/api-process';
import { createStorageGateway } from '@aalis/api-storage';
import { useToolService } from '@aalis/api-tools';
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { DrawEngine } from './engine.js';
import { framesToGif } from './gif.js';
import { type DrawCaps, lintAnimationSource, resolveCanvas } from './plan.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-draw';
export const displayName = '绘图';
export const subsystem = 'tools';
export const inject = { optional: ['tools', 'storage', 'process'] };

export const configSchema: ConfigSchema = {
  defaultWidth: {
    type: 'number',
    label: '默认画布宽 (px)',
    default: 800,
    description: 'HTML 模式与未声明宽度的 SVG 使用的画布宽度',
  },
  maxWidth: {
    type: 'number',
    label: '画布宽上限 (px)',
    default: 1600,
    description: '请求宽与标记声明宽都会被收口到该值',
  },
  maxPixels: {
    type: 'number',
    label: '画布 CSS 像素上限',
    default: 4000000,
    description:
      'width×height（CSS 像素）上限，默认 4MP。注意实际光栅内存 = 本值 × scale²（scale 默认 2 即 4 倍）；' +
      '静态图按 scale 截图，故设备像素天花板是本值的 scale² 倍——调高前算好内存',
  },
  maxSourceKB: {
    type: 'number',
    label: '输入标记上限 (KB)',
    default: 256,
    description: 'source 参数的大小上限',
  },
  scale: {
    type: 'number',
    label: '截图缩放倍率',
    default: 2,
    description: 'deviceScaleFactor：2 = 视网膜清晰度（像素翻倍，文件更大）',
  },
  headless: {
    type: 'boolean',
    label: '无头模式',
    default: true,
    description: '调试时可关闭以观察渲染页面',
  },
  executablePath: {
    type: 'string',
    label: 'Chrome 路径（留空自动探测）',
    default: '',
    description: '留空使用 puppeteer 缓存的 Chrome（与浏览器工具共用同一份二进制，进程独立）',
  },
  idleShutdownSec: {
    type: 'number',
    label: '空闲关停 (秒)',
    default: 300,
    description: '渲染引擎空闲该时长后关停 Chromium 释放内存；0 = 常驻',
  },
  maxConcurrency: {
    type: 'number',
    label: '渲染并发上限',
    default: 2,
    description: '同时进行的渲染任务数上限；群内多人并发画图时超出的排队，防无界 page + ffmpeg 拖垮机器',
  },
  animMaxDurationSec: {
    type: 'number',
    label: '动图时长上限 (秒)',
    default: 8,
    description: 'draw_animation 的动画时长硬上限',
  },
  animDefaultFps: {
    type: 'number',
    label: '动图默认帧率',
    default: 15,
    description: '未显式指定 fps 时使用；上限 25',
  },
  animMaxFrames: {
    type: 'number',
    label: '动图帧数上限',
    default: 160,
    description: '时长×帧率超出时按帧数反推有效时长',
  },
  animMaxOutputMB: {
    type: 'number',
    label: 'GIF 体积上限 (MB)',
    default: 9,
    description: '超出即报错（OneBot 内联投递上限 10MB，留余量）',
  },
};

interface DrawConfig extends DrawCaps {
  headless: boolean;
  executablePath: string;
  idleShutdownSec: number;
  maxConcurrency: number;
  animMaxDurationSec: number;
  animDefaultFps: number;
  animMaxFrames: number;
  animMaxOutputMB: number;
}

function resolveConfig(config: Record<string, unknown>): DrawConfig {
  const num = (v: unknown, dflt: number, lo: number, hi: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo ? Math.min(hi, Math.floor(n)) : dflt;
  };
  return {
    defaultWidth: num(config.defaultWidth, 800, 16, 4096),
    maxWidth: num(config.maxWidth, 1600, 16, 4096),
    maxPixels: num(config.maxPixels, 4_000_000, 65536, 16_000_000),
    maxSourceBytes: num(config.maxSourceKB, 256, 1, 4096) * 1024,
    scale: num(config.scale, 2, 1, 3),
    headless: (config.headless as boolean) ?? true,
    executablePath: (config.executablePath as string) ?? '',
    idleShutdownSec: num(config.idleShutdownSec, 300, 0, 86400),
    maxConcurrency: num(config.maxConcurrency, 2, 1, 8),
    animMaxDurationSec: num(config.animMaxDurationSec, 8, 1, 30),
    animDefaultFps: num(config.animDefaultFps, 15, 1, 25),
    animMaxFrames: num(config.animMaxFrames, 160, 2, 600),
    animMaxOutputMB: num(config.animMaxOutputMB, 9, 1, 9),
  };
}

/** sessionId → 文件系统安全目录名（与 adapter 附件缓存同规，另中和 .. 与前导点做纵深防御）。 */
function safeSessionDir(sessionId: string): string {
  return (
    sessionId
      .replace(/[:/\\]/g, '_')
      .replace(/\.\./g, '_')
      .replace(/^\.+/, '_') || 'nosession'
  );
}

export function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const cfg = resolveConfig(rawConfig);
  const logger = ctx.logger.child('draw');
  const storage = createStorageGateway(ctx);
  const proc = createProcessGateway(ctx);

  const engine = new DrawEngine(logger, {
    headless: cfg.headless,
    executablePath: cfg.executablePath || undefined,
    idleShutdownMs: cfg.idleShutdownSec * 1000,
    stepTimeoutMs: 15_000,
    maxConcurrency: cfg.maxConcurrency,
  });
  ctx.onDispose(() => engine.dispose());

  const tools = useToolService(ctx);
  tools.registerGroup({
    name: 'draw',
    label: '绘图',
    description: '把模型编写的 SVG/HTML 标记渲染为图片，配合 send_attachment 发进聊天',
  });

  tools.register({
    // 刻意 public：绘图是人人可要求的能力（用户产品决定）——群里谁都能让 bot 画图。
    // 抗滥用不靠权限档而靠资源治理：单次成本被 maxPixels/maxFrames/体积封顶，
    // 跨会话并发由引擎信号量排队（不拒绝、只削峰），机器不会被刷图打垮。
    groups: ['draw'],
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
        const source = String(args.source ?? '');
        if (!source.trim()) return JSON.stringify({ error: 'source 为空' });
        if (Buffer.byteLength(source) > cfg.maxSourceBytes) {
          return JSON.stringify({ error: `source 超过大小上限 ${Math.floor(cfg.maxSourceBytes / 1024)}KB` });
        }
        // 按 scale² 折算：resolveCanvas 收的是 CSS 像素，但真实光栅 = CSS 像素 × scale²，
        // 用折算后的 CSS 像素预算让设备像素峰值不超过 maxPixels 的既定内存含义
        const cssPixelBudget = Math.floor(cfg.maxPixels / (cfg.scale * cfg.scale));
        const plan = resolveCanvas(source, args.width as number | undefined, { ...cfg, maxPixels: cssPixelBudget });
        const { png, width, height } = await engine.renderPng(plan, cfg.scale, cssPixelBudget);

        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(png));
        const hash = Buffer.from(digest).toString('hex').slice(0, 16);
        const dir = safeSessionDir(callCtx.sessionId || 'nosession');
        const uri = `data:/images/${dir}/draw-${hash}.png`;
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
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`draw_image 失败: ${message}`);
        return JSON.stringify({ error: message });
      }
    },
  });

  tools.register({
    // public 同 draw_image：人人可画，抗滥用靠资源治理不靠权限档。
    groups: ['draw'],
    definition: {
      type: 'function',
      function: {
        name: 'draw_animation',
        description:
          '把你编写的带动画的 SVG/HTML 标记渲染成 GIF 动图，落盘后返回 storage_uri（用 send_attachment 发送）。\n' +
          '**动画只能用声明式**：SVG 用 SMIL（<animate>/<animateTransform>/<animateMotion>）或 CSS ' +
          '@keyframes；脚本驱动的动画不会生效（渲染页禁用 JS）。建议动画时长 2-5 秒并做无缝循环' +
          '（首尾状态一致），GIF 默认无限循环播放。\n' +
          '**避坑**：同一元素不要同时挂 animateMotion 与位移类 animateTransform（位移复合会漂移）。\n' +
          '渲染成功即可**直接 send_attachment 发送**，不需要额外核对。结果里的 check_frames（首帧/中帧）' +
          '仅在你对形态没把握时可选地用 analyze_image 看一眼——但视觉识别较慢，通常无必要，别默认调用；' +
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
        const source = String(args.source ?? '');
        if (!source.trim()) return JSON.stringify({ error: 'source 为空' });
        if (Buffer.byteLength(source) > cfg.maxSourceBytes) {
          return JSON.stringify({ error: `source 超过大小上限 ${Math.floor(cfg.maxSourceBytes / 1024)}KB` });
        }
        const plan = resolveCanvas(source, args.width as number | undefined, cfg);
        const reqDur = Number(args.duration_seconds);
        const reqFps = Number(args.fps);
        const fps = Number.isFinite(reqFps) && reqFps > 0 ? Math.min(Math.floor(reqFps), 25) : cfg.animDefaultFps;

        const r = await engine.renderAnimation(plan, {
          fps,
          requestedDurationMs: Number.isFinite(reqDur) && reqDur > 0 ? Math.round(reqDur * 1000) : undefined,
          defaultDurationMs: 3000,
          maxDurationMs: cfg.animMaxDurationSec * 1000,
          maxFrames: cfg.animMaxFrames,
          scale: 1, // 动图按 1x：帧数×像素才是体积主宰，清晰度靠画布宽
          maxPixels: cfg.maxPixels,
        });

        const gif = await framesToGif(proc, storage, r.frames, fps);
        if (gif.byteLength > cfg.animMaxOutputMB * 1024 * 1024) {
          return JSON.stringify({
            error:
              `GIF ${(gif.byteLength / 1048576).toFixed(1)}MB 超过上限 ${cfg.animMaxOutputMB}MB——` +
              '请缩小画布宽、降低 fps 或缩短时长后重试',
          });
        }

        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(gif));
        const hash = Buffer.from(digest).toString('hex').slice(0, 16);
        const dir = safeSessionDir(callCtx.sessionId || 'nosession');
        const uri = `data:/images/${dir}/draw-${hash}.gif`;
        await storage.writeFile(uri, gif);
        // 检查帧：首帧+中帧落盘，供 agent 在没把握时**可选**用 analyze_image 核对——
        // 不是默认路径。本地视觉推理慢（33b 单张可达数分钟），默认自检会把 2 秒的动图
        // 拖成几分钟、还挤占入站识别的产能（实测已踩），故降级为提示、由模型按需取用。
        const midIdx = Math.floor(r.frames.length / 2);
        const checkFrames: string[] = [];
        for (const [tag, idx] of [
          ['f0', 0],
          ['fmid', midIdx],
        ] as const) {
          const fUri = `data:/images/${dir}/draw-${hash}-${tag}.png`;
          await storage.writeFile(fUri, r.frames[idx]);
          checkFrames.push(fUri);
        }
        const lintWarnings = lintAnimationSource(source);
        logger.info(
          `draw_animation 渲染完成 mode=${plan.mode} ${r.width}x${r.height} ${r.frames.length}帧@${fps}fps ` +
            `${(gif.byteLength / 1024).toFixed(0)}KB anims=${r.animationCount} → ${uri}`,
        );
        const warnings = [
          ...(r.animationCount === 0
            ? ['未检测到任何声明式动画——产物是静态画面的重复帧。动画请用 SMIL 或 CSS @keyframes。']
            : []),
          ...lintWarnings,
        ];
        return JSON.stringify({
          uri,
          width: r.width,
          height: r.height,
          frames: r.frames.length,
          fps,
          duration_seconds: r.durationMs / 1000,
          size_kb: Math.round(gif.byteLength / 1024),
          check_frames: checkFrames,
          ...(warnings.length > 0 ? { warnings } : {}),
          message:
            '已渲染并落盘，可直接用 send_attachment({ kind: "image", storage_uri: uri }) 发送到聊天。' +
            'check_frames 仅供没把握时可选核对（analyze_image 较慢，通常无需调用）。',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`draw_animation 失败: ${message}`);
        return JSON.stringify({ error: message });
      }
    },
  });
}
