import { describe, expect, it } from 'vitest';
import { compileGlob, matchGlob, matchGlobPath } from '../../packages/plugin-tool-system/src/tools/file.js';

// ════════════════════════════════════════════════════════════
// file_tree 的 pattern 匹配
//
// 这个函数曾被一次「DRY」改坏并零覆盖地发布出去：转义步骤改成复用 `escapeRegExp`，
// 而那份的字符类含 `*?`，于是 `*.ts` 先被转义成 `\*\.ts`，随后的 `.replace(/\*/g,'.*')`
// 又把转义序列里的 `*` 换掉，最终编成 `^\.*\.ts$` —— 匹配不到任何文件。
//
// 症状极隐蔽：无通配符的 pattern（如 `index.ts`）碰巧仍正常；目录分支在 pattern 之前
// 就 return true，所以 LLM 拿到的是「完整目录骨架 + 零个文件」，不报错，
// 据此得出「这个目录没有 .ts 文件」的自信错答案。
// ════════════════════════════════════════════════════════════

describe('matchGlob', () => {
  it('`*` 通配（这条正是那次回归打穿的）', () => {
    expect(matchGlob('foo.ts', '*.ts')).toBe(true);
    expect(matchGlob('foo.js', '*.ts')).toBe(false);
    expect(matchGlob('scheduler-resolve.ts', '*scheduler*')).toBe(true);
  });

  it('`?` 单字符通配', () => {
    expect(matchGlob('a.ts', '?.ts')).toBe(true);
    expect(matchGlob('ab.ts', '?.ts')).toBe(false);
  });

  it('无通配符时按字面匹配（回归前这条也是过的，故不能只靠它）', () => {
    expect(matchGlob('index.ts', 'index.ts')).toBe(true);
    expect(matchGlob('index.tsx', 'index.ts')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(matchGlob('README.md', '*.MD')).toBe(true);
  });

  it('病态 pattern 不触发灾难性回溯（曾用正则实现，27 字符 pattern 卡 13 秒）', () => {
    // `*?*?*?…*zz` 与文件名内容无关（`?` 匹配任意字符）。正则实现是指数级回溯，
    // 而 V8 正则同步执行 —— 事件循环被整段阻塞，进程内任何超时都打不断。
    // file_tree 对目录里每个 entry 各调一次，代价再乘条数。
    const evil = '*?'.repeat(16) + '*zz';
    const t = Date.now();
    expect(matchGlob('authority-tools-guard-e2e.test.ts', evil)).toBe(false);
    expect(Date.now() - t, `病态 pattern 耗时 ${Date.now() - t}ms —— 回溯面又被打开了`).toBeLessThan(100);
  });

  it('正则元字符按字面处理，不当成语法', () => {
    expect(matchGlob('a+b.ts', 'a+b.ts')).toBe(true);
    expect(matchGlob('aab.ts', 'a+b.ts')).toBe(false);
    expect(matchGlob('v1.2.3.log', 'v1.2.3.log')).toBe(true);
    expect(matchGlob('v1x2y3.log', 'v1.2.3.log')).toBe(false);
  });

  // 对拍：朴素递归参考实现 vs 生产实现。
  //
  // 加它是因为手写的 5 条用例**没抓住一个真 bug**：双指针版最初把 `p[pi] === s[si]` 判在
  // `p[pi] === '*'` 之前，于是文件名里含 `*` 时（两者恰好相等）通配符被当字面量消耗、
  // 回溯点不记，后续失配无处可退。随机对拍 4 万组时这条错了 418 组，手写用例一条没覆盖到
  // ——因为没人会想到「文件名里有星号」。凡是自己手写的匹配/解析算法都该配一个参考对拍。
  it('与朴素递归参考实现逐组一致（穷举短串 + 4 万组随机）', () => {
    const ref = (str: string, pat: string, si = 0, pi = 0): boolean => {
      if (pi === pat.length) return si === str.length;
      if (pat[pi] === '*') {
        for (let k = si; k <= str.length; k++) if (ref(str, pat, k, pi + 1)) return true;
        return false;
      }
      if (si === str.length) return false;
      if (pat[pi] === '?' || pat[pi].toLowerCase() === str[si].toLowerCase()) return ref(str, pat, si + 1, pi + 1);
      return false;
    };
    const bad: string[] = [];
    const check = (str: string, pat: string) => {
      if (matchGlob(str, pat) !== ref(str, pat)) bad.push(`name=${JSON.stringify(str)} pat=${JSON.stringify(pat)}`);
    };
    // 穷举：**故意包含含通配符的文件名**，那正是漏掉的那类
    for (const str of ['', 'a', 'ab', 'a.b', 'aab', 'ABC', '*a', 'a?b', '**'])
      for (const pat of ['', '*', '?', '**', '*a', 'a*', '*a*', '?a', 'a?', '*?', '?*', 'a', '*.*', 'a*b', '**a**'])
        check(str, pat);
    // 随机
    const alpha = 'ab.*?';
    const rnd = (n: number) =>
      Array.from({ length: n }, () => alpha[Math.floor(Math.random() * alpha.length)]).join('');
    for (let i = 0; i < 40000; i++) check(rnd(Math.floor(Math.random() * 7)), rnd(Math.floor(Math.random() * 6)));
    expect(bad.slice(0, 5), `与参考实现不一致 ${bad.length} 组`).toEqual([]);
  });
});

describe('matchGlobPath（exclude / include 的路径级匹配）', () => {
  const hit = (path: string, pattern: string) => matchGlobPath(path, compileGlob(pattern));

  it('`**` 跨任意多段（含零段）', () => {
    expect(hit('node_modules/x', '**/node_modules/**')).toBe(true);
    expect(hit('a/b/node_modules/x', '**/node_modules/**')).toBe(true);
    // 尾部 `**` 含零段，故目录本身也命中（与既有正则实现同语义）
    expect(hit('a/node_modules', '**/node_modules/**')).toBe(true);
    expect(hit('a/node_modulesx', '**/node_modules/**')).toBe(false);
  });

  it('`*` 与 `?` 不跨段', () => {
    expect(hit('src/a.ts', 'src/*.ts')).toBe(true);
    expect(hit('src/deep/a.ts', 'src/*.ts')).toBe(false);
    expect(hit('abc/d.js', 'a?c/*.js')).toBe(true);
  });

  it('病态 pattern 不触发灾难性回溯', () => {
    const evil = '*?'.repeat(16) + '*zz';
    const t = Date.now();
    expect(hit('a'.repeat(40), evil)).toBe(false);
    expect(Date.now() - t, `耗时 ${Date.now() - t}ms —— 回溯面被打开了`).toBeLessThan(100);
  });
});
