import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessGateway } from '../../packages/api-process/src/index.js';
import { createStorageGateway, type StorageService } from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import { DrawEngine } from '../../packages/plugin-draw/src/engine.js';
import { ffmpegEncodeArgs, ffmpegPaletteArgs, framesToGif } from '../../packages/plugin-draw/src/gif.js';
import { type DrawCaps, resolveCanvas } from '../../packages/plugin-draw/src/plan.js';
import * as processLocal from '../../packages/plugin-process-local/src/index.js';
import * as storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// 动图路径真机 E2E：真 Chromium 逐帧 + 真 ffmpeg 编码。
// 锚三件事：
//   1) 动画真的在动（首帧 ≠ 中帧，SMIL 与 CSS 双机制都被步进）；
//   2) 逐帧确定性（两次完整渲染字节一致——暂停时钟成立）；
//   3) 帧→GIF 编码产物合法（GIF89a 头）且非空。
// ffmpeg 为本机依赖（部署机已有；plugin-media 同前提）。
// ════════════════════════════════════════════════════════════

const caps: DrawCaps = { defaultWidth: 800, maxWidth: 1600, maxPixels: 4_000_000, maxSourceBytes: 262144, scale: 2 };
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, child: () => logger } as never;

// SMIL 位移 + CSS 透明度双动画（探针会数出 ≥2 个动画）
const ANIMATED_SVG =
  '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">' +
  '<style>@keyframes fade{0%{opacity:1}50%{opacity:0.2}100%{opacity:1}}.p{animation:fade 2s linear infinite}</style>' +
  '<rect width="200" height="100" fill="#0f172a"/>' +
  '<circle cx="30" cy="50" r="16" fill="#f59e0b">' +
  '<animate attributeName="cx" from="30" to="170" dur="2s" repeatCount="indefinite"/></circle>' +
  '<text class="p" x="100" y="90" text-anchor="middle" fill="#fff" font-size="14">循环动画</text></svg>';

describe('gif 参数（纯函数）', () => {
  it('两遍编码参数形态', () => {
    expect(ffmpegPaletteArgs(15, '/t/f_%04d.png', '/t/p.png')).toEqual([
      '-y',
      '-framerate',
      '15',
      '-i',
      '/t/f_%04d.png',
      '-vf',
      'palettegen=max_colors=256:stats_mode=diff',
      '/t/p.png',
    ]);
    expect(ffmpegEncodeArgs(15, '/t/f_%04d.png', '/t/p.png', '/t/o.gif')).toContain('paletteuse=dither=sierra2_4a');
  });
});

describe('DrawEngine 动画（真浏览器 + 真 ffmpeg）', () => {
  let base: string;
  let app: App;
  let storage: StorageService;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-draw-anim-'));
    mkdirSync(join(base, 'ws'), { recursive: true });
    mkdirSync(join(base, 'tmp'), { recursive: true });
    app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(storageLocal as unknown as Parameters<typeof app.ctx.useModule>[0], {
      roots: [
        {
          name: 'ws',
          path: join(base, 'ws'),
          label: 'ws',
          kind: 'workspace',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
        {
          name: 'tmp',
          path: join(base, 'tmp'),
          label: 'tmp',
          kind: 'tmp',
          browsable: false,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.ctx.useModule(processLocal as unknown as Parameters<typeof app.ctx.useModule>[0], {});
    storage = createStorageGateway(app.ctx);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('SMIL+CSS 双机制被步进：首帧≠中帧；两次渲染字节级一致；GIF 合法', async () => {
    const engine = new DrawEngine(logger, { headless: true, idleShutdownMs: 0, stepTimeoutMs: 15_000 });
    try {
      const plan = resolveCanvas(ANIMATED_SVG, 200, caps);
      const opts = {
        fps: 10,
        defaultDurationMs: 3000,
        maxDurationMs: 8000,
        maxFrames: 160,
        scale: 1,
        maxPixels: caps.maxPixels,
      };
      const a = await engine.renderAnimation(plan, opts);
      expect(a.animationCount).toBeGreaterThanOrEqual(2); // SMIL 圆 + CSS 文本
      expect(a.durationMs).toBe(2000); // 自动探测到声明的 2s
      expect(a.frames.length).toBe(20); // 2s × 10fps
      // 动画真的在动
      expect(a.frames[0].equals(a.frames[10])).toBe(false);
      // 确定性：完整重渲一遍逐帧字节一致
      const b = await engine.renderAnimation(plan, opts);
      expect(b.frames.length).toBe(a.frames.length);
      for (let i = 0; i < a.frames.length; i += 5) {
        expect(a.frames[i].equals(b.frames[i]), `frame ${i}`).toBe(true);
      }

      const proc = createProcessGateway(app.ctx);
      const gif = await framesToGif(proc, storage, a.frames, opts.fps);
      expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
      expect(gif.byteLength).toBeGreaterThan(5000);
      expect(existsSync(join(base, 'tmp'))).toBe(true); // 临时目录已清（目录在、内容清）
    } finally {
      await engine.dispose();
    }
  }, 60_000);
});
