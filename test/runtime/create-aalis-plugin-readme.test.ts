import { describe, expect, it } from 'vitest';
import { renderIndexTs, renderReadme } from '../../packages/create-aalis-plugin/src/cli.js';

// README 与 index 必须同源：uses 键集合一致，未勾选的能力不得出现在 README。

function usesKeys(source: string): string[] {
  const m = source.match(/\buses:\s*\{([^}]+)\}/);
  if (!m) throw new Error(`未找到 uses 对象：${source.slice(0, 200)}`);
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split(':')[0].trim())
    .sort();
}

const answers = (features: { tool: boolean; command: boolean; webui: boolean }) => ({
  packageName: 'aalis-plugin-demo',
  displayName: '演示',
  features,
});

const COMBOS = [
  { tool: false, command: false, webui: false },
  { tool: true, command: false, webui: false },
  { tool: false, command: true, webui: false },
  { tool: true, command: true, webui: true },
] as const;

describe('create-aalis-plugin README 与 index 同源', () => {
  it('每种勾选组合：README 列出的 uses 键 == index 的 uses 键', () => {
    for (const features of COMBOS) {
      const a = answers(features);
      expect(usesKeys(renderReadme(a)), JSON.stringify(features)).toEqual(usesKeys(renderIndexTs(a)));
    }
  });

  it('README 不再列出未勾选的能力，optional(tools) 等措辞与 index 一致', () => {
    const none = renderReadme(answers({ tool: false, command: false, webui: false }));
    expect(none).not.toContain('optional(tools)');
    expect(none).not.toContain('optional(commands)');
    expect(none).not.toContain('optional(webuiServer)');
    expect(none).not.toContain('@aalis/api-tools');
    expect(none).not.toContain('@aalis/api-commands');
    expect(none).not.toContain('@aalis/api-webui');
    expect(none).not.toContain('配置原样透传给 apply');

    const toolOnly = renderReadme(answers({ tool: true, command: false, webui: false }));
    expect(toolOnly).toContain('uses: { tools: optional(tools) }');
    expect(toolOnly).not.toContain('optional(commands)');
    expect(toolOnly).not.toContain('optional(webuiServer)');

    const indexTool = renderIndexTs(answers({ tool: true, command: false, webui: false }));
    expect(indexTool).toContain('tools: optional(tools)');
  });
});
