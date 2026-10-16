import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { defineTexts, fingerprint, type LanguagePack, resolveText } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// plugin-i18n 的「翻译」页：按 ns 与语言列出齐全度、缺几条、过时、冲突与坏条目，选中一行给出两种待译骨架。
// 夹具字典的英文缺一条、坏一条，同一 ns 再登记一次造出一条英文译文冲突（b）；两个日语语言包一个给了过时的一条，
// 两包在同一条（a）上给的不一样。另一份只有一条的字典，两包给的一条相符、一条过时：过时的不算冲突。
// 页面登记在测试台（webui-server 的真实登记表）上，文字对象原样留着
// ════════════════════════════════════════════════════════════

const NS = 'test/translation-page';
const SOURCE = { a: '甲', b: '乙 {n, number}', c: '丙', d: '丁' } as const;
defineTexts({
  ns: NS,
  language: 'zh-CN',
  source: SOURCE,
  locales: { en: { a: 'A', b: 'B {n, number}', c: 'C {oops' } },
});
defineTexts({ ns: NS, language: 'zh-CN', source: SOURCE, locales: { en: { b: 'BB {n, number}' } } });
const STALE_NS = 'test/translation-page-stale';
defineTexts({ ns: STALE_NS, language: 'zh-CN', source: { a: '甲' } });

const packPlugin = (name: string, pack: LanguagePack) =>
  definePlugin({
    name,
    uses: { contributions },
    apply({ contributions }) {
      contributions.use.contribute('i18n:pack', pack);
    },
  });

const apps: App[] = [];
const hosts: PageHost[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const host of hosts.splice(0)) host.dispose();
});

async function boot(): Promise<PageHost> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const host = pageHost();
  hosts.push(host);
  await registerHubs(app);
  app.bind({ provide }).provide.use(webuiServer, host.service);
  await app.pluginAll([
    {
      definition: packPlugin('@zz/pack-1', {
        id: 'ja-1',
        language: 'ja',
        entries: {
          [NS]: { a: { text: 'ア', from: fingerprint('甲') }, b: { text: 'イ', from: 'deadbeef' } },
          [STALE_NS]: { a: { text: 'ア', from: fingerprint('甲') } },
        },
      }),
    },
    {
      definition: packPlugin('@zz/pack-2', {
        id: 'ja-2',
        language: 'ja',
        entries: {
          [NS]: { a: { text: 'あ', from: fingerprint('甲') } },
          [STALE_NS]: { a: { text: '古い', from: 'deadbeef' } },
        },
      }),
    },
    { definition: i18nPlugin },
  ]);
  await app.plugins.idle();
  return host;
}

/** 代码块里的原文 */
const codeOf = (markdown: unknown) => String(markdown).split('\n').slice(1, -1).join('\n');

describe('翻译页', () => {
  it('按 ns 与语言列出齐全度、缺、过时、冲突与坏条目', async () => {
    const host = await boot();
    const rows = await host.data<Array<Record<string, unknown>>>('translation', 'dictionaries');
    expect(rows.filter(row => row.ns === NS).map(({ id: _id, ...row }) => row)).toEqual([
      { ns: NS, language: 'en', translated: '3/4', missing: 1, stale: 0, conflicts: 1, broken: 1 },
      { ns: NS, language: 'ja', translated: '1/4', missing: 3, stale: 1, conflicts: 1, broken: 0 },
    ]);
  });

  it('冲突只比指纹相符的译文：一包相符、一包过时时不算冲突，过时的那条解析时用不上', async () => {
    const host = await boot();
    const rows = await host.data<Array<Record<string, unknown>>>('translation', 'dictionaries');
    expect(rows.filter(row => row.ns === STALE_NS && row.language === 'ja').map(({ id: _id, ...row }) => row)).toEqual([
      { ns: STALE_NS, language: 'ja', translated: '1/1', missing: 0, stale: 0, conflicts: 0, broken: 0 },
    ]);
  });

  it('选中一行：问题逐类列出键，待译骨架分本插件的 locales 文件与语言包的 entries', async () => {
    const host = await boot();
    const rows = await host.data<Array<{ id: string; ns: string; language: string }>>('translation', 'dictionaries');
    const rowKey = (language: string) => rows.find(row => row.ns === NS && row.language === language)?.id;
    const detail = (id: string, language: string) => host.data('translation', id, { rowKey: rowKey(language) });

    expect(resolveText((await detail('issues', 'en')) as never, ['en'])).toBe('Missing: d\nConflicts: b\nBroken: c');
    expect(resolveText((await detail('issues', 'ja')) as never, ['zh-CN'])).toBe('缺：b、c和d\n过时：b\n冲突：a');
    expect(codeOf(await detail('locale', 'en'))).toBe(
      [
        "import { defineLocale } from '@aalis/schema-i18n';",
        "import type { Source } from '../texts.js';",
        '',
        'export default defineLocale<Source>()({',
        '  "a": "A",',
        '  "b": "B {n, number}",',
        '  "c": "C {oops",',
        '  "d": "丁",',
        '});',
      ].join('\n'),
    );
    const from = (text: string) => ({ text, from: fingerprint(text) });
    expect(JSON.parse(codeOf(await detail('pack', 'ja')))).toEqual({
      [NS]: { a: { text: 'ア', from: fingerprint('甲') }, b: from('乙 {n, number}'), c: from('丙'), d: from('丁') },
    });
  });
});
