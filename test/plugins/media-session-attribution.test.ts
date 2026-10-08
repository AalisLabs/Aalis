import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { type LLMModel, type LLMUsageEvent, llm, metered } from '../../packages/api-llm/src/index.js';
import { type MediaService, media } from '../../packages/api-media/src/index.js';
import { type ExecResult, type ProcessService, processService } from '../../packages/api-process/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, events, provide } from '../../packages/core/src/index.js';
import mediaPlugin from '../../packages/plugin-media/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 识别与转写的记账归属：动图走 describeImage 时的帧识别、视频音轨的转写，发出的 llm:usage 都带上这条消息（这次调用）
// 所在的会话。ffmpeg 与 ffprobe 经进程服务调用：替身按命令回放输出（帧数、抽出的帧、转码的音轨写进临时目录），
// 存储是内存里的两个根，不依赖本机的 ffmpeg，不碰磁盘
// ════════════════════════════════════════════════════════════

const FRAMES = 3;
/** 带 ID3 头、够 256 字节：抽出的音轨按 mp3 直接交给模型，不再转码 */
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300)]);
const PNG = Buffer.from('frame');

/** 内存里的 tmp 与 data 两个根；进程替身写的文件也落在这里 */
function memoryStorage() {
  const files = new Map<string, Buffer>();
  const root = (name: string) => ({ name, label: name, kind: name, readable: true, writable: true, deletable: true });
  const service = {
    listRoots: () => [root('tmp'), root('data')],
    async readFile(uri: string) {
      const data = files.get(uri);
      if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return data;
    },
    async writeFile(uri: string, data: string | Buffer) {
      files.set(uri, Buffer.from(data));
    },
    async delete(uri: string) {
      for (const key of [...files.keys()]) if (key === uri || key.startsWith(`${uri}/`)) files.delete(key);
    },
  } as unknown as StorageService;
  return { files, service };
}

/** 进程替身：临时目录是 tmp 根下的一段，本地路径与地址一一对应；按命令回放 ffprobe 的帧数与 ffmpeg 写出的文件 */
function processDouble(files: Map<string, Buffer>) {
  const calls: string[] = [];
  let seq = 0;
  const uriOf = (path: string) => `tmp:${path.slice('/virtual'.length)}`;
  const done = (stdout = ''): ExecResult => ({ code: 0, signal: null, stdout, stderr: '' });
  const service = {
    async makeTempDir(prefix: string) {
      const name = `${prefix}-${seq++}`;
      return { path: `/virtual/${name}`, uri: `tmp:/${name}`, cleanup: async () => {} };
    },
    async execFile(cmd: string, args: readonly string[]) {
      calls.push(cmd);
      if (cmd === 'ffprobe') return done(String(FRAMES));
      const output = args[args.length - 1] as string;
      if (args.includes('-vn')) {
        files.set(uriOf(output), MP3);
      } else {
        for (let i = 1; i <= FRAMES; i++) {
          files.set(uriOf(output.replace('%04d', String(i).padStart(4, '0'))), PNG);
        }
      }
      return done();
    },
  } as unknown as ProcessService;
  return { calls, service };
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot() {
  const memory = memoryStorage();
  const proc = processDouble(memory.files);
  const model: LLMModel = {
    id: 'seer',
    providerId: 'fake-host',
    contextLength: 8000,
    capabilities: ['chat', 'vision', 'audio'],
    async chat() {
      return { content: '看到了', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
    },
  };
  const host = definePlugin({
    name: 'fake-host',
    provides: [processService, storage, llm],
    uses: { provide, events },
    apply({ provide, events }) {
      provide(processService, proc.service);
      provide(storage, memory.service);
      provide(llm, metered(model, events), { entryId: 'fake-host/seer' });
    },
  });
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const usages: LLMUsageEvent[] = [];
  const bound = app.bind({ events, media });
  bound.events.on('llm:usage', usage => void usages.push(usage));
  await app.plugin(host, {});
  await app.plugin(mediaPlugin, {
    video: { mode: 'frames+asr' },
    audio: { mode: 'enabled' },
    contextHistory: { enabled: false },
    senderContext: { enabled: false },
  });
  await app.plugins.idle();
  const service: MediaService | undefined = bound.media.current;
  if (!service) throw new Error(`plugin-media 没有激活：${app.plugins.getPlugin(mediaPlugin.name)?.error}`);
  return { service, usages, calls: proc.calls };
}

describe('识别与转写按消息所在的会话记账', () => {
  it('动图走 describeImage：抽出的帧交给识别模型，记账带上调用给的会话', async () => {
    const { service, usages, calls } = await boot();
    const text = await service.describeImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=', {
      sessionId: 'onebot:t:group:1',
      noCache: true,
    });
    expect(text).toBe('看到了');
    expect(calls).toEqual(['ffprobe', 'ffmpeg']);
    expect(usages).toEqual([expect.objectContaining({ purpose: '识图', sessionId: 'onebot:t:group:1' })]);
  });

  it('视频：帧识别与音轨转写都按这条消息的会话记账', async () => {
    const { service, usages, calls } = await boot();
    const message = {
      sessionId: 'onebot:t:group:2',
      platform: 'onebot',
      content: '',
      attachments: [{ kind: 'video', data: 'data:video/mp4;base64,AAAAIGZ0eXBpc29t' }],
    } as unknown as IncomingMessage;
    await service.processMessage(message);
    expect(calls).toEqual(['ffprobe', 'ffmpeg', 'ffmpeg']);
    expect(usages.map(({ purpose, sessionId }) => ({ purpose, sessionId }))).toEqual([
      { purpose: '识图', sessionId: 'onebot:t:group:2' },
      { purpose: '转写', sessionId: 'onebot:t:group:2' },
    ]);
  });
});
