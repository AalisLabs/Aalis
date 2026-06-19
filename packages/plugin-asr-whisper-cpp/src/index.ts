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
import type { ProcessService } from '@aalis/plugin-process-api';
import { createProcessGateway } from '@aalis/plugin-process-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import { safeFetch } from '@aalis/util-network-guard';

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

/**
 * 把附件 data 解析为本地可读路径；返回路径 + 清理函数（仅对下载/解码出的临时文件有意义）。
 * 与 plugin-media 的规范实现 ffmpeg.ts:materializeAttachment 对齐：base64 data URL、file://、
 * http(s)、storage URI（scheme:/）、以及历史裸相对路径 `data/...`（补成 `data:/...`）都支持。
 */
async function materializeAudio(
  proc: ProcessService,
  storage: StorageService,
  data: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  // base64 data URL（必须带 ;base64,，借此与 storage URI `data:/...` 区分）
  const dataUri = data.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUri) {
    const tmp = await proc.makeTempDir('whisper-in');
    const ext = dataUri[1].split('/')[1]?.split(';')[0] ?? 'bin';
    await storage.writeFile(`${tmp.uri}/audio.${ext}`, Buffer.from(dataUri[2], 'base64'));
    return { path: `${tmp.path}/audio.${ext}`, cleanup: tmp.cleanup };
  }
  if (data.startsWith('file://')) {
    return { path: data.slice('file://'.length), cleanup: async () => {} };
  }
  if (data.startsWith('http://') || data.startsWith('https://')) {
    const resp = await safeFetch(data);
    if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
    const tmp = await proc.makeTempDir('whisper-in');
    const ext = data.split('.').pop()?.split('?')[0] ?? 'bin';
    await storage.writeFile(`${tmp.uri}/audio.${ext}`, Buffer.from(await resp.arrayBuffer()));
    return { path: `${tmp.path}/audio.${ext}`, cleanup: tmp.cleanup };
  }
  // storage URI（scheme:/...）或历史裸相对路径（data/... → data:/...），统一解析到本地路径
  let storageUri: string | null = null;
  if (/^[a-z][a-z0-9_-]*:\//.test(data)) storageUri = data;
  else if (/^data\//.test(data)) storageUri = `data:/${data.slice('data/'.length)}`;
  if (storageUri) {
    const local = await storage.resolveLocalPath?.(storageUri, 'read');
    if (local) return { path: local, cleanup: async () => {} };
  }
  throw new Error(`不支持的附件来源: ${data.slice(0, 32)}`);
}

/** 用 ffmpeg 把任意音频转成 whisper 需要的 16kHz mono wav，写到 outLocal。 */
async function toWav16k(proc: ProcessService, input: string, outLocal: string): Promise<void> {
  await proc
    .execFile('ffmpeg', ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outLocal])
    .catch((err: Error & { result?: { stderr: string } }) => {
      throw new Error(`ffmpeg 转码失败: ${(err.result?.stderr ?? err.message).slice(-200)}`);
    });
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
      const src = await materializeAudio(proc, storage, input.attachment.data);
      // ffmpeg 与 whisper-cli 的产物统一落在专用临时目录，避免污染输入所在的数据目录
      const work = await proc.makeTempDir('whisper');
      try {
        const wavLocal = `${work.path}/audio.16k.wav`;
        await toWav16k(proc, src.path, wavLocal);
        const lang = input.language ?? cfg.language;
        const args = [
          '-m',
          cfg.modelPath,
          '-f',
          wavLocal,
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
        // whisper-cli 在 wav 旁生成 <wav>.txt（即 work 目录内）；读不到时回退 stdout
        let text = '';
        try {
          const raw = await storage.readFile(`${work.uri}/audio.16k.wav.txt`, 'utf-8');
          text = String(raw).trim();
        } catch {
          text = r.stdout.replace(/\[[^\]]+\]/g, '').trim();
        }
        return { text };
      } finally {
        await work.cleanup();
        await src.cleanup();
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
