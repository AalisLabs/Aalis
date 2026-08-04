import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// ════════════════════════════════════════════════════════════
// test/ 自身的类型检查
//
// 为什么需要：根 tsconfig 的 include 只有 ["src"]，98 个包的 tsconfig 同样只 include 自己的
// src，而 vitest 走 esbuild —— 只擦类型不检查。于是 `test/` 从来没被任何一道门检查过类型。
// 实测后果不是「不够严谨」而是真实的零覆盖：
//   - test/fixtures/mock-llm.ts 曾 `implements LLMService`（该接口早已不存在），implements
//     子句因此等于零约束，mock 缺 contextLength，唯一的 agent 端到端测试整条跑在 NaN 预算上
//   - user-relation 级联删除用例传错字段名（personId vs fromPersonId），两个端点都是
//     undefined，断言又查不存在的字段——把级联逻辑整个删掉，全量测试仍全绿
//
// 为什么写成测试而不是 scripts/ 下的脚本：`scripts/` 在 .gitignore 里（那是本地临时脚本
// 目录），放进去的闸**永远不会入库**，而 package.json 却会引用它——新克隆的人执行即
// MODULE_NOT_FOUND。写成测试则天然入库，且跟着 `pnpm test` 走进 CI 与 pre-push，
// 不需要再单独接线。仓内已有先例：install-chain 测试同样 spawn 真实 npm。
//
// 为什么只对 test/ 的诊断失败：`include: ["test"]` 只列举测试文件，但测试 import 的包源码
// 会被**牵连**进同一个 program，被迫接受这里的 compilerOptions —— 而各包 lib 本就不同
// （plugin-tool-browser 声明 DOM 因为它在 page.evaluate 里用 document；plugin-adapter-onebot
// 不声明，而 DOM 下 `BufferSource` 是另一个类型，Node 的 Buffer 不满足它）。单一配置**天然**
// 满足不了两者。这些包各自的正确性由 `pnpm -r build` 按它们自己的 tsconfig 保证，已有闸。
// 源码在这里只是依赖，不是检查对象——但**过滤不等于不看**，它们仍打印出来。
//
// 曾经的错误做法：为了让这道闸变绿去改生产源码（给 crypto.subtle.digest 的入参加
// `as ArrayBuffer` 断言）。那是迁就测试——源码本来是对的，且那个断言不实
// （实测 `Buffer.from(new SharedArrayBuffer(8)).buffer instanceof SharedArrayBuffer === true`）。
// ════════════════════════════════════════════════════════════

interface Result {
  testSide: string[];
  pkgSide: string[];
  loadedTestFiles: number;
}

function runTsc(): Result {
  const res = spawnSync('tsc', ['-p', 'tsconfig.test.json', '--noEmit', '--pretty', 'false', '--listFiles'], {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`无法执行 tsc: ${res.error.message}`);
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.split('\n');
  const errs = out.filter(l => l.includes('error TS'));
  return {
    testSide: errs.filter(l => l.startsWith('test/')),
    pkgSide: errs.filter(l => !l.startsWith('test/')),
    // 数 **tsc 实际加载进 program** 的测试文件，不是磁盘上有多少个：`include` 写错时磁盘
    // 文件照样在，tsc 却一个都没检查，于是 0 错误、闸全绿。第一版正是数的磁盘，实测拦不住。
    loadedTestFiles: out.filter(l => {
      const p = l.trim();
      return p.startsWith(join(ROOT, 'test')) && /\.tsx?$/.test(p);
    }).length,
  };
}

describe('test/ 的类型检查', () => {
  const r = runTsc();

  it('这道闸没有在空转——tsc 真的加载了测试文件', () => {
    expect(
      r.loadedTestFiles,
      `tsc 只加载了 ${r.loadedTestFiles} 个 test/ 文件，tsconfig.test.json 的 include 可能已失效`,
    ).toBeGreaterThan(50);
  });

  it('test/ 下零类型错误', () => {
    if (r.pkgSide.length > 0) {
      // 不据此失败（见文件头），但要让人看见——源码类型出错时测试侧可能被静默放过。
      console.warn(
        `\n[test-types] ${r.pkgSide.length} 条诊断落在 packages/，由 pnpm -r build 按各包自己的 tsconfig 把关：`,
      );
      for (const l of r.pkgSide) console.warn(`  ${l}`);
    }
    expect(r.testSide, `test/ 下有 ${r.testSide.length} 条类型错误：\n${r.testSide.join('\n')}`).toEqual([]);
  });
});
