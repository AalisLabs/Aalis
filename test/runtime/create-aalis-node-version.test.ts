import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkNodeVersion } from '../../packages/create-aalis/src/cli.js';

// 最低 Node 版本是 24.15.0：从这一版起，默认记忆后端用的 node:sqlite 不再打印实验特性警告。
// 脚手架一开头就检查，不够时写明需要的版本、当前版本与升级方法后退出，不生成任何文件。

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/create-aalis/src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');

describe('checkNodeVersion', () => {
  it.each(['v24.15.0', 'v24.21.0', 'v25.0.0', 'v26.2.1'])('%s 够新', version => {
    expect(checkNodeVersion(version)).toEqual({ ok: true });
  });

  // v24.9.0 按字符串比较会排在 v24.15.0 之后
  it.each(['v24.14.9', 'v24.9.0', 'v22.16.0', 'v18.20.8'])('%s 不够', version => {
    expect(checkNodeVersion(version).ok).toBe(false);
  });

  it('不够时写明需要的版本、当前版本、各平台的升级方法，以及旧 Node 上装好的项目怎样换新版记忆后端、旧库不用迁移', () => {
    const result = checkNodeVersion('v22.16.0');
    if (result.ok) throw new Error('v22.16.0 应当不够');
    expect(result.error).toContain('Aalis 需要 Node.js 24.15.0 起，当前是 v22.16.0');
    for (const part of [
      'macOS / Linux',
      'nvm install 24',
      'nvm alias default 24',
      'Windows',
      'nvm-windows',
      'https://nodejs.org',
      'aalis.db',
      '不用迁移',
      'npm install @aalis/plugin-memory-sqlite@latest',
      'npm update',
      'npm start',
      'npm rebuild',
    ]) {
      expect(result.error).toContain(part);
    }
  });
});

describe('create-aalis 在 Node 不够新时', () => {
  it('一开头退出，退出码非 0，说明原因，不生成项目', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aalis-old-node-'));
    try {
      // 预加载把当前 Node 换成 v24.14.0，同步到 node:process 的具名导出
      const preload = join(dir, 'old-node.mjs');
      await writeFile(
        preload,
        "import { syncBuiltinESMExports } from 'node:module';\n" +
          "Object.defineProperty(process, 'version', { value: 'v24.14.0' });\n" +
          'syncBuiltinESMExports();\n',
      );
      const failure = await run(
        process.execPath,
        // 没有这道检查时会往下生成项目：registry 指向本机不监听的端口，查版本立即失败、不出网
        [
          '--import',
          preload,
          '--import',
          tsx,
          cli,
          'my-bot',
          '--yes',
          '--no-install',
          '--registry',
          'http://127.0.0.1:9',
        ],
        { cwd: dir, timeout: 10_000 },
      ).then(
        () => undefined,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain('Aalis 需要 Node.js 24.15.0 起，当前是 v24.14.0');
      expect(existsSync(join(dir, 'my-bot'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('最低 Node 版本的声明', () => {
  it.each([
    'package.json',
    'packages/runtime/package.json',
    'packages/create-aalis/package.json',
    'packages/plugin-memory-sqlite/package.json',
  ])('%s 的 engines 写 Node 24.15.0 起', path => {
    const manifest = JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf-8'));
    expect(manifest.engines).toEqual({ node: '>=24.15.0' });
  });
});
