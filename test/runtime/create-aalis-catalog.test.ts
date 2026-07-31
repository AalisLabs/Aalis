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
        { package: { name: '@aalis/plugin-llm-openai', description: 'LLM' } }, // 无 version
      ],
    };
    const out = toPluginCatalog(data);
    expect(out[0]).toMatchObject({ name: '@aalis/plugin-workflow', version: '0.3.0' });
    expect(out[1].version).toBeUndefined();
  });

  it('剔除 code-sandbox 沙箱基建（选 code-runner 时自动带入，不该单独可选）', () => {
    const data = {
      objects: [
        { package: { name: '@aalis/plugin-llm-openai', description: 'LLM' } },
        // 短名仍带 plugin- 前缀，故 -os 不能靠锚定 /^code-sandbox/ 剔除（曾漏过）
        { package: { name: '@aalis/plugin-code-sandbox-os', description: 'OS 沙箱' } },
        { package: { name: '@aalis/plugin-mcp-client', description: 'MCP 客户端' } }, // 功能插件，保留
      ],
    };
    expect(toPluginCatalog(data).map(e => e.name)).toEqual(['@aalis/plugin-llm-openai', '@aalis/plugin-mcp-client']);
  });

  it('契约/前端/工具库不必剔除——它们带的是 aalis-api / aalis-interface / aalis-util，压根不进检索结果', () => {
    // 判据是**关键词**不是包名。此前按 `/-api$/` 与 `/webui-client/` 剔名，是关键词收敛之前的
    // 遗留；收敛后即成死代码，且改名（plugin-*-api → api-*）会让按名判定整体失配。
    // 这里断言的是「即便它们真的混进来了，也不该靠包名去挡」——挡它们的是检索关键词。
    const data = {
      objects: [
        { package: { name: '@aalis/api-tools', description: '契约' } },
        { package: { name: '@aalis/plugin-webui-client', description: '前端' } },
        { package: { name: '@aalis/util-cron', description: '工具库' } },
      ],
    };
    expect(toPluginCatalog(data).map(e => e.name)).toEqual([
      '@aalis/api-tools',
      '@aalis/plugin-webui-client',
      '@aalis/util-cron',
    ]);
  });
});
