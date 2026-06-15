import { describe, expect, it } from 'vitest';
import { toPluginCatalog } from '../../packages/create-aalis/src/cli.js';

// ════════════════════════════════════════════════════════════
// create-aalis — init 时 live 查 npm 的目录解析（官方/社区标注）
// ════════════════════════════════════════════════════════════

describe('toPluginCatalog（npm search → 插件目录）', () => {
  it('映射 name/description + @aalis scope 判官方', () => {
    const data = {
      objects: [
        { package: { name: '@aalis/plugin-office', description: 'Office 文档' } },
        { package: { name: 'someone-aalis-plugin-fun' } }, // 社区，无描述
      ],
    };
    expect(toPluginCatalog(data)).toEqual([
      { name: '@aalis/plugin-office', description: 'Office 文档', official: true },
      { name: 'someone-aalis-plugin-fun', description: '', official: false },
    ]);
  });

  it('空响应返回空数组（离线/失败降级安全）', () => {
    expect(toPluginCatalog({})).toEqual([]);
    expect(toPluginCatalog({ objects: [] })).toEqual([]);
  });

  it('剔除 *-api 契约与 webui-client 前端（脚手架只列可装功能插件）', () => {
    const data = {
      objects: [
        { package: { name: '@aalis/plugin-openai', description: 'LLM' } },
        { package: { name: '@aalis/plugin-tools-api', description: '契约' } },
        { package: { name: '@aalis/plugin-webui-client', description: '前端' } },
        { package: { name: '@aalis/plugin-mcp-client', description: 'MCP 客户端' } }, // 功能插件，保留
      ],
    };
    expect(toPluginCatalog(data).map(e => e.name)).toEqual(['@aalis/plugin-openai', '@aalis/plugin-mcp-client']);
  });
});
