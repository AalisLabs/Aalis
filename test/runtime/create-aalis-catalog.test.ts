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

  it('捕获 npm search 的 version（供脚手架逐包写 ^<最新>）', () => {
    const data = {
      objects: [
        { package: { name: '@aalis/plugin-workflow', description: '工作流', version: '0.3.0' } },
        { package: { name: '@aalis/plugin-openai', description: 'LLM' } }, // 无 version
      ],
    };
    const out = toPluginCatalog(data);
    expect(out[0]).toMatchObject({ name: '@aalis/plugin-workflow', version: '0.3.0' });
    expect(out[1].version).toBeUndefined();
  });

  it('剔除 *-api 契约、webui-client 前端、code-sandbox 沙箱基建（脚手架只列可装功能插件）', () => {
    const data = {
      objects: [
        { package: { name: '@aalis/plugin-openai', description: 'LLM' } },
        { package: { name: '@aalis/plugin-tools-api', description: '契约' } },
        { package: { name: '@aalis/plugin-webui-client', description: '前端' } },
        // 沙箱基建：选 code-runner 时自动带入，不应单独可选。短名带 plugin- 前缀，
        // 故 -os 不能靠锚定 /^code-sandbox/ 剔除（曾漏过 = 本次修的 bug）；-api 也一并剔。
        { package: { name: '@aalis/plugin-code-sandbox-os', description: 'OS 沙箱' } },
        { package: { name: '@aalis/plugin-code-sandbox-api', description: '沙箱契约' } },
        { package: { name: '@aalis/plugin-mcp-client', description: 'MCP 客户端' } }, // 功能插件，保留
      ],
    };
    expect(toPluginCatalog(data).map(e => e.name)).toEqual(['@aalis/plugin-openai', '@aalis/plugin-mcp-client']);
  });
});
