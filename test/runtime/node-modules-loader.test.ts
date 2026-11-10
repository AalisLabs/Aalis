import { describe, expect, it } from 'vitest';
import { declaresPlugin } from '../../packages/api-plugin-source/src/index.js';

// ════════════════════════════════════════════════════════════
// 插件识别（纯 aalis-plugin 关键词正向门）：@aalis/api-plugin-source 的 declaresPlugin，两个加载器与包管理共用
// ════════════════════════════════════════════════════════════

describe('declaresPlugin（纯 aalis-plugin 关键词正向门）', () => {
  it('收录：keywords 含 aalis-plugin（@aalis 或社区均可）', () => {
    expect(declaresPlugin({ keywords: ['aalis', 'aalis-plugin'] })).toBe(true);
    expect(declaresPlugin({ keywords: ['aalis-plugin'] })).toBe(true);
    // 以关键词为准：带 service/subsystem 的真插件本就都带 aalis-plugin，仍是关键词收录
    expect(declaresPlugin({ keywords: ['aalis-plugin'], aalis: { subsystem: 'agent' } })).toBe(true);
  });

  it('排除：无 aalis-plugin 关键词一律不加载（不再靠名前缀 / service / subsystem 回退或 marker 特判）', () => {
    // 契约 aalis-api / 前端 aalis-interface / 核心 / 工具链 / 工具库 aalis-util —— 均不带 aalis-plugin
    expect(declaresPlugin({ keywords: ['aalis', 'aalis-api'], aalis: { types: true } })).toBe(false);
    expect(declaresPlugin({ keywords: ['aalis', 'aalis-interface'], aalis: { client: true } })).toBe(false);
    expect(declaresPlugin({ keywords: ['aalis'], aalis: { core: true } })).toBe(false);
    expect(declaresPlugin({ keywords: ['aalis'], aalis: { tooling: true } })).toBe(false);
    expect(declaresPlugin({ keywords: ['aalis', 'aalis-util'], aalis: { util: true } })).toBe(false);
    // 即便声明了 service/subsystem，没有关键词也不收录（真插件务必带 aalis-plugin）
    expect(declaresPlugin({ aalis: { service: { provides: ['llm'] } } })).toBe(false);
    expect(declaresPlugin({})).toBe(false);
  });

  it('排除：普通第三方依赖（express / yaml 等）', () => {
    expect(declaresPlugin({ keywords: ['http', 'server'] })).toBe(false);
    expect(declaresPlugin({})).toBe(false);
  });

  it('读不到 package.json（undefined）、keywords 为空或不是数组：不是插件，不抛错', () => {
    expect(declaresPlugin(undefined)).toBe(false);
    expect(declaresPlugin({ keywords: [] })).toBe(false);
    expect(declaresPlugin(null)).toBe(false);
    expect(declaresPlugin({ keywords: 'aalis-plugin' })).toBe(false);
  });
});
