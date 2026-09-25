import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * 按 tsconfig.test.json 编译一段源码，返回其中的 `error TS` 行。
 * 负向类型用例不能放进 test/（test-types 绊线要求零错），故写到临时目录再 spawn tsc。
 */
export function runTscProbe(source: string): string[] {
  // 夹具必须在仓内：tsconfig.test.json 的 rootDir 是仓根，path-mapped 进来的 core 源码要在其下，
  // 否则 tsc 报 TS6059。node_modules 下：gitignored、biome 不扫、不在任何 include 里。
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.aalis-type-probe-'));
  try {
    writeFileSync(join(dir, 'fixture.ts'), source);
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
