import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { ownHostConfig } from '../../packages/api-host-config/src/index.js';
import { sessionFields } from '../../packages/api-session-settings/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type FramePageDefinition, type PageHandle, webuiServer } from '../../packages/api-webui/src/index.js';
import { optionalNames, requiredNames } from '../../packages/core/src/composition/descriptors.js';
import * as core from '../../packages/core/src/index.js';
import {
  generate,
  renderIndexTs,
  renderPackageJson,
  renderReadme,
} from '../../packages/create-aalis-plugin/src/cli.js';
import { checkPage } from '../../packages/plugin-webui-server/src/page-check.js';
import { createPageRegistry } from '../../packages/plugin-webui-server/src/pages.js';
import { defineConfig } from '../../packages/schema-config/src/index.js';
import { TextError, toSource } from '../../packages/schema-i18n/src/index.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';

// README 与 index 必须同源：uses 键集合一致，未勾选的能力不得出现在 README。生成的示例页面过 webui-server 登记时的质量门槛；
// 选了自带前端时生成的插件包能被 webui-server 登记：包根名字对得上、webui/ 与入口都在。

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

type Webui = false | 'declarative' | 'frame';

const answers = (features: { tool: boolean; command: boolean; webui: Webui; sessionSetting: boolean }) => ({
  packageName: 'aalis-plugin-demo',
  displayName: '演示',
  sourceLanguage: 'zh-CN' as const,
  features,
});
/** 中日韩文字 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 生成时向源查到的版本 */
const VERSIONS = {
  '@aalis/core': '0.19.1',
  '@aalis/api-tools': '0.9.0',
  '@aalis/api-commands': '0.8.0',
  '@aalis/api-webui': '0.12.0',
  '@aalis/api-session-settings': '0.1.0',
  '@aalis/api-host-config': '0.2.0',
  '@aalis/schema-config': '0.16.0',
  '@aalis/schema-i18n': '0.1.0',
};

const COMBOS = [
  { tool: false, command: false, webui: false, sessionSetting: false },
  { tool: true, command: false, webui: false, sessionSetting: false },
  { tool: false, command: true, webui: false, sessionSetting: false },
  { tool: true, command: true, webui: 'declarative', sessionSetting: false },
  { tool: false, command: false, webui: 'frame', sessionSetting: false },
  { tool: true, command: false, webui: false, sessionSetting: true },
  { tool: false, command: false, webui: false, sessionSetting: true },
] as const;

const quiet = () => {};
const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 生成到临时目录里，目录名即包名的最后一段 */
async function generated(a: ReturnType<typeof answers>): Promise<string> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-scaffold-')));
  dirs.push(base);
  const dir = join(base, a.packageName);
  await generate(dir, a, VERSIONS);
  return dir;
}

