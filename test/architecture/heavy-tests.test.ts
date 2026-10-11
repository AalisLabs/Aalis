import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HEAVY_TESTS } from '../heavy-tests.js';

// ════════════════════════════════════════════════════════════
// 推送前的快测试不跑重测试，所以起浏览器的测试必须登记在重测试名单里：直接导入 puppeteer
// 或用 e2e 夹具的文件漏登记，就会混进推送前的检查，在负载下拖慢、超时。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BROWSER = /from 'puppeteer(-core)?'|import\('puppeteer|fixtures\/webui-e2e(\.js)?'/;

describe('重测试名单', () => {
  it('直接导入 puppeteer 或用 e2e 夹具的测试文件都在名单里', () => {
    const tests = globSync(['test/**/*.test.ts', 'test/**/*.test.tsx'], { cwd: ROOT });
    const heavy = new Set(globSync(HEAVY_TESTS, { cwd: ROOT }));
    const browser = tests.filter(file => BROWSER.test(readFileSync(join(ROOT, file), 'utf-8')));
    expect(browser.length, '应扫到起浏览器的测试').toBeGreaterThan(0);
    expect(browser.filter(file => !heavy.has(file))).toEqual([]);
  });
});
