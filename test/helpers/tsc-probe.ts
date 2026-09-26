import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

/** 探针的编译配置：缺省按 tsconfig.test.json 只编译夹具 */
interface TscProbeConfig {
  /** 继承的 tsconfig（绝对路径） */
  extends?: string;
  /** 覆写的编译选项；rootDir 固定为仓根、noEmit 固定为 true */
  compilerOptions?: Record<string, unknown>;
  /** 与夹具一同编译的文件或目录（绝对路径） */
  include?: string[];
}

/**
 * 编译一段源码，返回其中的 `error TS` 行（仓内文件按相对仓根的路径给出位置）。
 * 负向类型用例不能放进 test/（test-types 绊线要求零错），故写到临时目录再 spawn tsc。
 */
export function runTscProbe(source: string, config: TscProbeConfig = {}): string[] {
  // 夹具必须在仓内：rootDir 固定为仓根，夹具与 path-mapped 或 include 进来的 core 源码都要在其下，
  // 否则 tsc 报 TS6059。node_modules 下：gitignored、biome 不扫、不在任何 include 里。
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.aalis-type-probe-'));
  try {
    writeFileSync(join(dir, 'fixture.ts'), source);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: config.extends ?? join(ROOT, 'tsconfig.test.json'),
        compilerOptions: { ...config.compilerOptions, rootDir: ROOT, noEmit: true },
        include: [join(dir, 'fixture.ts'), ...(config.include ?? [])],
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
