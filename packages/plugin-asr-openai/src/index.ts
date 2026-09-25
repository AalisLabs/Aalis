// ============================================================
// @aalis/plugin-asr-openai — OpenAI Whisper API 转写后端
//
// 以 asr 服务 provider 注册，调用 OpenAI 兼容 /audio/transcriptions。
// 兼容 OpenAI、Groq、本地 ollama-asr 网关等所有 OpenAI 风格协议。
// ============================================================

import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import { type ASRService, asr, type TranscribeInput, type TranscribeResult } from '@aalis/api-asr';
import { createProcessGateway, type ProcessService, processService } from '@aalis/api-process';
import { createStorageGateway, isStorageUri, type StorageService, storage as storageService } from '@aalis/api-storage';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import { config, definePlugin, logger, optional, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { safeFetch } from '@aalis/util-network-guard';

interface Cfg {
  apiKey: string;
  baseUrl: string;
  model: string;
  priority: number;
  timeoutMs: number;
}

const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', secret: true, default: '' },
  baseUrl: { type: 'string', label: 'Base URL', default: 'https://api.openai.com/v1' },
  model: { type: 'string', label: '模型', default: 'whisper-1' },
  priority: { type: 'number', label: '优先级 (越大越优先)', default: 50 },
  timeoutMs: {
    type: 'number',
    label: '请求超时 (ms)',
    default: 600000,
    description: '整段上传+识别的上限。默认取宽（10 分钟）：闸的目的是掐断真正卡死的请求，不是给长音频限速',
  },
};

const defaultConfig: Cfg = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
  priority: 50,
  timeoutMs: 600000,
};

/**
 * Whisper API 实际接受的后缀集（其余一律被判 400，包括 opus、amr 这类常见语音容器）。
 * 后缀只决定上传文件名，不做转码——不在集内的来源改按 Content-Type 映射到集内后缀。
 */
const WHISPER_EXTS = new Set(['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);

/**
 * 猜音频文件扩展名。`url.split('.').pop()` 在无扩展名的来源上会把整条路径当扩展名
 * （实测 `audio.com/download` → 带斜杠的文件名，被 Whisper API 判 400），故走
 * extname + {@link WHISPER_EXTS} 实际支持集：命中即用；未命中（无后缀、或后缀不被
 * API 接受）再按 Content-Type 映射；没有 Content-Type（file:// 与 storage 两支都不带）
 * 时拿路径后缀过同一张映射表，`.opus` 才能落成 ogg 而非被兜底成 wav；都取不到落 'wav'。
 */
function guessAudioExt(source: string, contentType?: string | null): string {
  const fromPath = extname(source.split('?')[0].split('#')[0]).replace(/^\./, '').toLowerCase();
  if (WHISPER_EXTS.has(fromPath)) return fromPath;
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
  return byMime[sub] ?? byMime[fromPath] ?? 'wav';
}

/** 远程音频下载与 plugin-media 同口径：20 MiB 上限，连接加读完响应体共 15 秒。 */
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * 下载远程音频。safeFetch 只管 SSRF 与重定向，不带超时也不限体积；入站语音 URL 由外部平台给出，
 * 对端不应答会挂住整轮语音回合，超大响应会整个读进内存。超时信号覆盖连接与读取响应体；
 * 体积按流式累计判定——不用 arrayBuffer()，无 Content-Length 的响应要全部读完才看得到大小。
 */
async function downloadAudio(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
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
  return { bytes: Buffer.concat(chunks), contentType: resp.headers.get('content-type') };
}

async function attachmentToBlob(
  data: string,
  proc: ProcessService,
  storage: StorageService,
): Promise<{ blob: Blob; filename: string }> {
  // base64 data URL（必须带 ;base64,，借此与 storage URI `data:/...` 区分）
  const dataUri = data.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUri) {
    const mime = dataUri[1];
    const buf = Buffer.from(dataUri[2], 'base64');
    // 同样过 WHISPER_EXTS 白名单：`audio/opus` 直接取 mime 子类型会上传 audio.opus，被判 400
    const ext = guessAudioExt('', mime);
    return { blob: new Blob([buf as unknown as ArrayBuffer], { type: mime }), filename: `audio.${ext}` };
  }
  if (data.startsWith('file://') || data.startsWith('/')) {
    // 走 ProcessService.readExternalFile（治外文件能力），避免直 import node:fs
    const bytes = await proc.readExternalFile(data);
    const path = data.startsWith('file://') ? data.slice(7) : data;
    return { blob: new Blob([bytes as unknown as ArrayBuffer]), filename: `audio.${guessAudioExt(path)}` };
  }
  if (data.startsWith('http://') || data.startsWith('https://')) {
    const { bytes, contentType } = await downloadAudio(data);
    return {
      blob: new Blob([bytes as unknown as ArrayBuffer], { type: contentType ?? 'application/octet-stream' }),
      filename: `audio.${guessAudioExt(data, contentType)}`,
    };
  }
  // storage URI（scheme:/...）或历史裸相对路径（data/... → data:/...）→ 经 storage 读取
  let storageUri: string | null = null;
  if (isStorageUri(data)) storageUri = data;
  else if (/^data\//.test(data)) storageUri = `data:/${data.slice('data/'.length)}`;
  if (storageUri) {
    const bytes = (await storage.readFile(storageUri)) as Uint8Array;
    return { blob: new Blob([bytes as unknown as ArrayBuffer]), filename: `audio.${guessAudioExt(storageUri)}` };
  }
  throw new Error(`不支持的附件来源: ${data.slice(0, 32)}`);
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
    const cfg: Cfg = { ...defaultConfig, ...(caps.config as Partial<Cfg>) };

    if (!cfg.apiKey) {
      // 与 openai/embedding-openai 一致：缺必填配置时抛清晰错误（而非静默 return，
      // 否则声明了提供 asr 却不注册会触发难懂的 provides 校验错）。
      throw new Error('OpenAI Whisper ASR 需要配置 apiKey（不使用 OpenAI ASR 可在插件管理里禁用本插件）');
    }

    const proc = createProcessGateway(caps.proc);
    const storage = createStorageGateway(caps.storage);

    caps.provide(asr, buildAsrService(cfg, proc, storage), { priority: cfg.priority });
    caps.logger.info(`OpenAI Whisper ASR 已注册 (model=${cfg.model}, prio=${cfg.priority})`);
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
