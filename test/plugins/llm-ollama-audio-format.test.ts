import { afterEach, describe, expect, it } from 'vitest';
import { type ChatModelRequest, type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { App } from '../../packages/core/src/index.js';
import ollamaPlugin from '../../packages/plugin-llm-ollama/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 带音频的请求走 Ollama 的 OpenAI 兼容接口，input_audio 的 format 按 data URL 里写明的音频类型给：只收兼容接口认得的 wav 与
// mp3，别的类型与不是 data URL 的（本地路径、链接、裸 base64）在发请求前报错、写明是哪种，不猜成 wav（猜错时上游只回一句解码
// 失败，看不出是格式的事）。
// fetch 用替身，不连本机的 Ollama。
// ════════════════════════════════════════════════════════════

const realFetch = globalThis.fetch;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  globalThis.fetch = realFetch;
});

/** 桩 fetch：报一个能听音频的模型；兼容接口的请求体记进 sent，回一句话 */
async function start(): Promise<{ model: LLMModel; sent: Array<{ messages: Array<{ content: unknown }> }> }> {
  const sent: Array<{ messages: Array<{ content: unknown }> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/api/tags') return Response.json({ models: [{ name: 'zz-audio:1' }] });
    if (pathname === '/api/show') return Response.json({ capabilities: ['completion', 'audio'] });
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: '听到了' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  const app = new App({ name: 'T', logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  await app.plugin(ollamaPlugin, { baseUrl: 'http://127.0.0.1:11434' });
  await app.plugins.idle();
  const model = app.bind({ llm }).llm.list()[0]?.use;
  if (!model) throw new Error('未注册出 llm model entry');
  return { model, sent };
}

const ask = (audio: string): ChatModelRequest => ({ messages: [{ role: 'user', content: '听听', audios: [audio] }] });

describe('Ollama 兼容接口的音频格式', () => {
  it.each([
    ['data:audio/mpeg;base64,AAAA', 'mp3'],
    ['data:audio/wav;base64,AAAA', 'wav'],
    // 类型后面可以带参数（RFC 2397）
    ['data:audio/wav;rate=16000;base64,AAAA', 'wav'],
  ])('%s：format 是 %s', async (audio, format) => {
    const { model, sent } = await start();
    await model.chat(ask(audio));
    expect(sent[0]?.messages[0]?.content).toEqual([
      { type: 'input_audio', input_audio: { data: 'AAAA', format } },
      { type: 'text', text: '听听' },
    ]);
  });

  const DATA_URL_ONLY = 'Ollama 兼容接口的音频只收 data:audio/<格式>;base64, 形式（插件不读本地路径与链接）';
  it.each([
    ['认不出的音频类型', 'data:audio/flac;base64,AAAA', 'Ollama 兼容接口不接受 flac 音频'],
    ['兼容接口不认的 ogg', 'data:audio/ogg;base64,AAAA', 'Ollama 兼容接口不接受 ogg 音频'],
    ['兼容接口不认的 mp4', 'data:audio/mp4;base64,AAAA', 'Ollama 兼容接口不接受 mp4 音频'],
    ['不带 data: 前缀', 'AAAA', DATA_URL_ONLY],
    ['本地路径', '/tmp/zz-voice.mp3', DATA_URL_ONLY],
    ['file 地址', 'file:///tmp/zz-voice.mp3', DATA_URL_ONLY],
    ['网址', 'https://example.invalid/zz-voice.mp3', DATA_URL_ONLY],
  ])('%s：发请求前报错，写明是哪种，不猜成 wav', async (_label, audio, error) => {
    const { model, sent } = await start();
    await expect(model.chat(ask(audio))).rejects.toThrow(error);
    expect(sent, '仍然发出了请求').toEqual([]);
  });
});
