import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 触及凭据只由触及插件构造：凭据的品牌符号（REACH_CREDENTIAL，登记在全局符号表里的 '@aalis/api-reach/credential'）
// 只在契约包与触及插件里出现。别的包拿到品牌符号就能拼出一个看起来合法的凭据，越过存储网关与沙箱的核验；
// 消费方认凭据一律用 isReachCredential。
//
// 扫描面是 packages/*/src，测试不在其列。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 准许出现品牌符号的包 */
const ALLOWED = new Set(['api-reach', 'plugin-reach']);

/** 品牌符号的标识与它在全局符号表里的键 */
const BRAND = /\bREACH_CREDENTIAL\b|@aalis\/api-reach\/credential/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('触及凭据的品牌符号', () => {
  it('只在契约包与触及插件里出现', () => {
    const found = new Set<string>();
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      if (!existsSync(src)) continue;
      for (const file of sourceFiles(src)) {
        if (BRAND.test(readFileSync(file, 'utf8'))) found.add(relative(ROOT, file));
      }
    }
    const packageOf = (file: string) => file.split('/')[1] ?? '';
    expect([...found].filter(file => !ALLOWED.has(packageOf(file)))).toEqual([]);
    // 守卫没扫空：两个准许的包确实用到它
    expect(new Set([...found].map(packageOf))).toEqual(ALLOWED);
  });

  it('标识与全局符号表里的键都认', () => {
    expect(BRAND.test("import { REACH_CREDENTIAL } from '@aalis/api-reach';")).toBe(true);
    expect(BRAND.test("const brand = Symbol.for('@aalis/api-reach/credential');")).toBe(true);
    expect(BRAND.test('const NOT_REACH_CREDENTIALS = 1;')).toBe(false);
  });
});
