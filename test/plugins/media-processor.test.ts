import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { ASRService } from '../../packages/api-asr/src/index.js';
import { type LLMModel, llm, type ModelRef } from '../../packages/api-llm/src/index.js';
import type { MediaProcessor } from '../../packages/api-media/src/index.js';
import { App, definePlugin, provide, services } from '../../packages/core/src/index.js';
import type { MediaConfigResolved, MediaServiceCaps } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import type { MessageAttachment } from '../../packages/schema-message/src/index.js';
import { ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// MediaService.pickProcessor — 模型选择
// 覆盖 issue 3：vision/audio 的 prefer 配置支持 ModelRef，能钉死「具体模型」而非只认提供者名；
// 匹配不到时确定性按 priority 回落（而非静默乱用）。无 LLM 提供者（llm.all()→[]）时只用外部注册的 processor。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

function caps(over: Partial<MediaServiceCaps> = {}): MediaServiceCaps {
  return { logger, llm: ref(), asr: ref(), sessionManager: ref(), memory: ref(), ...over };
}

const cfg = {
  vision: { maxTokens: 300, think: false },
  audio: { maxTokens: 1024, think: true },
  video: { maxTokens: 300, think: false },
} as unknown as MediaConfigResolved;

function proc(name: string, priority: number): MediaProcessor {
  return { name, capabilities: ['vision'], priority };
}

function svc(): MediaServiceImpl {
  const s = new MediaServiceImpl(caps(), cfg);
  // processor.name 模拟 llm-adapter 生成的 `llm:<provider>/<model>#<cap>` 格式
  s.registerProcessor(proc('llm:@aalis/plugin-llm-openai:main/gpt-4o#vis', 10));
  s.registerProcessor(proc('llm:@aalis/plugin-llm-deepseek:main/deepseek-vl#vis', 20));
  return s;
}

describe('MediaService.pickProcessor（模型选择 / issue 3）', () => {
  it('ModelRef {provider,model} → 精确命中对应模型（钉死具体模型）', () => {
    const modelRef: ModelRef = { provider: '@aalis/plugin-llm-openai:main', model: 'gpt-4o' };
    expect(svc().pickProcessor('vision', modelRef)?.name).toBe('llm:@aalis/plugin-llm-openai:main/gpt-4o#vis');
  });

  it('ModelRef 仅 provider → 命中该 provider', () => {
    expect(svc().pickProcessor('vision', { provider: '@aalis/plugin-llm-deepseek:main' })?.name).toBe(
      'llm:@aalis/plugin-llm-deepseek:main/deepseek-vl#vis',
    );
  });

  it('ModelRef 仅 model → 按 model 命中', () => {
    expect(svc().pickProcessor('vision', { model: 'gpt-4o' })?.name).toBe(
      'llm:@aalis/plugin-llm-openai:main/gpt-4o#vis',
    );
  });

  it('字符串 prefer → 按 processor name 精确命中（历史格式仍兼容）', () => {
    expect(svc().pickProcessor('vision', 'llm:@aalis/plugin-llm-openai:main/gpt-4o#vis')?.name).toBe(
      'llm:@aalis/plugin-llm-openai:main/gpt-4o#vis',
    );
  });

  it('无 prefer / 匹配不到 → 按 priority 确定性回落（不静默乱选）', () => {
    expect(svc().pickProcessor('vision', null)?.name).toBe('llm:@aalis/plugin-llm-deepseek:main/deepseek-vl#vis'); // 20>10
    expect(svc().pickProcessor('vision', { provider: 'nonexist' })?.name).toBe(
      'llm:@aalis/plugin-llm-deepseek:main/deepseek-vl#vis',
    );
  });

  it('无候选 processor → null', () => {
    const empty = new MediaServiceImpl(caps(), cfg);
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
    const asrSvc: ASRService = {
      transcribe: async i => ({ text: `[whisper] ${i.attachment.data}` }),
    };
    const s = new MediaServiceImpl(
      caps({
        asr: ref([{ instance: asrSvc, contextId: '@aalis/plugin-asr-whisper-cpp', priority: 5, label: 'whisper.cpp' }]),
      }),
      { ...cfg, audio: { mode: 'enabled', prefer, maxTokens: 1024, think: true } } as unknown as MediaConfigResolved,
    );
    // 一个「音频 LLM」外部 processor（模拟 llm-adapter 对 audio cap 的包装，pri 1）
    s.registerProcessor({
      name: 'llm:@aalis/plugin-llm-ollama:main/gemma#aud',
      capabilities: ['audio'],
      priority: 1,
      transcribe: async i => ({
        text: `[llm] ${i.attachment.data}`,
        meta: { processor: 'llm:@aalis/plugin-llm-ollama:main/gemma#aud' },
      }),
    });
    return s;
  }

  it('listProcessors(audio) = 音频 LLM ∪ asr 桥（whisper 进同池）', () => {
    const names = audioSvc()
      .listProcessors('audio')
      .map(p => p.name);
    expect(names).toContain('asr:@aalis/plugin-asr-whisper-cpp');
    expect(names).toContain('llm:@aalis/plugin-llm-ollama:main/gemma#aud');
  });

  it('asr 桥 transcribe 转调 asr 服务，并盖上桥接器 processor 名（meta.processor）', async () => {
    const bridge = audioSvc()
      .listProcessors('audio')
      .find(p => p.name.startsWith('asr:'));
    const r = await bridge?.transcribe?.({ attachment: audioAtt('X') });
    expect(r?.text).toBe('[whisper] X');
    expect(r?.meta?.processor).toBe('asr:@aalis/plugin-asr-whisper-cpp');
  });

  it('prefer 钉死 whisper → transcribe() 真用 whisper（不是 LLM）', async () => {
    expect(await audioSvc('asr:@aalis/plugin-asr-whisper-cpp').transcribe(audioAtt('Y'))).toBe('[whisper] Y');
  });

  it('prefer 钉死 音频 LLM → transcribe() 真用 LLM（曾经的死代码现在通了）', async () => {
    expect(await audioSvc('llm:@aalis/plugin-llm-ollama:main/gemma#aud').transcribe(audioAtt('Z'))).toBe('[llm] Z');
  });

  it('无 prefer → 按 priority 确定性回落（whisper pri5 > llm pri1）', async () => {
    expect(await audioSvc().transcribe(audioAtt('W'))).toBe('[whisper] W');
  });

  it('真·scanLLMProcessors 路径：声明 audio 能力的 LLM 自动进池、带 transcribe、可被 prefer 钉中（非手搓）', () => {
    // 一个声明 audio 能力的真 LLM 服务（chat 被 transcribe 内部调用；本测只验「进池 + 选中」，不触发到 chat/ffmpeg）
    const audioLLM = {
      id: 'gemma:e4b',
      capabilities: ['audio'],
      chat: async () => ({ content: '' }),
    } as unknown as LLMModel;
    const s = new MediaServiceImpl(
      caps({
        llm: ref([
          { instance: audioLLM, contextId: '@aalis/plugin-llm-ollama:main/gemma', priority: 0, label: 'ollama' },
        ]),
      }),
      { ...cfg, audio: { mode: 'enabled', maxTokens: 1024, think: true } } as unknown as MediaConfigResolved,
    );
    const llmProc = s.listProcessors('audio').find(p => p.name.startsWith('llm:'));
    expect(llmProc).toBeDefined(); // scanLLMProcessors 确实把 audio LLM 包进了 audio 池
    expect(typeof llmProc?.transcribe).toBe('function'); // 真 proc 带 transcribe（曾经那段「死代码」的归宿）
    // 下拉项 value = 此 name，pickProcessor 也按 name 命中 → 名字一致由同一 listProcessors 来源构造保证
    expect(s.pickProcessor('audio', llmProc?.name)?.name).toBe(llmProc?.name);
  });
});

// ════════════════════════════════════════════════════════════
// LLM processor 缓存跟随偏好切换：LLM processor 的 priority 恒为 0，vision.prefer 留空时
// pickProcessor 靠稳定排序取 llm.all() 的先后（偏好 > 优先级 > 注册顺序）。缓存签名曾把条目
// 排序后拼接，偏好一换签名不变、缓存不重建，自动选择停在旧模型上。
// llm.all() 取自真 App 容器 + services.prefer，不手搓顺序。
// ════════════════════════════════════════════════════════════

describe('MediaService LLM processor 缓存跟随 llm 偏好切换', () => {
  const llmProvider = (name: string) =>
    definePlugin({
      name,
      provides: [llm],
      uses: { provide },
      apply(c) {
        c.provide(llm, {
          id: name,
          providerId: name,
          contextLength: 8192,
          capabilities: ['vision'],
          chat: async () => ({ content: '' }),
        } as unknown as LLMModel);
      },
    });

  it('偏好切到 B 后，prefer 留空的自动选择跟着换到 B', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    try {
      await app.plugin(llmProvider('zz-llm-a'));
      await app.plugin(llmProvider('zz-llm-b'));
      await app.plugins.idle();
      const host = app.bind({ llm, services });
      const s = new MediaServiceImpl(caps({ llm: host.llm }), cfg);
      // 注册顺序 A 在前；这一次调用同时建起缓存
      expect(s.pickProcessor('vision')?.name).toBe('llm:zz-llm-a#vision');
      expect(host.services.prefer(llm, 'zz-llm-b')).toBe(true);
      expect(host.llm.all()[0]?.contextId, '前提：容器已按偏好把 B 排到最前').toBe('zz-llm-b');
      expect(s.pickProcessor('vision')?.name).toBe('llm:zz-llm-b#vision');
    } finally {
      await app.stop();
    }
  });
});
