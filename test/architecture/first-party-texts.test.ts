import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogEntries, checkTexts } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// 第一方字典自检：每个包的原文字典（src/texts.ts，ns 为包名）导入即登记进目录，逐个过 checkTexts，问题列表为空。
// 新建的字典自动受检。
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');
const dirs = readdirSync(join(ROOT, 'packages')).filter(dir => existsSync(join(ROOT, 'packages', dir, 'src/texts.ts')));
/** 有字典的包名 */
const owners = dirs.map(dir => JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf-8')).name);
for (const dir of dirs) await import(pathToFileURL(join(ROOT, 'packages', dir, 'src/texts.ts')).href);

describe('第一方字典', () => {
  it('每个包的 src/texts.ts 以包名登记进目录，checkTexts 都为空', () => {
    const entries = catalogEntries().filter(entry => owners.includes(entry.ns));
    expect(entries.map(entry => entry.ns).sort()).toEqual([...owners].sort());
    expect(entries.flatMap(entry => checkTexts(entry).map(issue => ({ ns: entry.ns, ...issue })))).toEqual([]);
  });
});
