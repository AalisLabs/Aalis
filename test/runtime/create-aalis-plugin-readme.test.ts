import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { optionalNames, requiredNames } from '../../packages/core/src/composition/descriptors.js';
import * as core from '../../packages/core/src/index.js';
import { renderIndexTs, renderPackageJson, renderReadme } from '../../packages/create-aalis-plugin/src/cli.js';

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
  it('全部八种功能组合：生成清单与实际定义依赖对账，空功能也声明 logger', () => {
    const imports: Record<string, unknown> = {
      '@aalis/core': core,
      '@aalis/api-tools': { tools },
      '@aalis/api-commands': { commands },
      '@aalis/api-webui': { webuiServer },
    };
    for (let mask = 0; mask < 8; mask++) {
      const a = answers({ tool: Boolean(mask & 1), command: Boolean(mask & 2), webui: Boolean(mask & 4) });
      const source = ts.transpileModule(renderIndexTs(a), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const exports: { default?: core.PluginDefinition } = {};
      // 执行脚手架自己的模块定义（不执行 apply），使用真实契约描述符验证生成清单。
      new Function('require', 'exports', source)((name: string) => {
        if (!(name in imports)) throw new Error(`模板新增依赖未纳入测试: ${name}`);
        return imports[name];
      }, exports);
      expect(exports.default).toBeDefined();
      const declared = JSON.parse(renderPackageJson(a)).aalis.service;
      expect(declared.required).toEqual(['logger']);
      expect(declared.required).toEqual(requiredNames(exports.default!.uses ?? {}));
      expect(declared.optional ?? []).toEqual(optionalNames(exports.default!.uses ?? {}));
    }
  });

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