describe('create-aalis-plugin README 与 index 同源', () => {
  it('全部二十四种功能组合：生成清单与实际定义依赖对账，空功能也声明 logger', () => {
    const imports: Record<string, unknown> = {
      '@aalis/core': core,
      '@aalis/api-tools': { tools },
      '@aalis/api-commands': { commands },
      '@aalis/api-webui': { webuiServer },
      '@aalis/api-session-settings': { sessionFields },
      '@aalis/api-host-config': { ownHostConfig },
      '@aalis/schema-config': { defineConfig },
      '@aalis/schema-i18n': { TextError },
      // 生成的字典另有一份文件，这里只核清单：t 回键名即可
      './texts.js': { t: (key: string) => key },
    };
    for (let mask = 0; mask < 8; mask++) {
      for (const webui of [false, 'declarative', 'frame'] as const) {
        const a = answers({
          tool: Boolean(mask & 1),
          command: Boolean(mask & 2),
          webui,
          sessionSetting: Boolean(mask & 4),
        });
        const source = ts.transpileModule(renderIndexTs(a), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const exports: { default?: core.PluginDefinition } = {};
        // 执行脚手架自己的模块定义（不执行 apply），使用真实契约描述符验证生成清单。CommonJS 里写不出 import.meta，
        // 换成一个地址：这里只核清单，不登记页面
        new Function('require', 'exports', source.replaceAll('import.meta.url', "'file:///zz/index.js'"))(
          (name: string) => {
            if (!(name in imports)) throw new Error(`模板新增依赖未纳入测试: ${name}`);
            return imports[name];
          },
          exports,
        );
        expect(exports.default).toBeDefined();
        const declared = JSON.parse(renderPackageJson(a, VERSIONS)).aalis.service;
        expect(declared.required).toEqual(a.features.sessionSetting ? ['logger', 'config'] : ['logger']);
        expect(declared.required).toEqual(requiredNames(exports.default!.uses ?? {}));
        expect(declared.optional ?? []).toEqual(optionalNames(exports.default!.uses ?? {}));
      }
    }
  });

  it('勾了 webui：apply 登记的示例页面过登记时的质量门槛，数据源给出键值', async () => {
    const dir = await generated({
      ...answers({ tool: false, command: false, webui: 'declarative', sessionSetting: false }),
      packageName: 'zz-declarative',
    });
    const { default: plugin } = (await import(join(dir, 'src/index.ts'))) as { default: core.PluginDefinition };
    const pages: unknown[] = [];
    const webui = { definePage: (page: unknown) => void pages.push(page) };
    await (plugin.apply as (caps: unknown) => unknown)({ logger: fixedRef(logger), webui: fixedRef(webui) });
    expect(pages).toHaveLength(1);
    expect(checkPage(pages[0])).toMatchObject({ ok: true, page: { kind: 'declarative' } });
    const [info] = (pages[0] as { content: Array<{ data: () => unknown }> }).content;
    expect(toSource(info.data())).toEqual([{ label: '提示', value: '这是 演示 插件的示例信息面板。' }]);
  });

  it('页面用自带前端：生成 webui/ 的入口与脚本，files 带上 webui；登记成插件前端页面，webui-server 找得到包根与入口；删除动作删一条并通知重取', async () => {
    const a = answers({ tool: false, command: false, webui: 'frame', sessionSetting: false });
    const dir = await generated(a);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).files).toEqual(['dist', 'webui']);
    const html = readFileSync(join(dir, 'webui/index.html'), 'utf-8');
    expect(html).toContain('<link rel="stylesheet" href="/frames/_base/frame.css" />');
    expect(html).toContain('<script type="module" src="main.js"></script>');
    expect(readFileSync(join(dir, 'webui/main.js'), 'utf-8')).toContain(
      "import { connect } from '/frames/_base/frame.js';",
    );
    expect(renderReadme(a)).toContain('## 插件前端');

    const { default: plugin } = (await import(join(dir, 'src/index.ts'))) as { default: core.PluginDefinition };
    const pages: FramePageDefinition[] = [];
    const invalidated: unknown[][] = [];
    const handle: PageHandle = { invalidate: (...args) => void invalidated.push(args) };
    const webui = {
      definePage(page: FramePageDefinition) {
        pages.push(page);
        return handle;
      },
    };
    await (plugin.apply as (caps: unknown) => unknown)({ logger: fixedRef(logger), webui: fixedRef(webui) });
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(checkPage(page)).toMatchObject({ ok: true, page: { kind: 'frame', placement: 'plugin' } });

    const errors: unknown[] = [];
    const registry = createPageRegistry({
      logger: { ...logger, error: (...args: unknown[]) => void errors.push(args) } as never,
      send: quiet,
      sessions: ref(),
      signFile: () => undefined,
    });
    registry.addPage(page, a.packageName);
    expect(errors).toEqual([]);
    const src = registry.views()[0]?.frame?.src ?? '';
    expect(src).toMatch(/^\/frames\/[\w-]{22}\/index\.html$/);
    expect(registry.frameDir(src.split('/')[2])).toBe(join(dir, 'webui'));
    registry.dispose();

    const ctx = { caller: { platform: 'webui', userId: 'owner' } } as never;
    const items = () => page.sources?.items.data({ input: undefined as never, ctx });
    expect(items()).toEqual(['示例条目一', '示例条目二', '示例条目三']);
    const remove = page.actions?.remove;
    expect(remove).toMatchObject({ effect: 'destructive', input: { item: { type: 'string', required: true } } });
    expect(toSource(await remove?.handler({ input: { item: '示例条目一' } as never, ctx }))).toBe('已删除 示例条目一');
    expect(items()).toEqual(['示例条目二', '示例条目三']);
    expect(invalidated).toEqual([['items']]);
    expect(() => remove?.handler({ input: { item: '示例条目一' } as never, ctx })).toThrow('没有这一条：示例条目一');
  });

  it('插件前端的入口页不写死语言与文字（标题是显示名）；脚本不含中日韩文字，按钮、状态与空列表的文字经 frame.t 取', async () => {
    const dir = await generated({
      ...answers({ tool: false, command: false, webui: 'frame', sessionSetting: false }),
      packageName: 'zz-frame-texts',
    });
    const html = readFileSync(join(dir, 'webui/index.html'), 'utf-8');
    expect(html).not.toContain('lang=');
    expect(html.replace('<title>演示</title>', '')).not.toMatch(CJK);
    const script = readFileSync(join(dir, 'webui/main.js'), 'utf-8');
    expect(script).not.toMatch(CJK);
    expect([...script.matchAll(/frame\.t\('(\w+)'\)/g)].map(m => m[1]).sort()).toEqual([
      'emptyList',
      'loading',
      'removeLabel',
    ]);
  });

  it('显示名按 HTML 文本写进入口页', async () => {
    const dir = await generated({
      packageName: 'zz-escape',
      displayName: '<b>看板</b> & "计数"',
      sourceLanguage: 'zh-CN',
      features: { tool: false, command: false, webui: 'frame', sessionSetting: false },
    });
    expect(readFileSync(join(dir, 'webui/index.html'), 'utf-8')).toContain(
      '<title>&lt;b&gt;看板&lt;/b&gt; &amp; &quot;计数&quot;</title>',
    );
  });

  it('每种勾选组合：README 列出的 uses 键 == index 的 uses 键', () => {
    for (const features of COMBOS) {
      const a = answers(features);
      expect(usesKeys(renderReadme(a)), JSON.stringify(features)).toEqual(usesKeys(renderIndexTs(a)));
    }
  });

  it('README 不再列出未勾选的能力，optional(tools) 等措辞与 index 一致；没选自带前端时没有「插件前端」一节', () => {
    const none = renderReadme(answers({ tool: false, command: false, webui: false, sessionSetting: false }));
    expect(none).not.toContain('optional(tools)');
    expect(none).not.toContain('optional(commands)');
    expect(none).not.toContain('optional(webuiServer)');
    expect(none).not.toContain('@aalis/api-tools');
    expect(none).not.toContain('@aalis/api-commands');
    expect(none).not.toContain('@aalis/api-webui');
    expect(none).not.toContain('配置原样透传给 apply');
    expect(
      renderReadme(answers({ tool: false, command: false, webui: 'declarative', sessionSetting: false })),
    ).not.toContain('插件前端');

    const toolOnly = renderReadme(answers({ tool: true, command: false, webui: false, sessionSetting: false }));
    expect(toolOnly).toContain('uses: { tools: optional(tools) }');
    expect(toolOnly).toContain('\n- 注册 AI 工具（');
    expect(toolOnly).not.toContain('optional(commands)');
    expect(toolOnly).not.toContain('optional(webuiServer)');

    const indexTool = renderIndexTs(answers({ tool: true, command: false, webui: false, sessionSetting: false }));
    expect(indexTool).toContain('tools: optional(tools)');
  });
});
