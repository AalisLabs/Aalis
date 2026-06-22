import type { Context, Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { ModelRef } from '../../packages/plugin-llm-api/src/index.js';
import type { MediaConfigResolved } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import type { MediaProcessor } from '../../packages/plugin-media-api/src/index.js';
import type { MessageAttachment } from '../../packages/plugin-message-api/src/index.js';

// ════════════════════════════════════════════════════════════
// MediaService.pickProcessor — 模型选择
// 覆盖 issue 3：vision/audio 的 prefer 配置支持 ModelRef，能钉死「具体模型」而非只认提供者名；
// 匹配不到时确定性按 priority 回落（而非静默乱用）。无 LLM 服务（getAllServices→[]）时只用外部注册的 processor。
// ════════════════════════════════════════════════════════════

const ctx = { getAllServices: () => [], getServiceEntries: () => [] } as unknown as Context;
const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;
const cfg = {
  vision: { maxTokens: 300, think: false },
  audio: { maxTokens: 1024, think: true },
  video: { maxTokens: 300, think: false },
} as unknown as MediaConfigResolved;

function proc(name: string, priority: number): MediaProcessor {
  return { name, capabilities: ['vision'], priority };
}

function svc(): MediaServiceImpl {
  const s = new MediaServiceImpl(ctx, logger, cfg);
  // processor.name 模拟 llm-adapter 生成的 `llm:<provider>/<model>#<capShort>` 格式
  s.registerProcessor(proc('llm:@aalis/plugin-openai:main/gpt-4o#vis', 10));
  s.registerProcessor(proc('llm:@aalis/plugin-deepseek:main/deepseek-vl#vis', 20));
  return s;
}

describe('MediaService.pickProcessor（模型选择 / issue 3）', () => {
  it('ModelRef {provider,model} → 精确命中对应模型（钉死具体模型）', () => {
    const ref: ModelRef = { provider: '@aalis/plugin-openai:main', model: 'gpt-4o' };
    expect(svc().pickProcessor('vision', ref)?.name).toBe('llm:@aalis/plugin-openai:main/gpt-4o#vis');
  });

  it('ModelRef 仅 provider → 命中该 provider', () => {
    expect(svc().pickProcessor('vision', { provider: '@aalis/plugin-deepseek:main' })?.name).toBe(
      'llm:@aalis/plugin-deepseek:main/deepseek-vl#vis',
    );
  });

  it('ModelRef 仅 model → 按 model 命中', () => {
    expect(svc().pickProcessor('vision', { model: 'gpt-4o' })?.name).toBe('llm:@aalis/plugin-openai:main/gpt-4o#vis');
  });

  it('字符串 prefer → 按 processor name 精确命中（历史格式仍兼容）', () => {
    expect(svc().pickProcessor('vision', 'llm:@aalis/plugin-openai:main/gpt-4o#vis')?.name).toBe(
      'llm:@aalis/plugin-openai:main/gpt-4o#vis',
    );
  });

  it('无 prefer / 匹配不到 → 按 priority 确定性回落（不静默乱选）', () => {
    expect(svc().pickProcessor('vision', null)?.name).toBe('llm:@aalis/plugin-deepseek:main/deepseek-vl#vis'); // 20>10
    expect(svc().pickProcessor('vision', { provider: 'nonexist' })?.name).toBe(
      'llm:@aalis/plugin-deepseek:main/deepseek-vl#vis',
    );
  });

  it('无候选 processor → null', () => {
    const empty = new MediaServiceImpl(ctx, logger, cfg);
    expect(empty.pickProcessor('vision', { model: 'gpt-4o' })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// 音频统一池：Whisper/ASR（核心 asr 服务桥接）与「音频 LLM」同池，
// pickProcessor('audio', prefer) 统一仲裁 → 保证「选到的后端真被调用」。
// ════════════════════════════════════════════════════════════

describe('MediaService 音频统一池（asr 桥 + 音频 LLM 一个池）', () => {
  const audioAtt = (data: string) => ({ kind: 'audio', data }) as unknown as MessageAttachment;

  function audioSvc(prefer?: string): MediaServiceImpl {
    // 一个 asr provider（whisper.cpp，pri 5）→ 被桥成 cap='audio' 的 processor
    const asrSvc = {
      transcribe: async (i: { attachment: MessageAttachment }) => ({ text: `[whisper] ${i.attachment.data}` }),
    };
    const audioCtx = {
      getAllServices: () => [],
      getServiceEntries: (name: string) =>
        name === 'asr'
          ? [{ instance: asrSvc, contextId: '@aalis/plugin-asr-whisper-cpp', priority: 5, label: 'whisper.cpp' }]
          : [],
    } as unknown as Context;
    const s = new MediaServiceImpl(audioCtx, logger, {
      ...cfg,
      audio: { mode: 'enabled', prefer, maxTokens: 1024, think: true },
    } as unknown as MediaConfigResolved);
    // 一个「音频 LLM」外部 processor（模拟 llm-adapter 对 audio cap 的包装，pri 1）
    s.registerProcessor({
      name: 'llm:@aalis/plugin-ollama:main/gemma#aud',
      capabilities: ['audio'],
      priority: 1,
      transcribe: async i => ({
        text: `[llm] ${i.attachment.data}`,
        meta: { processor: 'llm:@aalis/plugin-ollama:main/gemma#aud' },
      }),
    });
    return s;
  }

  it('listProcessors(audio) = 音频 LLM ∪ asr 桥（whisper 进同池）', () => {
    const names = audioSvc()
      .listProcessors('audio')
      .map(p => p.name);
    expect(names).toContain('asr:@aalis/plugin-asr-whisper-cpp');
    expect(names).toContain('llm:@aalis/plugin-ollama:main/gemma#aud');
  });

  it('asr 桥 transcribe 转调 asr 服务，并盖上桥接器 processor 名（meta.processor）', async () => {
    const bridge = audioSvc()
      .listProcessors('audio')
      .find(p => p.name.startsWith('asr:'));
    const r = await bridge?.transcribe?.({ attachment: audioAtt('X') }, ctx);
    expect(r?.text).toBe('[whisper] X');
    expect(r?.meta?.processor).toBe('asr:@aalis/plugin-asr-whisper-cpp');
  });

  it('prefer 钉死 whisper → transcribe() 真用 whisper（不是 LLM）', async () => {
    expect(await audioSvc('asr:@aalis/plugin-asr-whisper-cpp').transcribe(audioAtt('Y'))).toBe('[whisper] Y');
  });

  it('prefer 钉死 音频 LLM → transcribe() 真用 LLM（曾经的死代码现在通了）', async () => {
    expect(await audioSvc('llm:@aalis/plugin-ollama:main/gemma#aud').transcribe(audioAtt('Z'))).toBe('[llm] Z');
  });

  it('无 prefer → 按 priority 确定性回落（whisper pri5 > llm pri1）', async () => {
    expect(await audioSvc().transcribe(audioAtt('W'))).toBe('[whisper] W');
  });

  it('真·scanLLMProcessors 路径：声明 audio 能力的 LLM 自动进池、带 transcribe、可被 prefer 钉中（非手搓）', () => {
    // 一个声明 audio 能力的真 LLM 服务（chat 被 transcribe 内部调用；本测只验「进池 + 选中」，不触发到 chat/ffmpeg）
    const audioLLM = { id: 'gemma:e4b', capabilities: ['audio'], chat: async () => ({ content: '' }) };
    const llmCtx = {
      getAllServices: (n: string) =>
        n === 'llm' ? [{ instance: audioLLM, contextId: '@aalis/plugin-ollama:main/gemma', label: 'ollama' }] : [],
      getServiceEntries: () => [],
    } as unknown as Context;
    const s = new MediaServiceImpl(llmCtx, logger, {
      ...cfg,
      audio: { mode: 'enabled', maxTokens: 1024, think: true },
    } as unknown as MediaConfigResolved);
    const llmProc = s.listProcessors('audio').find(p => p.name.startsWith('llm:'));
    expect(llmProc).toBeDefined(); // scanLLMProcessors 确实把 audio LLM 包进了 audio 池
    expect(typeof llmProc?.transcribe).toBe('function'); // 真 proc 带 transcribe（曾经那段「死代码」的归宿）
    // 下拉项 value = 此 name，pickProcessor 也按 name 命中 → 名字一致由同一 listProcessors 来源构造保证
    expect(s.pickProcessor('audio', llmProc?.name)?.name).toBe(llmProc?.name);
  });
});
