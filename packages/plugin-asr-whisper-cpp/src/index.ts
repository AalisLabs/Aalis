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
import { extname } from 'node:path';
import type { ASRService, TranscribeInput, TranscribeResult } from '@aalis/api-asr';
import type { ProcessService } from '@aalis/api-process';
import { createProcessGateway } from '@aalis/api-process';
import type { StorageService } from '@aalis/api-storage';
import { createStorageGateway, isStorageUri } from '@aalis/api-storage';
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { safeFetch } from '@aalis/util-network-guard';

export const name = '@aalis/plugin-asr-whisper-cpp';
export const displayName = 'Whisper.cpp 本地转写';
export const subsystem = 'media';
export const provides = ['asr'];
export const inject = { required: ['process', 'storage'] };
export const reusable = true;

interface Cfg {
  binaryPath: string;
  modelPath: string;
  language: string;
  threads: number;
  priority: number;
  /** 子进程超时（ms）。不设就永不 settle：process-local 只在 timeout>0 时才武装 killTree */
  timeoutMs: number;
}

export const configSchema: ConfigSchema = {
  binaryPath: { type: 'string', label: 'whisper-cli 路径', default: 'whisper-cli' },
  modelPath: { type: 'string', label: '模型文件路径 (.bin)', default: '' },
  language: { type: 'string', label: '默认语种', default: 'auto' },
  threads: { type: 'number', label: '线程数', default: 4 },
  priority: { type: 'number', label: '优先级 (越大越优先)', default: 80 },
  timeoutMs: {
    type: 'number',
    label: '子进程超时 (ms)',
    default: 120000,
    description: '转码与识别子进程的最长运行时间。设 0 表示不限——届时卡住的子进程会把整轮对话一起挂住。',
  },
};

const defaultConfig: Cfg = {
  binaryPath: 'whisper-cli',
  modelPath: '',
  language: 'auto',
  threads: 4,
  priority: 80,
  timeoutMs: 120000,
};

/**
 * 猜音频文件扩展名（只用来拼临时文件名，ffmpeg 按内容探测格式）。
 * `url.split('.').pop()` 在无扩展名的来源上会把整条路径当扩展名（实测
 * `audio.com/download` → 带斜杠的写路径，在 storage 下造嵌套垃圾目录），
 * 故一律走 extname + 白名单，取不到时按 Content-Type 兜底，最后落 'bin'。
 */
function guessAudioExt(source: string, contentType?: string | null): string {
  const fromPath = extname(source.split('?')[0].split('#')[0]).replace(/^\./, '').toLowerCase();
  if (/^[a-z0-9]{1,5}$/.test(fromPath)) return fromPath;
  const sub = (contentType ?? '').split(';')[0].trim().toLowerCase().split('/')[1] ?? '';
  const byMime: Record<string, string> = {
    mpeg: 'mp3',
    mp3: 'mp3',
    wav: 'wav',
    'x-wav': 'wav',
    wave: 'wav',
    ogg: 'ogg',
    opus: 'ogg',
    oga: 'ogg',
    mp4: 'm4a',
    'x-m4a': 'm4a',
    m4a: 'm4a',
    webm: 'webm',
    flac: 'flac',
  };
  return byMime[sub] ?? 'bin';
}

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
    const ext = guessAudioExt(data, resp.headers.get('content-type'));
    await storage.writeFile(`${tmp.uri}/audio.${ext}`, Buffer.from(await resp.arrayBuffer()));
    return { path: `${tmp.path}/audio.${ext}`, cleanup: tmp.cleanup };
  }
  // storage URI（scheme:/...）或历史裸相对路径（data/... → data:/...），统一解析到本地路径
  let storageUri: string | null = null;
  if (isStorageUri(data)) storageUri = data;
  else if (/^data\//.test(data)) storageUri = `data:/${data.slice('data/'.length)}`;
  if (storageUri) {
    const local = await storage.resolveLocalPath?.(storageUri, 'read');
    if (local) return { path: local, cleanup: async () => {} };
  }
  throw new Error(`不支持的附件来源: ${data.slice(0, 32)}`);
}

/** 用 ffmpeg 把任意音频转成 whisper 需要的 16kHz mono wav，写到 outLocal。 */
async function toWav16k(proc: ProcessService, input: string, outLocal: string, timeoutMs: number): Promise<void> {
  await proc
    // 必须给超时：process-local 的 spawn 只在 opts.timeout>0 时才武装 killTree，
    // 否则子进程不退就永不 settle——整轮 agent 被挂住，abort 也停不掉子进程。
    .execFile('ffmpeg', ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outLocal], {
      timeout: timeoutMs,
    })
    .catch((err: Error & { result?: { stderr: string } }) => {
      throw new Error(`ffmpeg 转码失败: ${(err.result?.stderr ?? err.message).slice(-200)}`);
    });
}

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg: Cfg = { ...defaultConfig, ...(raw as Partial<Cfg>) };
  const logger = ctx.logger.child('asr-whisper-cpp');

  if (!cfg.modelPath) {
    // 缺必填配置抛清晰错误（而非静默 return），避免 provides:['asr'] 未注册触发难懂的校验错
    throw new Error('Whisper.cpp 需要配置 modelPath（GGML 模型文件 .bin 路径）');
  }
  const proc = createProcessGateway(ctx);
  const storage = createStorageGateway(ctx);

  const asr: ASRService = {
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const src = await materializeAudio(proc, storage, input.attachment.data);
      // ffmpeg 与 whisper-cli 的产物统一落在专用临时目录，避免污染输入所在的数据目录
      const work = await proc.makeTempDir('whisper');
      try {
        const wavLocal = `${work.path}/audio.16k.wav`;
        // 转码给一半预算，识别拿完整预算：两段都卡住时整体上界仍是 1.5 × timeoutMs
        await toWav16k(proc, src.path, wavLocal, Math.max(0, Math.floor(cfg.timeoutMs / 2)));
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
        const r = await proc
          .execFile(cfg.binaryPath, args, { timeout: cfg.timeoutMs })
          .catch((err: Error & { result?: { stderr: string } }) => {
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

  ctx.provide('asr', asr, { priority: cfg.priority });
  logger.info(`Whisper.cpp ASR 已注册 (model=${cfg.modelPath}, prio=${cfg.priority})`);
}
