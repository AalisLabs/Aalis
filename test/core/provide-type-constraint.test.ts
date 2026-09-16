import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// provide 曾接受 unknown：声明 increment(): number、注册返回 string 的实现，编译照过，
// 运行时拿到 string——消费侧类型正确不代表注册的实现正确。
// 单签名条件类型 ServiceOf<K>：已知名收窄到契约类型；未知名与动态字符串仍为 unknown。
// 不能用 string 兜底重载：重载解析会落到宽签名，已知名的错误实现照样通过（已实测）。
// 负向用例不能放进 test/（test-types 绊线要求零错），故写到临时目录、spawn tsc、断言错误落点。
// 夹具自己 declare module 增广 ServiceTypeMap，覆盖「跨包 declaration merging 后仍收窄」。
// ════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../..');

const FIXTURE = `import type { Context } from '@aalis/core';
declare module '@aalis/core' {
  interface ServiceTypeMap {
    probe: { increment(): number };
  }
}
declare const ctx: Context;
declare const dyn: string;
ctx.provide('probe', { increment: (): number => 1 });
ctx.provide('probe', { increment: (): string => 'x' }); // BAD
ctx.provide('unknown-svc', { anything: true });
ctx.provide(dyn, { anything: true });
`;
const BAD_LINE = FIXTURE.split('\n').findIndex(l => l.includes('// BAD')) + 1;

function runTsc(): string[] {
  // 夹具必须在仓内：tsconfig.test.json 的 rootDir 是仓根，path-mapped 进来的 core 源码要在其下，
  // 否则 tsc 报 TS6059。node_modules 下：gitignored、biome 不扫、不在任何 include 里。
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.aalis-type-probe-'));
  try {
    writeFileSync(join(dir, 'fixture.ts'), FIXTURE);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(ROOT, 'tsconfig.test.json'),
        compilerOptions: { noEmit: true },
        include: [join(dir, 'fixture.ts')],
      }),
    );
    const res = spawnSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      ['-p', join(dir, 'tsconfig.json'), '--pretty', 'false'],
      {
        cwd: ROOT,
        encoding: 'utf-8',
      },
    );
    if (res.error) throw res.error;
    return `${res.stdout ?? ''}${res.stderr ?? ''}`.split('\n').filter(l => l.includes('error TS'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('provide 生产者类型约束', () => {
  const errs = runTsc();
  const atBad = errs.filter(e => e.includes(`fixture.ts(${BAD_LINE},`));
  const elsewhere = errs.filter(e => !e.includes(`fixture.ts(${BAD_LINE},`));

  it('已知服务名 + 错误实现 → 编译失败', () => {
    // TS 把错误定位在箭头函数的返回类型上（TS2322 string 不可赋给 number），不是实参整体（TS2345）；
    // 两者都说明约束生效——只认 BAD 行有类型错误、且错误提到 string/number 这对不匹配。
    expect(atBad.length, `第 ${BAD_LINE} 行应有类型错误，实际：${errs.join('\n') || '（零错误）'}`).toBeGreaterThan(0);
    expect(atBad.some(e => /string/.test(e) && /number/.test(e))).toBe(true);
  });

  it('正确实现、未知名、动态字符串 → 零错误', () => {
    expect(elsewhere, '这些调用必须放行，否则约束误伤合法用法').toEqual([]);
  });
});
