import type { Context, Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { ModelRef } from '../../packages/plugin-llm-api/src/index.js';
import type { MediaConfigResolved } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import type { MediaProcessor } from '../../packages/plugin-media-api/src/index.js';

// ════════════════════════════════════════════════════════════
// MediaService.pickProcessor — 模型选择
// 覆盖 issue 3：vision/audio 的 prefer 配置支持 ModelRef，能钉死「具体模型」而非只认提供者名；
// 匹配不到时确定性按 priority 回落（而非静默乱用）。无 LLM 服务（getAllServices→[]）时只用外部注册的 processor。
// ════════════════════════════════════════════════════════════

const ctx = { getAllServices: () => [] } as unknown as Context;
const logger = { info: () => {} } as unknown as Logger;
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
