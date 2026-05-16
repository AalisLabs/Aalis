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
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigSchema, Context } from '@aalis/core';
import type { MediaProcessor, TranscribeInput, TranscribeResult } from '@aalis/plugin-media-api';

export const name = '@aalis/plugin-asr-whisper-cpp';
export const displayName = 'Whisper.cpp 本地转写';
export const subsystem = 'media';
export const provides: string[] = [];
export const inject = { required: ['media'] };

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

function exec(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => {
      stdout += d.toString();
    });
    p.stderr.on('data', d => {
      stderr += d.toString();
    });
    p.on('error', reject);
    p.on('close', code => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

async function materializeAudio(data: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (data.startsWith('file://')) {
    return { path: data.slice(7), cleanup: async () => {} };
  }
  const dir = await fs.mkdtemp(join(tmpdir(), 'aalis-whisper-'));
  let buf: Buffer;
  let ext = 'bin';
  if (data.startsWith('data:')) {
    const m = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('无效 data URL');
    buf = Buffer.from(m[2], 'base64');
    ext = m[1].split('/')[1]?.split(';')[0] ?? 'bin';
  } else if (data.startsWith('http://') || data.startsWith('https://')) {
    const resp = await fetch(data);
    if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
    buf = Buffer.from(await resp.arrayBuffer());
    ext = data.split('.').pop()?.split('?')[0] ?? 'bin';
  } else {
    throw new Error(`不支持的附件来源: ${data.slice(0, 32)}`);
  }
  const path = join(dir, `audio.${ext}`);
  await fs.writeFile(path, buf);
  return {
    path,
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** 用 ffmpeg 把任意音频转成 whisper 需要的 16kHz mono wav。 */
async function toWav16k(input: string): Promise<string> {
  const out = `${input}.16k.wav`;
  const r = await exec('ffmpeg', ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  if (r.code !== 0) throw new Error(`ffmpeg 转码失败: ${r.stderr.slice(-200)}`);
  return out;
}

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg: Cfg = { ...defaultConfig, ...(raw as Partial<Cfg>) };
  const logger = ctx.logger.child('asr-whisper-cpp');

  if (!cfg.modelPath) {
    logger.warn('未配置 modelPath，插件不会注册 processor');
    return;
  }

  const processor: MediaProcessor = {
    name: `asr-whisper-cpp:${cfg.modelPath.split('/').pop() ?? 'model'}`,
    capabilities: ['audio'],
    priority: cfg.priority,
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const local = await materializeAudio(input.attachment.data);
      try {
        const wav = await toWav16k(local.path);
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
        const r = await exec(cfg.binaryPath, args);
        if (r.code !== 0) throw new Error(`whisper-cli 失败: ${r.stderr.slice(-200)}`);
        // 读取生成的 .txt（whisper-cli 默认在输入路径旁生成 <wav>.txt）
        const txtPath = `${wav}.txt`;
        let text = '';
        try {
          text = (await fs.readFile(txtPath, 'utf-8')).trim();
        } catch {
          // 回退：直接 parse stdout
          text = r.stdout.replace(/\[[^\]]+\]/g, '').trim();
        }
        return { text };
      } finally {
        await local.cleanup();
      }
    },
  };

  const media = ctx.getService<{ registerProcessor: (p: MediaProcessor) => () => void }>('media');
  if (!media) {
    logger.error('media 服务不可用');
    return;
  }
  const dispose = media.registerProcessor(processor);
  ctx.on('dispose', () => dispose());
  logger.info(`Whisper.cpp 转写已注册 (model=${cfg.modelPath}, prio=${cfg.priority})`);
}
