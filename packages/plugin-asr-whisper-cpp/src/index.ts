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
import { type ASRService, asr, type TranscribeInput, type TranscribeResult } from '@aalis/api-asr';
import type { ProcessService } from '@aalis/api-process';
import { processService } from '@aalis/api-process';
import type { StorageService } from '@aalis/api-storage';
import { isStorageUri, storage as storageService } from '@aalis/api-storage';
import { config, definePlugin, logger, provide } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { safeFetch } from '@aalis/util-network-guard';
import { t } from './texts.js';

const configSchema = defineConfig({
  binaryPath: {
    type: 'string',
    label: t('binaryPathLabel'),
    description: t('binaryPathDescription'),
    default: 'whisper-cli',
    // 必填加默认值：留空时用默认的命令名，不会拿空串去执行
    required: true,
    format: 'executable',
    onInvalid: 'error',
  },
  modelPath: {
    type: 'string',
    label: t('modelPathLabel'),
    description: t('modelPathDescription'),
    required: true,
    format: 'absolute-path',
    onInvalid: 'error',
  },
  language: { type: 'string', label: t('languageLabel'), default: 'auto', onInvalid: 'error' },
  threads: { type: 'number', label: t('threadsLabel'), default: 4, onInvalid: 'error' },
  timeoutMs: {
    type: 'number',
    label: t('timeoutMsLabel'),
    default: 600000,
    onInvalid: 'error',
    description: t('timeoutMsDescription'),
  },
});
type Cfg = ConfigOf<typeof configSchema>;

/**
 * 在 asr 服务里的优先级：只作第一方提供者之间的默认先后（本地转写在云端接口的 50 之前）。选哪个由 media 的 `audio.prefer`
 * 决定，服务偏好只在优先级相同时决胜
 */
const PRIORITY = 80;

/** 远程音频下载与 plugin-media 同口径：20 MiB 上限，连接加读完响应体共 15 秒。 */
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * 下载远程音频。safeFetch 只管 SSRF 与重定向，不带超时也不限体积；入站语音 URL 由外部平台给出，
 * 对端不应答会挂住整轮语音回合，超大响应会整个读进内存。超时信号覆盖连接与读取响应体；
 * 体积按流式累计判定——不用 arrayBuffer()，无 Content-Length 的响应要全部读完才看得到大小。
 */
async function downloadAudio(url: string): Promise<Buffer> {
  const resp = await safeFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
  const declared = Number(resp.headers.get('content-length'));
  if (declared > DOWNLOAD_MAX_BYTES) {
    await resp.body?.cancel().catch(() => {});
    throw new Error(`音频过大 (${declared} > ${DOWNLOAD_MAX_BYTES})`);
  }
  if (!resp.body) throw new Error('下载失败：上游无响应体');
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > DOWNLOAD_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`音频过大 (流式累计 > ${DOWNLOAD_MAX_BYTES})`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** 解码或下载到的音频写进临时目录：一律叫 audio.bin，转码时 ffmpeg 按内容探测格式，扩展名不参与 */
async function writeTempAudio(
  proc: ProcessService,
  storage: StorageService,
  bytes: Buffer,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const tmp = await proc.makeTempDir('whisper-in');
  await storage.writeFile(`${tmp.uri}/audio.bin`, bytes);
  return { path: `${tmp.path}/audio.bin`, cleanup: tmp.cleanup };
}

/**
 * 把附件 data 解析为本地可读路径；返回路径 + 清理函数（仅对下载/解码出的临时文件有意义）。
 * 与 plugin-media 的规范实现 ffmpeg.ts:materializeAttachment 对齐：base64 data URL、file://、
 * http(s)、storage URI（scheme:/）都支持。
 */
async function materializeAudio(
  proc: ProcessService,
  storage: StorageService,
  data: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  // base64 data URL（必须带 ;base64,，借此与 storage URI `data:/...` 区分）
  const dataUri = data.match(/^data:[^;]+;base64,(.+)$/);
  if (dataUri) return writeTempAudio(proc, storage, Buffer.from(dataUri[1], 'base64'));
  if (data.startsWith('file://')) {
    return { path: data.slice('file://'.length), cleanup: async () => {} };
  }
  if (data.startsWith('http://') || data.startsWith('https://')) {
    return writeTempAudio(proc, storage, await downloadAudio(data));
  }
  // storage URI（scheme:/...）解析到本地路径
  if (isStorageUri(data)) {
    const local = await storage.resolveLocalPath?.(data, 'read');
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

const uses = { logger, config, provide, proc: processService, storage: storageService };

export default definePlugin({
  name: '@aalis/plugin-asr-whisper-cpp',
  displayName: t('displayName'),
  subsystem: 'media',
  configSchema,
  reusable: true,
  provides: [asr],
  uses,
  apply(caps) {
    const cfg = parseConfig(configSchema, caps.config.use, caps.logger.use);
    const proc = caps.proc.use;
    const storage = caps.storage.use;

    caps.provide.use(asr, buildAsrService(cfg, proc, storage), { priority: PRIORITY });
    caps.logger.use.info(`Whisper.cpp ASR 已注册 (model=${cfg.modelPath})`);
  },
});

function buildAsrService(cfg: Cfg, proc: ProcessService, storage: StorageService): ASRService {
  return {
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const src = await materializeAudio(proc, storage, input.attachment.data);
      // ffmpeg 与 whisper-cli 的产物统一落在专用临时目录，避免污染输入所在的数据目录
      const work = await proc.makeTempDir('whisper');
      try {
        const wavLocal = `${work.path}/audio.16k.wav`;
        // 转码给一半预算，识别拿完整预算：两段子进程都卡住时上界是 1.5 × timeoutMs（远程下载另有 15 秒上限）
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
}
