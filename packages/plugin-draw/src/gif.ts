// ============================================================
// gif.ts — 帧序列 → GIF（ffmpeg 调色板两遍编码）
//
// 走 api-process 的 makeTempDir + execFile 范式（与 plugin-media/ffmpeg.ts 同规）：
// 二进制不过 stdout（ExecResult.stdout 是 utf-8 字符串，会被解码破坏），
// 一律写临时文件再经 storage 读回。两遍编码：palettegen 按帧间差分建 256 色
// 调色板，paletteuse 带抖动回贴——文字清晰、体积小（调研实测 2s@20fps≈133KB）。
// ============================================================

import type { Buffer } from 'node:buffer';
import type { ProcessService } from '@aalis/api-process';
import type { StorageService } from '@aalis/api-storage';

/** palettegen / paletteuse 两遍的 ffmpeg 参数（纯函数，供测试断言） */
export function ffmpegPaletteArgs(fps: number, framePattern: string, palettePath: string): string[] {
  return [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    framePattern,
    '-vf',
    'palettegen=max_colors=256:stats_mode=diff',
    palettePath,
  ];
}

export function ffmpegEncodeArgs(fps: number, framePattern: string, palettePath: string, outPath: string): string[] {
  return [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    framePattern,
    '-i',
    palettePath,
    '-lavfi',
    'paletteuse=dither=sierra2_4a',
    '-loop',
    '0',
    outPath,
  ];
}

/** 帧序列编码为 GIF。失败抛错（调用方转用户可读错误）。 */
export async function framesToGif(
  proc: ProcessService,
  storage: StorageService,
  frames: Buffer[],
  fps: number,
): Promise<Buffer> {
  if (frames.length === 0) throw new Error('无帧可编码');
  const tmp = await proc.makeTempDir('draw-gif');
  try {
    for (let i = 0; i < frames.length; i++) {
      await storage.writeFile(`${tmp.uri}/frame_${String(i).padStart(4, '0')}.png`, frames[i]);
    }
    const framePattern = `${tmp.path}/frame_%04d.png`;
    const palettePath = `${tmp.path}/palette.png`;
    const outPath = `${tmp.path}/out.gif`;
    await proc.execFile('ffmpeg', ffmpegPaletteArgs(fps, framePattern, palettePath), { timeout: 60_000 });
    await proc.execFile('ffmpeg', ffmpegEncodeArgs(fps, framePattern, palettePath, outPath), { timeout: 60_000 });
    const raw = (await storage.readFile(`${tmp.uri}/out.gif`)) as Uint8Array;
    const { Buffer: NodeBuffer } = await import('node:buffer');
    return NodeBuffer.from(raw);
  } finally {
    await tmp.cleanup();
  }
}
