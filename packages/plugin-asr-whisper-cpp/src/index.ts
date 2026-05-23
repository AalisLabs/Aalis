// ============================================================
// @aalis/plugin-asr-whisper-cpp — 本地 whisper.cpp 转写后端
//
// 调用 whisper-cli 二进制（whisper.cpp 提供）。需要：
//   - 安装 whisper.cpp（brew install whisper-cpp）
//   - 下载模型文件（如 ggml-base.bin）
//
// 输入音频经 ffmpeg 转 16kHz 单声道 WAV 后喂给 whisper-cli。
// ============================================================

import { Buffer } from 'node:buffer';
import type { ConfigSchema, Context } from '@aalis/core';
import type { MediaProcessor, TranscribeInput, TranscribeResult } from '@aalis/plugin-media-api';
import type { ProcessService, TempDirHandle } from '@aalis/plugin-process-api';
import { createProcessGateway } from '@aalis/plugin-process-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';

export const name = '@aalis/plugin-asr-whisper-cpp';
export const displayName = 'Whisper.cpp 本地转写';
export const subsystem = 'media';
export const provides: string[] = [];
export const inject = { required: ['media', 'process', 'storage'] };

interface Cfg {
  binaryPath: string;
  modelPath: string;
  language: string;
  threads: number;
  priority: number;
}

export const configSchema: ConfigSchema = {
  binaryPath: { type: 'string', label: 'whisper-cli 路径', default: 'whisper-cli' },
  modelPath: { type: 'string', label: '模型文件路径 (.bin)', default: '' },
  language: { type: 'string', label: '默认语种', default: 'auto' },
  threads: { type: 'number', label: '线程数', default: 4 },
  priority: { type: 'number', label: '优先级 (越大越优先)', default: 80 },
};

export const defaultConfig: Cfg = {
  binaryPath: 'whisper-cli',
  modelPath: '',
  language: 'auto',
  threads: 4,
  priority: 80,
};

interface AudioMaterial {
  /** ffmpeg 可读的本地输入路径 */
  path: string;
  /** tmp 句柄；若来源是已有的 file:// / storage URI 则为 null */
  tmp: TempDirHandle | null;
  /** 当 tmp 非 null 时，相对 tmp 根的输入文件名（用于推导后续 wav/.txt 的 storage URI） */
  audioBase: string | null;
}

async function materializeAudio(proc: ProcessService, storage: StorageService, data: string): Promise<AudioMaterial> {
  if (data.startsWith('file://')) {
    return { path: data.slice(7), tmp: null, audioBase: null };
  }
  // storage URI（如 data:/audios/...）
  if (
    /^[a-z][a-z0-9_-]*:\//.test(data) &&
    !data.startsWith('http://') &&
    !data.startsWith('https://') &&
    !data.startsWith('data:')
  ) {
    try {
      const local = await storage.resolveLocalPath?.(data, 'read');
      if (local) return { path: local, tmp: null, audioBase: null };
    } catch {
      /* fall through */
    }
  }
  const tmp = await proc.makeTempDir('whisper');
  let buf: Buffer;
  let ext = 'bin';
  if (data.startsWith('data:')) {
    const m = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) {
      await tmp.cleanup();
      throw new Error('无效 data URL');
    }
    buf = Buffer.from(m[2], 'base64');
    ext = m[1].split('/')[1]?.split(';')[0] ?? 'bin';
  } else if (data.startsWith('http://') || data.startsWith('https://')) {
    const resp = await fetch(data);
    if (!resp.ok) {
      await tmp.cleanup();
      throw new Error(`下载失败 ${resp.status}`);
    }
    buf = Buffer.from(await resp.arrayBuffer());
    ext = data.split('.').pop()?.split('?')[0] ?? 'bin';
  } else {
    await tmp.cleanup();
    throw new Error(`不支持的附件来源: ${data.slice(0, 32)}`);
  }
  const audioBase = `audio.${ext}`;
  await storage.writeFile(`${tmp.uri}/${audioBase}`, buf);
  const path = await storage.resolveLocalPath!(`${tmp.uri}/${audioBase}`, 'read');
  return { path, tmp, audioBase };
}

/** 用 ffmpeg 把任意音频转成 whisper 需要的 16kHz mono wav。 */
async function toWav16k(proc: ProcessService, input: string): Promise<string> {
  const out = `${input}.16k.wav`;
  await proc
    .execFile('ffmpeg', ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out])
    .catch((err: Error & { result?: { stderr: string } }) => {
      throw new Error(`ffmpeg 转码失败: ${(err.result?.stderr ?? err.message).slice(-200)}`);
    });
  return out;
}

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg: Cfg = { ...defaultConfig, ...(raw as Partial<Cfg>) };
  const logger = ctx.logger.child('asr-whisper-cpp');

  if (!cfg.modelPath) {
    logger.warn('未配置 modelPath，插件不会注册 processor');
    return;
  }
  const proc = createProcessGateway(ctx);
  const storage = createStorageGateway(ctx);

  const processor: MediaProcessor = {
    name: `asr-whisper-cpp:${cfg.modelPath.split('/').pop() ?? 'model'}`,
    capabilities: ['audio'],
    priority: cfg.priority,
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const local = await materializeAudio(proc, storage, input.attachment.data);
      try {
        const wav = await toWav16k(proc, local.path);
        const lang = input.language ?? cfg.language;
        const args = [
          '-m',
          cfg.modelPath,
          '-f',
          wav,
          '-l',
          lang,
          '-t',
          String(cfg.threads),
          '-nt', // no timestamps in stdout
          '--output-txt',
        ];
        const r = await proc.execFile(cfg.binaryPath, args).catch((err: Error & { result?: { stderr: string } }) => {
          throw new Error(`whisper-cli 失败: ${(err.result?.stderr ?? err.message).slice(-200)}`);
        });
        // 读取生成的 .txt（whisper-cli 默认在输入路径旁生成 <wav>.txt）
        let text = '';
        if (local.tmp && local.audioBase) {
          const txtUri = `${local.tmp.uri}/${local.audioBase}.16k.wav.txt`;
          try {
            const raw = await storage.readFile(txtUri, 'utf-8');
            text = String(raw).trim();
          } catch {
            text = r.stdout.replace(/\[[^\]]+\]/g, '').trim();
          }
        } else {
          // 输入是外部 file:// 或 storage URI，txt 与 wav 在同目录但不一定在我们的 root 内：回退 stdout
          text = r.stdout.replace(/\[[^\]]+\]/g, '').trim();
        }
        return { text };
      } finally {
        if (local.tmp) await local.tmp.cleanup();
      }
    },
  };

  const media = ctx.getService<{ registerProcessor: (p: MediaProcessor) => () => void }>('media');
  if (!media) {
    logger.error('media 服务不可用');
    return;
  }
  const dispose = media.registerProcessor(processor);
  ctx.onDispose(() => dispose());
  logger.info(`Whisper.cpp 转写已注册 (model=${cfg.modelPath}, prio=${cfg.priority})`);
}
