import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, sourceFiles } from '../helpers/package-program.js';

// ════════════════════════════════════════════════════════════
// 契约包不点名第一方插件：packages/api-*、packages/schema-* 的源码里不出现第一方插件的包名（plugin-xxx，带不带
// @aalis/ 都算）。契约按角色写（提供者、消费方、适配器），第三方的实现同样适用；要举例就用占位的名字。
// 给使用者看、必须写明装哪个包的文字登记在 ALLOWED 里并写明理由，一条登记只放行一处。
// 去掉 plugin- 前缀的简称不在扫描面：它们与服务名、契约名、平台名分不开，写的时候同样按角色写，靠评审把关。
// ════════════════════════════════════════════════════════════

/** 第一方插件的包名（目录名） */
const plugins = readdirSync(join(ROOT, 'packages')).filter(dir => dir.startsWith('plugin-'));
const NAMED = new RegExp(`(?<![\\w-])(?:@aalis/)?(?:${plugins.join('|')})(?![\\w-])`, 'g');

/** [文件, 点到的包名, 为什么留着]，每条放行一处 */
const ALLOWED: Array<[string, string, string]> = [
  [
    'packages/api-session-settings/src/texts.ts',
    '@aalis/plugin-session-settings',
    '给使用者看的排障文字：会话设置不在时写明要装的包',
  ],
  ['packages/api-session-settings/src/locales/en.ts', '@aalis/plugin-session-settings', '上一条的英文'],
];

describe('契约包不点名第一方插件', () => {
  it('api-*、schema-* 的源码里没有第一方插件的包名；登记留着的各处都还在，一处不多', () => {
    const files = sourceFiles()
      .map(file => relative(ROOT, file).replace(/\\/g, '/'))
      .filter(file => /^packages\/(?:api|schema)-/.test(file));
    const hits: string[] = [];
    const kept: string[] = [];
    for (const file of files) {
      readFileSync(join(ROOT, file), 'utf-8')
        .split('\n')
        .forEach((line, index) => {
          for (const [name] of line.matchAll(NAMED)) {
            if (ALLOWED.some(([allowedFile, allowedName]) => allowedFile === file && allowedName === name)) {
              kept.push(`${file} ${name}`);
            } else {
              hits.push(`${file}:${index + 1} ${name}`);
            }
          }
        });
    }
    expect(plugins.length, '没有扫到第一方插件').toBeGreaterThan(50);
    expect(files.length, '没有扫到契约包源码').toBeGreaterThan(80);
    expect(hits).toEqual([]);
    expect(kept.sort()).toEqual(ALLOWED.map(([file, name]) => `${file} ${name}`).sort());
  });
});
