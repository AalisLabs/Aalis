import { describe, expect, it } from 'vitest';
import { isLoadablePlugin } from '../../packages/runtime/src/node-modules-loader.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — node_modules 加载器的插件识别（纯 aalis-plugin 关键词正向门）
// ════════════════════════════════════════════════════════════

describe('isLoadablePlugin（纯 aalis-plugin 关键词正向门）', () => {
  it('收录：keywords 含 aalis-plugin（@aalis 或社区均可）', () => {
    expect(isLoadablePlugin({ keywords: ['aalis', 'aalis-plugin'] })).toBe(true);
    expect(isLoadablePlugin({ keywords: ['aalis-plugin'] })).toBe(true);
    // 以关键词为准：带 service/subsystem 的真插件本就都带 aalis-plugin，仍是关键词收录
    expect(isLoadablePlugin({ keywords: ['aalis-plugin'], aalis: { subsystem: 'agent' } })).toBe(true);
  });

  it('排除：无 aalis-plugin 关键词一律不加载（不再靠名前缀 / service / subsystem 回退或 marker 特判）', () => {
    // 契约 aalis-api / 前端 aalis-interface / 核心 / 工具链 / 工具库 aalis-util —— 均不带 aalis-plugin
    expect(isLoadablePlugin({ keywords: ['aalis', 'aalis-api'], aalis: { types: true } })).toBe(false);
    expect(isLoadablePlugin({ keywords: ['aalis', 'aalis-interface'], aalis: { client: true } })).toBe(false);
    expect(isLoadablePlugin({ keywords: ['aalis'], aalis: { core: true } })).toBe(false);
    expect(isLoadablePlugin({ keywords: ['aalis'], aalis: { tooling: true } })).toBe(false);
    expect(isLoadablePlugin({ keywords: ['aalis', 'aalis-util'], aalis: { util: true } })).toBe(false);
    // 即便声明了 service/subsystem，没有关键词也不收录（真插件务必带 aalis-plugin）
    expect(isLoadablePlugin({ aalis: { service: { provides: ['llm'] } } })).toBe(false);
    expect(isLoadablePlugin({})).toBe(false);
  });

  it('排除：普通第三方依赖（express / yaml 等）', () => {
    expect(isLoadablePlugin({ keywords: ['http', 'server'] })).toBe(false);
    expect(isLoadablePlugin({})).toBe(false);
  });
});
