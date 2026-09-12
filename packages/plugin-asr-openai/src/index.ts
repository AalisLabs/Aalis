// ============================================================
// @aalis/plugin-asr-openai — OpenAI Whisper API 转写后端
//
// 注册一个 audio MediaProcessor，调用 OpenAI 兼容 /audio/transcriptions。
// 兼容 OpenAI、Groq、本地 ollama-asr 网关等所有 OpenAI 风格协议。
// ============================================================

import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import type { ASRService, TranscribeInput, TranscribeResult } from '@aalis/api-asr';
import { createProcessGateway, type ProcessService } from '@aalis/api-process';
import { createStorageGateway, isStorageUri, type StorageService } from '@aalis/api-storage';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { safeFetch } from '@aalis/util-network-guard';

export const name = '@aalis/plugin-asr-openai';
export const displayName = 'OpenAI Whisper ASR';
export const subsystem = 'media';
export const provides = ['asr'];
export const inject = { optional: ['process', 'storage'] };
export const reusable = true;

interface Cfg {
  apiKey: string;
  baseUrl: string;
  model: string;
  priority: number;
}

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', secret: true, default: '' },
  baseUrl: { type: 'string', label: 'Base URL', default: 'https://api.openai.com/v1' },
  model: { type: 'string', label: '模型', default: 'whisper-1' },
  priority: { type: 'number', label: '优先级 (越大越优先)', default: 50 },
};

const defaultConfig: Cfg = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
  priority: 50,
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
    const resp = await safeFetch(data);
    if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
    const ab = await resp.arrayBuffer();
    const ctype = resp.headers.get('content-type');
    return {
      blob: new Blob([ab], { type: ctype ?? 'application/octet-stream' }),
      filename: `audio.${guessAudioExt(data, ctype)}`,
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

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg: Cfg = { ...defaultConfig, ...(raw as Partial<Cfg>) };
  const logger = ctx.logger.child('asr-openai');

  if (!cfg.apiKey) {
    // 与 openai/embedding-openai 一致：缺必填配置时抛清晰错误（而非静默 return，
    // 否则声明了 provides:['asr'] 却不注册会触发难懂的 provides 校验错）。
    throw new Error('OpenAI Whisper ASR 需要配置 apiKey（不使用 OpenAI ASR 可在插件管理里禁用本插件）');
  }

  const proc = createProcessGateway(ctx);
  const storage = createStorageGateway(ctx);

  const asr: ASRService = {
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

  ctx.provide('asr', asr, { priority: cfg.priority });
  logger.info(`OpenAI Whisper ASR 已注册 (model=${cfg.model}, prio=${cfg.priority})`);
}
