// ============================================================
// @aalis/plugin-asr-openai — OpenAI Whisper API 转写后端
//
// 注册一个 audio.transcribe MediaProcessor，调用 OpenAI 兼容 /audio/transcriptions。
// 兼容 OpenAI、Groq、本地 ollama-asr 网关等所有 OpenAI 风格协议。
// ============================================================

import { Buffer } from 'node:buffer';
import type { ConfigSchema, Context } from '@aalis/core';
import type { MediaProcessor, TranscribeInput, TranscribeResult } from '@aalis/plugin-media-api';

export const name = '@aalis/plugin-asr-openai';
export const displayName = 'OpenAI Whisper ASR';
export const subsystem = 'media';
export const provides: string[] = [];
export const inject = { required: ['media'] };

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

export const defaultConfig: Cfg = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
  priority: 50,
};

async function attachmentToBlob(data: string): Promise<{ blob: Blob; filename: string }> {
  if (data.startsWith('data:')) {
    const m = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('无效 data URL');
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const ext = mime.split('/')[1]?.split(';')[0] ?? 'bin';
    return { blob: new Blob([buf as unknown as ArrayBuffer], { type: mime }), filename: `audio.${ext}` };
  }
  if (data.startsWith('file://')) {
    const fs = await import('node:fs/promises');
    const path = data.slice(7);
    const buf = await fs.readFile(path);
    const ext = path.split('.').pop() ?? 'bin';
    return { blob: new Blob([buf as unknown as ArrayBuffer]), filename: `audio.${ext}` };
  }
  if (data.startsWith('http://') || data.startsWith('https://')) {
    const resp = await fetch(data);
    if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
    const ab = await resp.arrayBuffer();
    const ext = data.split('.').pop()?.split('?')[0] ?? 'bin';
    return {
      blob: new Blob([ab], { type: resp.headers.get('content-type') ?? 'application/octet-stream' }),
      filename: `audio.${ext}`,
    };
  }
  throw new Error(`不支持的附件来源: ${data.slice(0, 32)}`);
}

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg: Cfg = { ...defaultConfig, ...(raw as Partial<Cfg>) };
  const logger = ctx.logger.child('asr-openai');

  if (!cfg.apiKey) {
    logger.warn('未配置 apiKey，插件不会注册 processor');
    return;
  }

  const processor: MediaProcessor = {
    name: `asr-openai:${cfg.model}`,
    capabilities: ['audio.transcribe'],
    priority: cfg.priority,
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const { blob, filename } = await attachmentToBlob(input.attachment.data);
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
        throw new Error(`Whisper API 失败 ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = (await resp.json()) as {
        text: string;
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      const segments = data.segments?.map(s => ({ start: s.start, end: s.end, text: s.text }));
      return { text: data.text ?? '', segments };
    },
  };

  const media = ctx.getService<{ registerProcessor: (p: MediaProcessor) => () => void }>('media');
  if (!media) {
    logger.error('media 服务不可用，跳过注册');
    return;
  }
  const dispose = media.registerProcessor(processor);
  ctx.on('dispose', () => dispose());
  logger.info(`OpenAI Whisper 转写已注册 (model=${cfg.model}, prio=${cfg.priority})`);
}
