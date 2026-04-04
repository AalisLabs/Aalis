/**
 * 屏幕截图工具
 *
 * 截图保存为文件到 screenshotDir，返回文件路径供 AI 通过图片识别工具分析。
 * 不再返回 base64 内联数据（因为全屏截图 base64 可达数 MB，文本模型无法处理）。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { Context } from '@aalis/core';
import type { PlatformAdapter } from '../platform.js';

interface ScreenshotConfig {
  maxImageWidth: number;
  screenshotDir: string;
}

export function registerScreenshotTools(ctx: Context, adapter: PlatformAdapter, config: ScreenshotConfig): void {

  // 确保截图目录存在
  let dirReady: Promise<void> | null = null;
  function ensureDir(): Promise<void> {
    if (!dirReady) {
      dirReady = mkdir(config.screenshotDir, { recursive: true }).then(() => {});
    }
    return dirReady;
  }

  // 截图辅助：截取 → 可选缩放 → 保存文件 → 返回路径和元信息
  async function captureAndSave(
    region?: { x: number; y: number; width: number; height: number },
  ): Promise<{ filePath: string; width: number; height: number; size: number }> {
    const buffer = await adapter.captureScreen(region);

    let finalBuffer = buffer;
    let width = 0, height = 0;

    // 从 PNG 头部读取尺寸 (IHDR chunk: offset 16=width, 20=height)
    if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    }

    if (config.maxImageWidth > 0 && width > config.maxImageWidth) {
      try {
        // @ts-ignore — sharp 是可选依赖，运行时动态加载
        const sharp = await import('sharp');
        const sharpFn = sharp.default || sharp;
        const resized = await (sharpFn as any)(buffer)
          .resize({ width: config.maxImageWidth, withoutEnlargement: true })
          .png()
          .toBuffer();
        finalBuffer = resized;
        if (finalBuffer.length > 24) {
          width = finalBuffer.readUInt32BE(16);
          height = finalBuffer.readUInt32BE(20);
        }
      } catch {
        // sharp 不可用，使用原图
      }
    }

    // 保存到文件
    await ensureDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `screenshot-${timestamp}.png`;
    const filePath = resolve(config.screenshotDir, fileName);
    await writeFile(filePath, finalBuffer);

    return { filePath, width, height, size: finalBuffer.length };
  }

  // ── screen_capture ──
  ctx.registerTool({
    safety: 'dangerous',
    authority: 3,
    definition: {
      type: 'function',
      function: {
        name: 'screen_capture',
        description:
          '截取当前屏幕画面并保存为 PNG 文件。返回文件路径、尺寸等元信息。' +
          '可以截取全屏，或指定区域（x, y, width, height）。' +
          '截图保存后，使用 analyze_image 工具分析截图内容（可自定义提示词，如「提取所有文字」「描述按钮位置」）。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: '截取区域左上角 X 坐标（可选，不指定则全屏）' },
            y: { type: 'number', description: '截取区域左上角 Y 坐标' },
            width: { type: 'number', description: '截取区域宽度' },
            height: { type: 'number', description: '截取区域高度' },
          },
          required: [],
        },
      },
    },
    handler: async (args) => {
      try {
        const hasRegion = args.x !== undefined && args.y !== undefined &&
                          args.width !== undefined && args.height !== undefined;
        const region = hasRegion ? {
          x: args.x as number,
          y: args.y as number,
          width: args.width as number,
          height: args.height as number,
        } : undefined;

        const { filePath, width, height, size } = await captureAndSave(region);
        // 返回相对于 cwd 的路径（更简洁）
        const relPath = relative(process.cwd(), filePath);
        return JSON.stringify({
          filePath: relPath,
          absolutePath: filePath,
          width,
          height,
          size,
          region: region ?? 'fullscreen',
          hint: '请调用 analyze_image(image="<上方filePath>") 分析截图内容。可通过 prompt 参数指定分析重点，如「提取所有可见文字和按钮位置」。',
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

}
