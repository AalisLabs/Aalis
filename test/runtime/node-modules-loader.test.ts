import { describe, expect, it } from 'vitest';
import { isLoadablePlugin } from '../../packages/runtime/src/node-modules-loader.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — node_modules 加载器的插件识别逻辑（独立部署）
// ════════════════════════════════════════════════════════════

describe('isLoadablePlugin（哪些已装依赖算可加载插件）', () => {
  it('收录：带 aalis-plugin 关键词的包', () => {
    expect(isLoadablePlugin('@aalis/plugin-openai', { keywords: ['aalis-plugin'] })).toBe(true);
    expect(isLoadablePlugin('community-aalis-plugin-x', { keywords: ['aalis-plugin'] })).toBe(true);
  });

  it('收录：@aalis/plugin-* 名（即使无关键词，如 package-manager）', () => {
    expect(isLoadablePlugin('@aalis/plugin-package-manager', {})).toBe(true);
  });

  it('收录：声明了 aalis.service / aalis.subsystem 的包', () => {
    expect(isLoadablePlugin('x', { aalis: { service: { provides: ['llm'] } } })).toBe(true);
    expect(isLoadablePlugin('x', { aalis: { subsystem: 'agent' } })).toBe(true);
  });

  it('排除：核心 / 契约 / 前端 / 工具链标记（即使名匹配 @aalis/plugin-*）', () => {
    expect(isLoadablePlugin('@aalis/core', { aalis: { core: true } })).toBe(false);
    expect(isLoadablePlugin('@aalis/plugin-webui-api', { aalis: { types: true }, keywords: ['aalis-plugin'] })).toBe(
      false,
    ); // types 优先于关键词/名
    expect(isLoadablePlugin('@aalis/plugin-webui-client', { aalis: { client: true } })).toBe(false);
    expect(isLoadablePlugin('@aalis/runtime', { aalis: { tooling: true } })).toBe(false);
  });

  it('排除：普通第三方依赖（express / yaml 等）', () => {
    expect(isLoadablePlugin('express', { keywords: ['http', 'server'] })).toBe(false);
    expect(isLoadablePlugin('yaml', {})).toBe(false);
  });
});
