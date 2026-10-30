// ============================================================
// @aalis/plugin-asr-openai — OpenAI Whisper API 转写后端
//
// 以 asr 服务 provider 注册，调用 OpenAI 兼容 /audio/transcriptions。
// 兼容 OpenAI、Groq、本地 ollama-asr 网关等所有 OpenAI 风格协议。
// ============================================================

import { Buffer } from 'node:buffer';
import { type ASRService, asr, type TranscribeInput, type TranscribeResult } from '@aalis/api-asr';
import { type ProcessService, processService } from '@aalis/api-process';
import { isStorageUri, isWebUrl, type StorageService, storage as storageService } from '@aalis/api-storage';
import { config, definePlugin, logger, optional, provide } from '@aalis/core';
import { type ConfigOf, configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { detectMediaFormat, FILE_HEAD_BYTES, type MediaFormatName } from '@aalis/util-file-signature';
import { safeFetch } from '@aalis/util-network-guard';
import { t } from './texts.js';

const configSchema = defineConfig({
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true, onInvalid: 'error' },
  baseUrl: { type: 'string', label: 'Base URL', default: 'https://api.openai.com/v1', onInvalid: 'error' },
  model: { type: 'string', label: t('modelLabel'), default: 'whisper-1' },
  timeoutMs: {
    type: 'number',
    label: t('timeoutMsLabel'),
    default: 600000,
    description: t('timeoutMsDescription'),
  },
});
type Cfg = ConfigOf<typeof configSchema>;

/**
 * 在 asr 服务里的优先级：只作第一方提供者之间的默认先后（本地的 whisper.cpp 为 80，在前）。选哪个由 media 的 `audio.prefer`
 * 决定，服务偏好只在优先级相同时决胜
 */
const PRIORITY = 50;

/**
 * Whisper 接口接受的音频格式（文件头判定的格式名）。接口按上传文件名的后缀认格式，后缀取判定出的格式，不按来源的路径、
 * Content-Type 或 data URL 里写的类型猜；别的格式（AMR、SILK 等）接口一律判 400，插件不转码，读出来就报错。
 */
const WHISPER_FORMATS: ReadonlySet<MediaFormatName> = new Set(['MP3', 'WAV', 'OGG', 'FLAC', 'M4A', 'MP4', 'WebM']);

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

/** 附件的字节：base64 data URL、file:// 与本机绝对路径、网址、存储地址四种来源 */
async function attachmentBytes(data: string, proc: ProcessService, storage: StorageService): Promise<Uint8Array> {
  // base64 data URL（必须带 ;base64,，借此与 storage URI `data:/...` 区分）
  const dataUri = data.match(/^data:[^;]+;base64,(.+)$/);
  if (dataUri) return Buffer.from(dataUri[1], 'base64');
  // 走 ProcessService.readExternalFile（治外文件能力），避免直 import node:fs
  if (data.startsWith('file://') || data.startsWith('/')) return proc.readExternalFile(data);
  if (isWebUrl(data)) return downloadAudio(data);
  if (isStorageUri(data)) return (await storage.readFile(data)) as Uint8Array;
  throw new Error(`不支持的附件来源: ${data.slice(0, 32)}`);
}

/** 上传给接口的文件：文件名 `audio.<判定出的扩展名>`，类型取判定结果；接口不接受的格式报错 */
async function attachmentToBlob(
  data: string,
  proc: ProcessService,
  storage: StorageService,
): Promise<{ blob: Blob; filename: string }> {
  const bytes = await attachmentBytes(data, proc, storage);
  const format = detectMediaFormat(bytes.subarray(0, FILE_HEAD_BYTES));
  if (!format || !WHISPER_FORMATS.has(format.format)) {
    throw new Error(format ? `Whisper 接口不接受 ${format.format} 音频` : 'Whisper 接口不接受认不出格式的音频');
  }
  return { blob: new Blob([bytes as unknown as ArrayBuffer], { type: format.mime }), filename: `audio.${format.ext}` };
}

const uses = {
  logger,
  config,
  provide,
  proc: optional(processService),
  storage: optional(storageService),
};

export default definePlugin({
  name: '@aalis/plugin-asr-openai',
  displayName: 'OpenAI Whisper ASR',
  subsystem: 'media',
  configSchema,
  reusable: true,
  provides: [asr],
  uses,
  apply(caps) {
    const cfg = parseConfig(configSchema, caps.config.use, caps.logger.use);
    if (!URL.canParse(cfg.baseUrl) || new URL(cfg.baseUrl).username || new URL(cfg.baseUrl).password) {
      throw configError(t('baseUrlInvalid'));
    }
    // 插件在 baseUrl 后面拼路径，带查询串或片段（含末尾单个 ?）时拼出来的地址是坏的，所以按原文判
    if (/[?#]/.test(cfg.baseUrl)) {
      throw configError(t('baseUrlQuery'));
    }

    const proc = caps.proc.use;
    const storage = caps.storage.use;

    caps.provide.use(asr, buildAsrService(cfg, proc, storage), { priority: PRIORITY });
    caps.logger.use.info(`OpenAI Whisper ASR 已注册 (model=${cfg.model})`);
  },
});

function buildAsrService(cfg: Cfg, proc: ProcessService, storage: StorageService): ASRService {
  return {
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const { blob, filename } = await attachmentToBlob(input.attachment.data, proc, storage);
      const fd = new FormData();
      fd.append('file', blob, filename);
      fd.append('model', cfg.model);
      if (input.language) fd.append('language', input.language);
      fd.append('response_format', input.withTimestamps ? 'verbose_json' : 'json');
      const resp = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: fd,
        // 调用方（plugin-media）与工具执行面都没有外层超时：对端不应答即整轮语音回合永久挂住，
        // 与 embedding-openai / whisper-cpp 已修的是同一形状。
        signal: AbortSignal.timeout(Math.max(1000, cfg.timeoutMs)),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Whisper API 失败 ${resp.status}: ${text}`);
      }
      const data = (await resp.json()) as {
        text: string;
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      const segments = data.segments?.map(s => ({ start: s.start, end: s.end, text: s.text }));
      return { text: data.text ?? '', segments };
    },
  };
}
